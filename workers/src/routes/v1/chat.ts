/**
 * OpenAI 兼容 chat completions 路由
 * 核心代理逻辑 + fallback
 */

import { Hono } from 'hono';
import type { Env, ChatCompletionRequest, RouteCandidate } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession } from '../../lib/router';
import { getProvider } from '../../providers';
import { normalizeSseStream } from '../../lib/stream';
import { err } from '../../lib/response';

export const chatRoute = new Hono<{ Bindings: Env }>();

chatRoute.post('/chat/completions', requireUserToken, async (c) => {
  const start = Date.now();
  const req = await c.req.json<ChatCompletionRequest>();

  // 1) 选路
  const sessionId = c.req.header('X-Session-Id') || null;
  const routeMode = (c.req.header('X-Route-Mode') || 'auto') as 'auto' | 'fastest' | 'smartest' | 'fusion' | 'manual';
  const userToken = c.get('userToken' as any);
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: req.model,
    routeMode,
  });

  if (route.candidates.length === 0) {
    return err(c, `No route (candidates=0, enabled keys=${(await c.env.DB.prepare('SELECT COUNT(*) as c FROM api_keys WHERE enabled=1').first<{c:number}>())?.c}). Add key or check fallback chain.`, 503, 'no_route');
  }

  // 2) 逐个尝试(fallback 链)
  let lastError: any = null;
  for (const cand of route.candidates) {
    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);
    const upstreamReq = provider.transformRequest(req, cand.keyPlaintext, cand.model);

    try {
      const upstreamRes = await fetch(upstreamReq.url, {
        method: upstreamReq.method,
        headers: upstreamReq.headers,
        body: upstreamReq.body,
      });

      // 记录到 DO
      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, upstreamRes.status));

      if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
        // 成功
        if (req.stream) {
          const idGen = () => `chatcmpl-${Date.now()}`;
          const streamStart = start;
          // 流结束时记录 usage(如果上游提供了的话)
          const stream = normalizeSseStream(
            upstreamRes.body!,
            cand.platform,
            cand.model,
            idGen,
            (usage) => {
              c.executionCtx.waitUntil(
                logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - streamStart, true, 0, usage)
              );
            }
          );
          // 写 sticky session
          c.executionCtx.waitUntil(
            updateStickySession(c.env, sessionId, cand.platform, cand.model)
          );
          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          });
        } else {
          const body = await upstreamRes.json();
          const normalized = provider.parseResponse(body, cand.model);
          c.executionCtx.waitUntil(
            updateStickySession(c.env, sessionId, cand.platform, cand.model)
          );
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, 0, normalized.usage)
          );
          return c.json(normalized);
        }
      } else {
        // 上游错误,记录日志后继续下一个候选
        const errBody = await upstreamRes.text();
        lastError = { status: upstreamRes.status, body: errBody, platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, 0)
        );
        continue;
      }
    } catch (e: any) {
      lastError = { status: 0, message: e.message, platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(
        logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, 0)
      );
      continue;
    }
  }

  // 全部失败
  return err(
    c,
    `All routes failed. Last error: ${JSON.stringify(lastError)}`,
    502,
    'all_routes_failed'
  );
});

async function logRequest(
  env: Env,
  userTokenId: number,
  cand: RouteCandidate,
  status: number,
  latencyMs: number,
  stream: boolean,
  fallbackCount: number,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
) {
  try {
    await env.DB.prepare(
      `INSERT INTO request_logs
        (user_token_id, model, platform, key_id, status_code, latency_ms, prompt_tokens, completion_tokens, total_tokens, stream, fallback_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    ).bind(
      userTokenId,
      cand.model,
      cand.platform,
      cand.keyId,
      status,
      latencyMs,
      usage?.prompt_tokens || 0,
      usage?.completion_tokens || 0,
      usage?.total_tokens || 0,
      stream ? 1 : 0,
      fallbackCount
    ).run();
  } catch {
    // log 失败不影响主流程
  }
}
