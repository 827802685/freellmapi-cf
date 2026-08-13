/**
 * /v1/completions - 老式 prompt 补全(给 Continue.dev 等用)
 * 翻译成 chat 格式,直接使用 router 选路(避免内部 fetch 双重开销)
 */

import { Hono } from 'hono';
import type { Env, RouteCandidate, ChatCompletionRequest } from '../../types';
import { requireUserToken } from '../../lib/auth';
import type { UserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession, consumeQuota, precheckCandidates } from '../../lib/router';
import type { RouteMode } from '../../lib/router';
import { getProvider } from '../../providers';
import { normalizeSseStream } from '../../lib/stream';
import { err } from '../../lib/response';

export const completionsRoute = new Hono<{ Bindings: Env }>();

interface LegacyCompletionRequest {
  model: string;
  prompt: string | string[];
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  logprobs?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  user?: string;
}

completionsRoute.post('/completions', requireUserToken, async (c) => {
  const start = Date.now();
  const body = await c.req.json<LegacyCompletionRequest>();

  // 翻译:把 prompt+suffix 变成单条 user 消息
  const promptText = Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt;
  const fullPrompt = body.suffix ? promptText + body.suffix : promptText;

  // 选路(直接使用 router,不再内部 fetch /v1/chat/completions)
  const userToken = c.get('userToken') as UserToken;
  const sessionId = c.req.header('X-Session-Id') || null;
  const routeMode = (c.req.header('X-Route-Mode') || 'auto') as RouteMode;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: body.model,
    routeMode,
  });

  if (route.candidates.length === 0) {
    return err(c, 'No route available', 503, 'no_route');
  }

  // 并行预检所有候选(一次 DO round-trip,替代串行 checkCandidate)
  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return err(c, 'All candidates are in cooldown or rate-limited.', 503, 'all_cooldown');
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);
    const upstreamReq = provider.transformRequest(
      {
        model: cand.model,
        messages: [{ role: 'user' as const, content: fullPrompt }],
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        top_p: body.top_p,
        stop: body.stop,
        stream: body.stream || false,
        presence_penalty: body.presence_penalty,
        frequency_penalty: body.frequency_penalty,
        seed: body.seed,
        user: body.user,
      } satisfies ChatCompletionRequest,
      cand.keyPlaintext,
      cand.model
    );

    try {
      const res = await fetch(upstreamReq.url, {
        method: upstreamReq.method,
        headers: upstreamReq.headers,
        body: upstreamReq.body,
      });

      const retryAfterHeader = res.headers.get('retry-after');
      let retryAfterSec: number | undefined;
      if (retryAfterHeader) {
        const asNum = parseInt(retryAfterHeader, 10);
        if (!isNaN(asNum)) retryAfterSec = asNum;
      }

      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status, cand.platform, undefined, retryAfterSec, cand.model));

      if (res.ok) {
        const latencyMs = Date.now() - start;
        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };

        if (body.stream) {
          const streamStart = start;
          const stream = normalizeSseStream(
            res.body!,
            cand.platform,
            cand.model,
            () => `cmpl-${Date.now()}`,
            (usage) => {
              const promptTokens = usage?.prompt_tokens || 0;
              const completionTokens = usage?.completion_tokens || 0;
              c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
              c.executionCtx.waitUntil(
                logRequest(c.env, userToken.id, cand, res.status, Date.now() - streamStart, true, i, usage)
              );
            }
          );

          // 把 OpenAI chat SSE 转换为 completions SSE
          const completionStream = new ReadableStream({
            async start(controller) {
              const reader = stream.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              const id = `cmpl-${Date.now()}`;

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });

                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';

                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      try {
                        const data = JSON.parse(line.slice(6));
                        const delta = data.choices?.[0]?.delta;
                        if (delta?.content) {
                          controller.enqueue(new TextEncoder().encode(
                            `data: ${JSON.stringify({
                              id,
                              object: 'text_completion',
                              created: Math.floor(Date.now() / 1000),
                              model: body.model,
                              choices: [{ text: delta.content, index: 0, logprobs: null, finish_reason: null }],
                            })}\n\n`
                          ));
                        }
                        if (data.choices?.[0]?.finish_reason) {
                          controller.enqueue(new TextEncoder().encode(
                            `data: ${JSON.stringify({
                              id,
                              object: 'text_completion',
                              created: Math.floor(Date.now() / 1000),
                              model: body.model,
                              choices: [{ text: '', index: 0, logprobs: null, finish_reason: data.choices[0].finish_reason }],
                              usage: data.usage,
                            })}\n\n`
                          ));
                          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                        }
                      } catch { /* skip */ }
                    }
                  }
                }
              } catch (e) {
                controller.error(e);
              } finally {
                controller.close();
              }
            },
          });

          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          return new Response(completionStream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Accel-Buffering': 'no',
              ...respHeaders,
            },
          });
        } else {
          const chatResp = await res.json() as { id?: string; created?: number; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          const text = chatResp.choices?.[0]?.message?.content || '';

          const promptTokens = chatResp.usage?.prompt_tokens || 0;
          const completionTokens = chatResp.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i, chatResp.usage)
          );

          return c.json({
            id: chatResp.id || `cmpl-${Date.now()}`,
            object: 'text_completion',
            created: chatResp.created || Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                text,
                index: 0,
                logprobs: null,
                finish_reason: chatResp.choices?.[0]?.finish_reason || 'stop',
              },
            ],
            usage: chatResp.usage,
          }, 200, respHeaders);
        }
      } else {
        const errBody = await res.text();
        lastError = { status: res.status, body: errBody, platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i)
        );
        continue;
      }
    } catch (e: unknown) {
      lastError = { status: 0, message: e instanceof Error ? e.message : String(e), platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(
        logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i)
      );
      continue;
    }
  }

  return err(c, `All routes failed. Last error: ${JSON.stringify(lastError)}`, 502, 'all_routes_failed');
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
  } catch { /* ignore */ }
}
