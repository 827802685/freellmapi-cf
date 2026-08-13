/**
 * /v1/messages - Anthropic Messages API 兼容
 * 让 Claude Code / Anthropic SDK 能直接用
 *
 * 简化实现:把 Anthropic 格式的 messages 翻译成 OpenAI chat 格式,
 * 然后通过 router 转发,响应再翻译回 Anthropic 格式
 *
 * v3 稳定性增强:
 * 1. 流式首 chunk 探测:peekFirstChunk 验证流有效性,空流/超时自动 fallback
 * 2. fetch 超时控制:30s 内未收到响应头自动 abort
 * 3. 200+error body 检测:上游返回 200 但 body 是错误对象时自动 fallback
 * 4. 流中途异常记录:onError 回调记录 mid-stream 失败
 * 5. message_stop 无条件发送(保留 v2)
 * 6. 流结束时处理 buffer 残留 + flush decoder(保留 v2)
 * 7. content_block_start/content_block_stop 事件(保留 v2)
 * 8. stop_reason 根据 finish_reason 映射(保留 v2)
 */

import { Hono } from 'hono';
import type { Env, RouteCandidate, ChatMessage, ChatContentPart, ChatCompletionRequest, Tool } from '../../types';
import { requireUserToken } from '../../lib/auth';
import type { UserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession, consumeQuota, precheckCandidates } from '../../lib/router';
import type { RouteMode } from '../../lib/router';
import { getProvider } from '../../providers';
import { AihordeProvider } from '../../providers/aihorde';
import { normalizeSseStream, peekFirstChunk } from '../../lib/stream';

export const messagesRoute = new Hono<{ Bindings: Env }>();

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;  // base64 (type=base64) 或 URL (type=url)
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: Tool[];
  tool_choice?: ChatCompletionRequest['tool_choice'];
}

messagesRoute.post('/messages', requireUserToken, async (c) => {
  const start = Date.now();
  const body = await c.req.json<AnthropicRequest>();

  // max_tokens 兜底:Anthropic API 要求必填,但有些客户端不传
  if (!body.max_tokens || body.max_tokens < 1) {
    body.max_tokens = 8192;
  }

  // Anthropic 模型名直接传给 router — resolveModelId 会查 D1 匹配
  // 如果用户传 claude-sonnet-4 但我们没有 Claude key,router 会走 fallback
  const model = body.model;

  // 翻译 messages(支持图片: Anthropic source → OpenAI image_url)
  const openaiMessages: ChatMessage[] = [];
  let hasImage = false;
  if (body.system) {
    const sysText = typeof body.system === 'string' ? body.system : body.system.map(s => s.text || '').join('\n');
    openaiMessages.push({ role: 'system', content: sysText });
  }
  for (const m of body.messages) {
    if (typeof m.content === 'string') {
      openaiMessages.push({ role: m.role, content: m.content });
      continue;
    }
    // 数组 content:分离 text 和 image source
    const parts: ChatContentPart[] = [];
    for (const block of m.content) {
      if (block.type === 'text' && block.text) {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source) {
        // Anthropic source → OpenAI image_url
        const src = block.source;
        if (src.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
          hasImage = true;
        } else if (src.type === 'url' && src.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: src.data },
          });
          hasImage = true;
        }
      } else if (block.text) {
        // 兜底:有 text 就保留
        parts.push({ type: 'text', text: block.text });
      }
    }
    // 如果只有一个 text part,简化为字符串(兼容更多 provider)
    if (parts.length === 1 && parts[0].type === 'text') {
      openaiMessages.push({ role: m.role, content: parts[0].text as string });
    } else {
      openaiMessages.push({ role: m.role, content: parts });
    }
  }

  // 选路
  const userToken = c.get('userToken') as UserToken;
  const sessionId = c.req.header('X-Session-Id') || null;
  const routeMode = (c.req.header('X-Route-Mode') || 'auto') as RouteMode;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: model,
    routeMode,
    hasImage,
  });

  if (route.candidates.length === 0) {
    return c.json({ type: 'error', error: { type: 'api_error', message: 'No route available' } }, 503);
  }

  // 并行预检所有候选(一次 DO round-trip,替代串行 checkCandidate)
  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return c.json({ type: 'error', error: { type: 'api_error', message: 'All candidates are in cooldown or rate-limited.' } }, 503);
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);

    // AIHorde 特殊处理:异步任务模式
    if (provider instanceof AihordeProvider) {
      try {
        const hordeReq = {
          model: cand.model,
          messages: openaiMessages,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          top_p: body.top_p,
          stop: body.stop_sequences,
          stream: false,
        } satisfies ChatCompletionRequest;
        const result = await provider.executeRequest(hordeReq, cand.keyPlaintext, cand.model);
        c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, result.status, cand.platform, undefined, undefined, cand.model));

        if (result.status >= 200 && result.status < 300) {
          const chat = provider.parseResponse(result.body, cand.model) as {
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
          const text = chat.choices?.[0]?.message?.content || '';

          if (!text && candidates.length > i + 1) {
            lastError = { status: 200, message: 'Empty content from AIHorde', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i));
            continue;
          }

          const promptTokens = chat.usage?.prompt_tokens || 0;
          const completionTokens = chat.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i, chat.usage));

          const respHeaders: Record<string, string> = {
            'X-Platform': cand.platform,
            'X-Model': cand.model,
            'X-Latency': String(Date.now() - start),
            'X-Fallback-Count': String(i),
          };

          // 非流式返回
          return c.json({
            id: 'msg_' + Date.now(),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: body.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: promptTokens, output_tokens: completionTokens },
          }, 200, respHeaders);
        } else {
          lastError = { status: result.status, body: result.body, platform: cand.platform, model: cand.model };
          c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i));
          continue;
        }
      } catch (e: unknown) {
        lastError = { status: 0, message: e instanceof Error ? e.message : String(e), platform: cand.platform, model: cand.model };
        c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i));
        continue;
      }
    }

    const upstreamReq = provider.transformRequest(
      {
        model: cand.model,
        messages: openaiMessages,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        top_p: body.top_p,
        stop: body.stop_sequences,
        stream: body.stream || false,
      } satisfies ChatCompletionRequest,
      cand.keyPlaintext,
      cand.model
    );

    try {
      // v3 稳定性:fetch 超时控制 — 30s 内未收到响应头则 abort,触发 fallback
      const fetchController = new AbortController();
      const fetchTimeoutId = setTimeout(() => fetchController.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(upstreamReq.url, {
          method: upstreamReq.method,
          headers: upstreamReq.headers,
          body: upstreamReq.body,
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(fetchTimeoutId);
      }

      // 解析 retry-after
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
          // v3 稳定性:首 chunk 探测 — 验证上游流有效性,空流/超时自动 fallback
          const peeked = await peekFirstChunk(res.body!, 15000);
          if (!peeked) {
            console.warn(`[messages] Stream probe failed (empty/timeout) from ${cand.platform}/${cand.model}, falling back`);
            lastError = { status: 200, message: 'Stream probe failed — empty or timeout', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i));
            continue;
          }

          // 流式:把 OpenAI SSE 翻译成 Anthropic SSE
          const idGen = () => `msg_${Date.now()}`;
          const streamStart = start;
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
                logRequest(c.env, userToken.id, cand, res.status, Date.now() - streamStart, true, i, usage)
              );
            },
            false,  // includeUsage — Anthropic 格式不需要
            (error) => {
              // 流中途异常 — 记录失败供下次路由参考
              console.warn(`[messages] Stream error mid-flight from ${cand.platform}/${cand.model}: ${error.message}`);
              c.executionCtx.waitUntil(
                recordKeyResult(c.env, cand.keyId, 0, cand.platform, undefined, undefined, cand.model)
              );
            }
          );

          // 把 OpenAI SSE 格式转换为 Anthropic SSE 格式
          const anthropicStream = new ReadableStream({
            async start(controller) {
              const reader = stream.getReader();
              const decoder = new TextDecoder();
              const encoder = new TextEncoder();
              let buffer = '';
              const msgId = `msg_${Date.now()}`;
              let contentBlockStarted = false;
              let stopReasonSent = false;

              try {
                // 发送 message_start 事件
                controller.enqueue(encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: {
                      id: msgId,
                      type: 'message',
                      role: 'assistant',
                      content: [],
                      model: body.model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  })}\n\n`
                ));

                // 发送 content_block_start
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                  })}\n\n`
                ));
                contentBlockStarted = true;

                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    // flush decoder
                    const flushed = decoder.decode();
                    if (flushed) buffer += flushed;

                    // 处理 buffer 残留
                    if (buffer.trim()) {
                      processAnthropicLine(buffer, controller, encoder, contentBlockStarted, stopReasonSent, (started, sent) => {
                        contentBlockStarted = started;
                        stopReasonSent = sent;
                      });
                    }
                    break;
                  }
                  buffer += decoder.decode(value, { stream: true });

                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';

                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      try {
                        const data = JSON.parse(line.slice(6));
                        // 转换 OpenAI chunk 到 Anthropic 格式
                        const delta = data.choices?.[0]?.delta;
                        if (delta?.content) {
                          controller.enqueue(encoder.encode(
                            `event: content_block_delta\ndata: ${JSON.stringify({
                              type: 'content_block_delta',
                              index: 0,
                              delta: { type: 'text_delta', text: delta.content },
                            })}\n\n`
                          ));
                        }
                        if (data.choices?.[0]?.finish_reason && !stopReasonSent) {
                          const finishReason = data.choices[0].finish_reason;
                          // 映射 finish_reason → stop_reason
                          const stopReasonMap: Record<string, string> = {
                            stop: 'end_turn',
                            length: 'max_tokens',
                            tool_calls: 'tool_use',
                            content_filter: 'end_turn',
                          };
                          const stopReason = stopReasonMap[finishReason] || 'end_turn';
                          const usage = data.usage || {};
                          controller.enqueue(encoder.encode(
                            `event: message_delta\ndata: ${JSON.stringify({
                              type: 'message_delta',
                              delta: { stop_reason: stopReason, stop_sequence: null },
                              usage: { output_tokens: usage.completion_tokens || 0 },
                            })}\n\n`
                          ));
                          stopReasonSent = true;
                        }
                      } catch (e) {
                        // 跳过 [DONE] 和无法解析的行
                      }
                    }
                  }
                }

                // 发送 content_block_stop(如果已开始)
                if (contentBlockStarted) {
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: 0,
                    })}\n\n`
                  ));
                }

                // 无条件发送 message_stop(之前依赖 finish_reason,导致客户端挂起)
                if (!stopReasonSent) {
                  controller.enqueue(encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: 'message_delta',
                      delta: { stop_reason: 'end_turn', stop_sequence: null },
                      usage: { output_tokens: 0 },
                    })}\n\n`
                  ));
                }
                controller.enqueue(encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
                ));
              } catch (e) {
                controller.error(e);
              } finally {
                controller.close();
              }
            },
          });

          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          return new Response(anthropicStream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Accel-Buffering': 'no',
              ...respHeaders,
            },
          });
        } else {
          // 非流式
          const rawBody = await res.json() as Record<string, unknown>;

          // v3 稳定性:检测上游返回 200 但 body 是错误对象
          if (rawBody.error && !rawBody.choices) {
            console.warn(`[messages] Upstream returned 200 with error body from ${cand.platform}/${cand.model}: ${JSON.stringify(rawBody.error).slice(0, 200)}`);
            const errBody = rawBody.error as Record<string, unknown> | undefined;
            lastError = { status: 200, message: (errBody?.message as string) || 'Upstream error in 200 response', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i));
            continue;
          }

          const chat = provider.parseResponse(rawBody, cand.model) as {
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
          const text = chat.choices?.[0]?.message?.content || '';

          // 空内容检测
          if (!text && candidates.length > i + 1) {
            console.warn(`[messages] Empty content from ${cand.platform}/${cand.model}, falling back`);
            lastError = { status: 200, message: 'Empty content', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i));
            continue;
          }

          const promptTokens = chat.usage?.prompt_tokens || 0;
          const completionTokens = chat.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          c.executionCtx.waitUntil(
            logRequest(c.env, userToken.id, cand, res.status, Date.now() - start, false, i, chat.usage)
          );

          // 转回 Anthropic 格式
          return c.json({
            id: 'msg_' + Date.now(),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: body.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
            },
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
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[messages] ${isTimeout ? 'Fetch timeout (30s)' : 'Fetch error'} from ${cand.platform}/${cand.model}: ${errMsg}`);
      lastError = { status: 0, message: isTimeout ? 'Fetch timeout (30s)' : errMsg, platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(
        logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i)
      );
      continue;
    }
  }

  return c.json({
    type: 'error',
    error: { type: 'api_error', message: `All routes failed. Last error: ${JSON.stringify(lastError)}` },
  }, 502);
});

/**
 * 处理 anthropicStream 中 buffer 残留的最后一行
 */
function processAnthropicLine(
  buffer: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  contentBlockStarted: boolean,
  stopReasonSent: boolean,
  updateState: (started: boolean, sent: boolean) => void
) {
  const trimmed = buffer.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  try {
    const data = JSON.parse(trimmed.slice(6));
    const delta = data.choices?.[0]?.delta;
    if (delta?.content) {
      controller.enqueue(encoder.encode(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta.content },
        })}\n\n`
      ));
    }
    if (data.choices?.[0]?.finish_reason && !stopReasonSent) {
      const stopReasonMap: Record<string, string> = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'end_turn',
      };
      const stopReason = stopReasonMap[data.choices[0].finish_reason] || 'end_turn';
      const usage = data.usage || {};
      controller.enqueue(encoder.encode(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: usage.completion_tokens || 0 },
        })}\n\n`
      ));
      updateState(contentBlockStarted, true);
    }
  } catch {
    // 跳过 [DONE] 和无法解析的行
  }
}

messagesRoute.post('/messages/count_tokens', requireUserToken, async (c) => {
  const body = await c.req.json<{ messages: AnthropicMessage[]; system?: string }>();
  let total = 0;
  for (const m of body.messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    total += Math.ceil(text.length / 4);
  }
  if (body.system) total += Math.ceil((typeof body.system === 'string' ? body.system : '').length / 4);
  return c.json({ input_tokens: total });
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
