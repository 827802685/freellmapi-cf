/**
 * OpenAI 兼容 chat completions 路由
 * 核心代理逻辑 + fallback
 *
 * v3 稳定性增强(TRAE IDE 等大型 IDE 接入优化):
 * 1. 流式首 chunk 探测:peekFirstChunk 验证流有效性,空流/超时自动 fallback(客户端无感知)
 * 2. fetch 超时控制:30s 内未收到响应头自动 abort,触发 fallback
 * 3. 200+error body 检测:上游返回 200 但 body 是错误对象时自动 fallback
 * 4. 流中途异常记录:onError 回调记录 mid-stream 失败,影响下次路由决策
 * 5. 非流式空内容检测(保留 v2)
 * 6. AIHorde 异步任务模式特殊处理(保留 v2)
 */

import { Hono } from 'hono';
import type { Env, ChatCompletionRequest, RouteCandidate } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession, consumeQuota, precheckCandidates, requestHasImage } from '../../lib/router';
import { getProvider } from '../../providers';
import { AihordeProvider } from '../../providers/aihorde';
import { normalizeSseStream, peekFirstChunk } from '../../lib/stream';
import { err } from '../../lib/response';
import { rescueToolCalls } from '../../lib/tool-call-rescue';
import { buildCacheKey, getCachedResponse, setCachedResponse, shouldSkipCache, getCustomTtl } from '../../lib/response-cache';
import { compressRequest, getCompressionMode } from '../../lib/prompt-compression';

export const chatRoute = new Hono<{ Bindings: Env }>();

chatRoute.post('/chat/completions', requireUserToken, async (c) => {
  const start = Date.now();
  const rawReq = await c.req.json<ChatCompletionRequest>();

  // TRAE IDE / OpenAI SDK 兼容:规范化请求字段
  // 1. max_completion_tokens (GPT-5/o1/o3 系列) → max_tokens (大多数上游兼容)
  // 2. 提取 stream_options.include_usage 用于流式 usage 回传
  // 3. 移除 stream_options (OpenAI 客户端特性,不应透传给上游)
  // 4. max_tokens 兜底:客户端未设时给 8192,避免上游默认值过低导致输出被截断
  const includeUsage = rawReq.stream_options?.include_usage === true;
  const req: ChatCompletionRequest = { ...rawReq };
  if (req.max_completion_tokens && !req.max_tokens) {
    req.max_tokens = req.max_completion_tokens;
  }
  if (!req.max_tokens || req.max_tokens < 1) {
    req.max_tokens = 8192;
  }
  delete req.max_completion_tokens;
  delete req.stream_options;

  // 1a) 提示压缩(可选,通过 X-Compression 请求头控制)
  const compressionMode = getCompressionMode(c.req.raw.headers);
  const finalReq = compressionMode ? compressRequest(req, compressionMode) : req;

  // 1b) 缓存读取(仅非流式)
  const cacheKey = finalReq.stream ? null : await buildCacheKey(finalReq);
  if (cacheKey && !shouldSkipCache(c.req.raw.headers)) {
    const cached = await getCachedResponse(c.env.CONFIG, cacheKey);
    if (cached) {
      // 缓存命中,直接返回
      try {
        const parsed = JSON.parse(cached.body);
        const latencyMs = Date.now() - start;
        return c.json(parsed, 200, {
          'X-Platform': 'cache',
          'X-Model': finalReq.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': '0',
          'X-Cache': 'HIT',
          'Cache-Control': `public, max-age=${cached.ttl}`,
        });
      } catch { /* 缓存损坏,忽略并继续 */ }
    }
  }

  // 1c) 选路
  const sessionId = c.req.header('X-Session-Id') || null;
  const routeMode = (c.req.header('X-Route-Mode') || 'auto') as 'auto' | 'fastest' | 'smartest' | 'fusion' | 'manual';
  const userToken = c.var.userToken;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: finalReq.model,
    routeMode,
    hasImage: requestHasImage(finalReq),
  });

  if (route.candidates.length === 0) {
    return err(c, `No route (candidates=0). Add keys or check fallback chain.`, 503, 'no_route');
  }

  // 2) 并行预检所有候选(一次 DO round-trip,替代串行 checkCandidate)
  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return err(c, `All candidates are in cooldown or rate-limited.`, 503, 'all_cooldown');
  }

  // 3) 逐个尝试(fallback 链) — 候选已通过预检,无需再 checkCandidate
  let lastError: Record<string, unknown> | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);

    // AIHorde 特殊处理:异步任务模式,不支持 SSE 流式
    if (provider instanceof AihordeProvider) {
      try {
        // 强制非流式,使用 executeRequest 完成提交→轮询→返回
        const hordeReq = { ...finalReq, stream: false };
        const result = await provider.executeRequest(hordeReq, cand.keyPlaintext, cand.model);

        c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, result.status, cand.platform, undefined, undefined, cand.model));

        if (result.status >= 200 && result.status < 300) {
          const normalized = provider.parseResponse(result.body, cand.model) as {
            id?: string;
            object?: string;
            created?: number;
            model?: string;
            choices?: Array<{
              index?: number;
              message?: { role?: string; content?: string; reasoning_content?: string };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            error?: { message?: string };
          };
          const content = normalized.choices?.[0]?.message?.content || '';

          // 空内容检测:如果返回空内容,触发 fallback
          if (!content && candidates.length > i + 1) {
            console.warn(`[chat] AIHorde returned empty content, falling back to next candidate`);
            lastError = { status: 200, message: 'Empty content from AIHorde', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(
              logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i)
            );
            continue;
          }

          const latencyMs = Date.now() - start;
          const respHeaders: Record<string, string> = {
            'X-Platform': cand.platform,
            'X-Model': cand.model,
            'X-Latency': String(latencyMs),
            'X-Fallback-Count': String(i),
          };

          const promptTokens = normalized.usage?.prompt_tokens || 0;
          const completionTokens = normalized.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, result.status, latencyMs, false, i, normalized.usage)
          );

          // 如果客户端要求流式,把非流式结果包装成单 chunk SSE
          if (req.stream) {
            const idGen = () => `chatcmpl-${Date.now()}`;
            const sseId = idGen();
            const created = Math.floor(Date.now() / 1000);
            const reasoningContent = normalized.choices?.[0]?.message?.reasoning_content || '';
            const sseStream = new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                // 如果有推理内容,先发送推理 chunk
                if (reasoningContent) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: sseId,
                      object: 'chat.completion.chunk',
                      created,
                      model: cand.model,
                      choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }],
                    })}\n\n`
                  ));
                }
                // 发送内容 chunk
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({
                    id: sseId,
                    object: 'chat.completion.chunk',
                    created,
                    model: cand.model,
                    choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  })}\n\n`
                ));
                // 发送 finish chunk
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({
                    id: sseId,
                    object: 'chat.completion.chunk',
                    created,
                    model: cand.model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: normalized.usage,
                  })}\n\n`
                ));
                // 发送 [DONE]
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
            return new Response(sseStream, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
                ...respHeaders,
              },
            });
          }

          return c.json(normalized, 200, respHeaders);
        } else {
          lastError = { status: result.status, body: result.body, platform: cand.platform, model: cand.model };
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i)
          );
          continue;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = { status: 0, message: msg, platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i)
        );
        continue;
      }
    }

    const upstreamReq = provider.transformRequest(finalReq, cand.keyPlaintext, cand.model);

    try {
      // v3 稳定性:fetch 超时控制 — 30s 内未收到响应头则 abort,触发 fallback
      const fetchController = new AbortController();
      const fetchTimeoutId = setTimeout(() => fetchController.abort(), 30000);
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstreamReq.url, {
          method: upstreamReq.method,
          headers: upstreamReq.headers,
          body: upstreamReq.body,
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(fetchTimeoutId);
      }

      // 记录到 DO(429 时解析 retry-after 头)
      const retryAfterHeader = upstreamRes.headers.get('retry-after');
      let retryAfterSec: number | undefined;
      if (retryAfterHeader) {
        const asNum = parseInt(retryAfterHeader, 10);
        if (!isNaN(asNum)) {
          retryAfterSec = asNum;
        } else {
          const asDate = new Date(retryAfterHeader);
          if (!isNaN(asDate.getTime())) {
            retryAfterSec = Math.max(0, Math.floor((asDate.getTime() - Date.now()) / 1000));
          }
        }
      }
      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, upstreamRes.status, cand.platform, undefined, retryAfterSec, cand.model));

      if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
        const latencyMs = Date.now() - start;
        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };

        if (req.stream) {
          // v3 稳定性:首 chunk 探测 — 在返回给客户端之前验证上游流是否有效
          // 空流 / 超时 / 错误流 → 自动 fallback 到下一个候选(客户端完全无感知)
          const peeked = await peekFirstChunk(upstreamRes.body!, 15000);
          if (!peeked) {
            console.warn(`[chat] Stream probe failed (empty/timeout) from ${cand.platform}/${cand.model}, falling back to next candidate`);
            lastError = { status: 200, message: 'Stream probe failed — empty or timeout', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(
              logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i)
            );
            continue;
          }

          const idGen = () => `chatcmpl-${Date.now()}`;
          const streamStart = start;
          // 流结束时记录 usage(如果上游提供了的话)并消费配额
          const stream = normalizeSseStream(
            peeked.stream,
            cand.platform,
            cand.model,
            idGen,
            (usage) => {
              const promptTokens = usage?.prompt_tokens || 0;
              const completionTokens = usage?.completion_tokens || 0;
              c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
              c.executionCtx.waitUntil(
                logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - streamStart, true, i, usage)
              );
            },
            includeUsage,  // TRAE/OpenAI: stream_options.include_usage
            (error) => {
              // 流中途异常 — headers 已发送无法 fallback,但记录失败供下次路由参考
              console.warn(`[chat] Stream error mid-flight from ${cand.platform}/${cand.model}: ${error.message}`);
              c.executionCtx.waitUntil(
                recordKeyResult(c.env, cand.keyId, 0, cand.platform, undefined, undefined, cand.model)
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
              'X-Accel-Buffering': 'no',
              ...respHeaders,
            },
          });
        } else {
          const body = await upstreamRes.json() as Record<string, unknown>;

          // v3 稳定性:检测上游返回 200 但 body 是错误对象的情况(某些上游会这样)
          if (body.error && !body.choices) {
            console.warn(`[chat] Upstream returned 200 with error body from ${cand.platform}/${cand.model}: ${JSON.stringify(body.error).slice(0, 200)}`);
            const errBody = body.error as Record<string, unknown> | undefined;
            lastError = { status: 200, message: (errBody?.message as string) || 'Upstream error in 200 response', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(
              logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i)
            );
            continue;
          }

          const normalized = provider.parseResponse(body, cand.model) as {
            id?: string;
            object?: string;
            created?: number;
            model?: string;
            choices?: Array<{
              index?: number;
              message?: { role?: string; content?: string; reasoning_content?: string; tool_calls?: Array<Record<string, unknown>> };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            error?: { message?: string };
          };

          // 空内容检测:如果上游返回 200 但内容为空,触发 fallback 到下一个候选
          // 注意:某些上游(如 LLM7)将实际输出放在 reasoning 字段而非 content 字段
          const msg = normalized.choices?.[0]?.message;
          const content = msg?.content || '';
          const reasoningContent = msg?.reasoning_content || '';
          const hasContent = content.length > 0 || reasoningContent.length > 0;
          // 如果有 tool_calls,也算有内容
          const hasToolCalls = (msg?.tool_calls && msg.tool_calls.length > 0) || false;
          if (!hasContent && !hasToolCalls && candidates.length > i + 1) {
            console.warn(`[chat] Empty content from ${cand.platform}/${cand.model} (status 200), falling back to next candidate`);
            lastError = { status: 200, message: 'Empty content', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(
              logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i)
            );
            continue;
          }

          // Tool-call rescue:检测文本中的工具调用,转换为结构化 tool_calls
          if (msg && !hasToolCalls && hasContent) {
            const rescued = rescueToolCalls(
              { content: msg.content, tool_calls: msg.tool_calls as any },
              finalReq.tools as any
            );
            if (rescued.tool_calls && rescued.tool_calls.length > 0) {
              msg.tool_calls = rescued.tool_calls as any;
              msg.content = undefined;  // 工具调用已提取,清空文本
              console.log(`[chat] Tool-call rescue: extracted ${rescued.tool_calls.length} tool calls from ${cand.platform}/${cand.model}`);
            }
          }

          // 成功 — 实际消费配额(用真实 token 数)
          const promptTokens = normalized.usage?.prompt_tokens || 0;
          const completionTokens = normalized.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(
            updateStickySession(c.env, sessionId, cand.platform, cand.model)
          );
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, upstreamRes.status, latencyMs, false, i, normalized.usage)
          );

          // 缓存写入(非流式成功响应)
          if (cacheKey) {
            const ttl = getCustomTtl(c.req.raw.headers) || undefined;
            c.executionCtx.waitUntil(setCachedResponse(c.env.CONFIG, cacheKey, JSON.stringify(normalized), ttl));
          }

          return c.json(normalized, 200, {
            ...respHeaders,
            ...(cacheKey ? { 'X-Cache': 'MISS' } : {}),
          });
        }
      } else {
        // 上游错误,记录日志后继续下一个候选
        const errBody = await upstreamRes.text();
        lastError = { status: upstreamRes.status, body: errBody, platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(
          logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i)
        );
        continue;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      console.warn(`[chat] ${isTimeout ? 'Fetch timeout (30s)' : 'Fetch error'} from ${cand.platform}/${cand.model}: ${msg}`);
      lastError = { status: 0, message: isTimeout ? 'Fetch timeout (30s)' : msg, platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(
        logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i)
      );
      continue;
    }
  }

  // 全部失败 — 给出更友好的错误信息
  const lastErr = lastError || {};
  const platform = (lastErr as any).platform || 'unknown';
  const model = (lastErr as any).model || 'unknown';
  const errStatus = (lastErr as any).status || 0;
  const errBody = (lastErr as any).body || (lastErr as any).message || 'Unknown error';
  // 截断过长的错误 body
  const errMsg = typeof errBody === 'string' && errBody.length > 200
    ? errBody.slice(0, 200) + '...'
    : typeof errBody === 'string' ? errBody : JSON.stringify(errBody).slice(0, 200);
  return err(
    c,
    `模型 "${model}" 在平台 "${platform}" 上请求失败 (HTTP ${errStatus}): ${errMsg}`,
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
