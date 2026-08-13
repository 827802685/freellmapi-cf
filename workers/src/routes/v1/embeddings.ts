/**
 * /v1/embeddings - 嵌入向量
 */

import { Hono } from 'hono';
import type { Env, RouteCandidate } from '../../types';
import { requireUserToken } from '../../lib/auth';
import type { UserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, consumeQuota, precheckCandidates } from '../../lib/router';
import { getProvider } from '../../providers';
import { err } from '../../lib/response';

export const embeddingsRoute = new Hono<{ Bindings: Env }>();

embeddingsRoute.post('/embeddings', requireUserToken, async (c) => {
  const start = Date.now();
  const body = await c.req.json<{
    model: string;
    input: string | string[];
    encoding_format?: 'float' | 'base64';
    user?: string;
  }>();

  const userToken = c.get('userToken') as UserToken;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId: null,
    prefersModel: body.model,
  });

  if (route.candidates.length === 0) {
    return err(c, 'No available embedding key', 503, 'no_route');
  }

  // 并行预检所有候选(一次 DO round-trip,替代串行 checkCandidate)
  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return err(c, 'All embedding candidates are in cooldown or rate-limited.', 503, 'all_cooldown');
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);

    try {
      // 使用 provider 的 baseUrl 构建请求,用 cand.model 而非 body.model
      const res = await fetch(`${provider.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cand.keyPlaintext}`,
        },
        body: JSON.stringify({ ...body, model: cand.model }),
      });

      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status, cand.platform, undefined, undefined, cand.model));

      if (res.ok) {
        const latencyMs = Date.now() - start;
        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };
        const respBody = await res.json() as { usage?: { prompt_tokens?: number; total_tokens?: number } };
        // 消费配额(embedding 用 token 数)
        const tokens = respBody.usage?.total_tokens || respBody.usage?.prompt_tokens || 100;
        c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, tokens, 0, cand.model));
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, i, respBody.usage)
        );
        return c.json(respBody, 200, respHeaders);
      } else {
        const errBody = await res.text();
        lastError = { status: res.status, body: errBody, platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, i)
        );
        continue;
      }
    } catch (e: unknown) {
      lastError = { status: 0, message: e instanceof Error ? e.message : String(e), platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(
        logRequest(c.env, userToken.id, cand, 0, Date.now() - start, i)
      );
      continue;
    }
  }

  return err(c, `All embedding routes failed. Last error: ${JSON.stringify(lastError)}`, 502, 'all_routes_failed');
});

async function logRequest(
  env: Env,
  userTokenId: number,
  cand: RouteCandidate,
  status: number,
  latencyMs: number,
  fallbackCount: number,
  usage?: { prompt_tokens?: number; total_tokens?: number }
) {
  try {
    await env.DB.prepare(
      `INSERT INTO request_logs
        (user_token_id, model, platform, key_id, status_code, latency_ms, prompt_tokens, completion_tokens, total_tokens, stream, fallback_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, unixepoch())`
    ).bind(
      userTokenId,
      cand.model,
      cand.platform,
      cand.keyId,
      status,
      latencyMs,
      usage?.prompt_tokens || 0,
      usage?.total_tokens || 0,
      fallbackCount
    ).run();
  } catch { /* ignore */ }
}
