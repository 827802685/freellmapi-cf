/**
 * /v1/responses - OpenAI Responses API 兼容
 * 让 Codex CLI / OpenAI SDK (Responses API) 能直接用
 *
 * 翻译层: Responses API 格式 → 内部 Chat Completions 格式
 * 响应再翻译回 Responses API 格式(流式 + 非流式)
 *
 * v3 稳定性增强:
 * 1. 流式首 chunk 探测:peekFirstChunk 验证流有效性,空流/超时自动 fallback
 * 2. fetch 超时控制:30s 内未收到响应头自动 abort
 * 3. 200+error body 检测:上游返回 200 但 body 是错误对象时自动 fallback
 * 4. 流中途异常记录:onError 回调记录 mid-stream 失败
 *
 * 支持的 input 格式:
 * 1. 纯字符串: "Hello"
 * 2. 消息数组: [{ type: 'message', role: 'user', content: '...' }]
 * 3. 多轮对话(含 function_call / function_call_output)
 *
 * 支持的 tools 格式:
 * { type: 'function', name, description, parameters } → { type: 'function', function: { name, ... } }
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

export const responsesRoute = new Hono<{ Bindings: Env }>();

// ===== Responses API 请求类型 =====
interface ResponsesInputItem {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; image_url?: string }>;
  // function_call (assistant 之前的工具调用)
  call_id?: string;
  name?: string;
  arguments?: string;
  // function_call_output (工具返回结果)
  output?: string;
}

interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: Array<{
    type: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
    function?: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
  }>;
  tool_choice?: string | { type: string; name?: string };
  previous_response_id?: string;
}

/**
 * 把 Responses API input 翻译成 OpenAI Chat Completions messages
 */
function translateInput(input: string | ResponsesInputItem[], instructions?: string): { messages: ChatMessage[]; hasImage: boolean } {
  const messages: ChatMessage[] = [];
  let hasImage = false;

  // instructions → system message
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  // 纯字符串 input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return { messages, hasImage };
  }

  // 数组 input
  for (const item of input) {
    if (item.type === 'message' && item.role) {
      const role = item.role as 'user' | 'assistant' | 'system';

      if (typeof item.content === 'string') {
        messages.push({ role, content: item.content });
      } else if (Array.isArray(item.content)) {
        const parts: ChatContentPart[] = [];
        for (const part of item.content) {
          if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
            parts.push({ type: 'text', text: part.text || '' });
          } else if (part.type === 'input_image' || part.type === 'image') {
            parts.push({ type: 'image_url', image_url: { url: part.image_url || '' } });
            hasImage = true;
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') {
          messages.push({ role, content: parts[0].text as string });
        } else {
          messages.push({ role, content: parts });
        }
      }
    } else if (item.type === 'function_call') {
      // 之前的 assistant tool call → 放入上一条 assistant 消息的 tool_calls
      // 找最后一条 assistant 消息,追加 tool_calls;如果没有就新建
      const lastMsg = messages[messages.length - 1];
      const toolCall = {
        id: item.call_id || `call_${Date.now()}`,
        type: 'function' as const,
        function: { name: item.name || '', arguments: item.arguments || '{}' },
      };
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls) {
        lastMsg.tool_calls.push(toolCall);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      }
    } else if (item.type === 'function_call_output') {
      // 工具返回结果 → tool message
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: item.output || '',
      });
    }
    // 忽略其他类型 (reasoning 等)
  }

  return { messages, hasImage };
}

/**
 * 把 Responses API tools 翻译成 Chat Completions tools
 */
function translateTools(tools: ResponsesRequest['tools']): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => {
    // 已经是 Chat Completions 格式
    if (t.function) {
      return { type: 'function', function: t.function };
    }
    // Responses API 格式 → Chat Completions
    return {
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    };
  });
}

/**
 * 把 Chat Completions 响应翻译成 Responses API 格式
 */
function translateResponse(chat: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = chat.choices as Array<{ message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> }; finish_reason?: string }> | undefined;
  const choice = choices?.[0];
  const message = choice?.message;
  const text = message?.content || '';
  const toolCalls = message?.tool_calls;

  const output: Array<Record<string, unknown>> = [];

  // 文本输出
  if (text) {
    output.push({
      type: 'message',
      id: `msg_${Date.now()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }

  // 工具调用
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      output.push({
        type: 'function_call',
        id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        call_id: tc.id || `call_${Date.now()}`,
        name: (tc.function as Record<string, unknown> | undefined)?.name as string || '',
        arguments: (tc.function as Record<string, unknown> | undefined)?.arguments as string || '{}',
        status: 'completed',
      });
    }
  }

  // 如果 output 为空,加一个空消息
  if (output.length === 0) {
    output.push({
      type: 'message',
      id: `msg_${Date.now()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    });
  }

  const chatUsage = chat.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const promptTokens = chatUsage?.prompt_tokens || 0;
  const completionTokens = chatUsage?.completion_tokens || 0;

  // finish_reason → status
  const finishReason = choice?.finish_reason || 'stop';
  const status = finishReason === 'length' ? 'incomplete' : 'completed';

  return {
    id: `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

responsesRoute.post('/responses', requireUserToken, async (c) => {
  const start = Date.now();
  const body = await c.req.json<ResponsesRequest>();

  // 1) 翻译 input → messages
  const { messages: openaiMessages, hasImage } = translateInput(body.input, body.instructions);

  // 2) 翻译 tools
  const tools = translateTools(body.tools);

  // 3) 构建内部 Chat Completions 请求
  // max_tokens 兜底:客户端未设 max_output_tokens 时给 8192,避免截断
  const chatReq: ChatCompletionRequest = {
    model: body.model,
    messages: openaiMessages,
    stream: body.stream || false,
    max_tokens: body.max_output_tokens || 8192,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(tools ? { tools } : {}),
    ...(body.tool_choice ? { tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice as 'auto' | 'none' | 'required' : { type: 'function', function: { name: body.tool_choice.name || '' } } } : {}),
  };

  // 4) 选路
  const userToken = c.get('userToken') as UserToken;
  const sessionId = c.req.header('X-Session-Id') || null;
  const routeMode = (c.req.header('X-Route-Mode') || 'auto') as RouteMode;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: body.model,
    routeMode,
    hasImage,
  });

  if (route.candidates.length === 0) {
    return c.json({
      type: 'error',
      error: { type: 'server_error', message: 'No route available. Add keys or check fallback chain.' },
    }, 503);
  }

  // 5) 并行预检
  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return c.json({
      type: 'error',
      error: { type: 'server_error', message: 'All candidates are in cooldown or rate-limited.' },
    }, 503);
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);

    // AIHorde 特殊处理
    if (provider instanceof AihordeProvider) {
      try {
        const hordeReq = { ...chatReq, stream: false };
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
              message?: { role?: string; content?: string; reasoning_content?: string; tool_calls?: Array<Record<string, unknown>> };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            error?: { message?: string };
          };
          const text = chat.choices?.[0]?.message?.content || '';

          if (!text && candidates.length > i + 1) {
            lastError = { status: 200, message: 'Empty content from AIHorde' };
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

          if (body.stream) {
            // 流式:包装成 Responses API SSE
            return wrapStreamResponses(text, body.model, respHeaders, chat.usage);
          }

          return c.json(translateResponse(chat, body.model), 200, respHeaders);
        } else {
          lastError = { status: result.status, body: result.body };
          c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, result.status, Date.now() - start, false, i));
          continue;
        }
      } catch (e: unknown) {
        lastError = { status: 0, message: e instanceof Error ? e.message : String(e) };
        c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i));
        continue;
      }
    }

    // 普通上游请求
    const upstreamReq = provider.transformRequest(chatReq, cand.keyPlaintext, cand.model);

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

      // 记录到 DO
      const retryAfterHeader = upstreamRes.headers.get('retry-after');
      let retryAfterSec: number | undefined;
      if (retryAfterHeader) {
        const asNum = parseInt(retryAfterHeader, 10);
        if (!isNaN(asNum)) retryAfterSec = asNum;
      }
      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, upstreamRes.status, cand.platform, undefined, retryAfterSec, cand.model));

      if (upstreamRes.ok) {
        const latencyMs = Date.now() - start;
        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };

        if (body.stream) {
          // v3 稳定性:首 chunk 探测 — 验证上游流有效性,空流/超时自动 fallback
          const peeked = await peekFirstChunk(upstreamRes.body!, 15000);
          if (!peeked) {
            console.warn(`[responses] Stream probe failed (empty/timeout) from ${cand.platform}/${cand.model}, falling back`);
            lastError = { status: 200, message: 'Stream probe failed — empty or timeout', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i));
            continue;
          }

          // 流式:把 OpenAI SSE 翻译成 Responses API SSE
          const idGen = () => `chatcmpl-${Date.now()}`;
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
              c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - streamStart, true, i, usage));
            },
            false,  // includeUsage — Responses API 格式单独处理 usage
            (error) => {
              // 流中途异常 — 记录失败供下次路由参考
              console.warn(`[responses] Stream error mid-flight from ${cand.platform}/${cand.model}: ${error.message}`);
              c.executionCtx.waitUntil(
                recordKeyResult(c.env, cand.keyId, 0, cand.platform, undefined, undefined, cand.model)
              );
            }
          );

          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));

          const responsesStream = translateStreamToResponses(stream, body.model, respHeaders, cand);
          return responsesStream;
        } else {
          // 非流式
          const rawBody = await upstreamRes.json() as Record<string, unknown>;

          // v3 稳定性:检测上游返回 200 但 body 是错误对象
          if (rawBody.error && !rawBody.choices) {
            console.warn(`[responses] Upstream returned 200 with error body from ${cand.platform}/${cand.model}: ${JSON.stringify(rawBody.error).slice(0, 200)}`);
            const errBody = rawBody.error as Record<string, unknown> | undefined;
            lastError = { status: 200, message: (errBody?.message as string) || 'Upstream error in 200 response', platform: cand.platform, model: cand.model };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i));
            continue;
          }

          const chat = provider.parseResponse(rawBody, cand.model) as {
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
          const text = chat.choices?.[0]?.message?.content || '';

          // 空内容检测
          if (!text && !(chat.choices?.[0]?.message?.tool_calls?.length) && candidates.length > i + 1) {
            console.warn(`[responses] Empty content from ${cand.platform}/${cand.model}, falling back`);
            lastError = { status: 200, message: 'Empty content' };
            c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i));
            continue;
          }

          const promptTokens = chat.usage?.prompt_tokens || 0;
          const completionTokens = chat.usage?.completion_tokens || 0;
          c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
          c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
          c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, latencyMs, false, i, chat.usage));

          return c.json(translateResponse(chat, body.model), 200, respHeaders);
        }
      } else {
        const errBody = await upstreamRes.text();
        lastError = { status: upstreamRes.status, body: errBody };
        c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, upstreamRes.status, Date.now() - start, false, i));
        continue;
      }
    } catch (e: unknown) {
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[responses] ${isTimeout ? 'Fetch timeout (30s)' : 'Fetch error'} from ${cand.platform}/${cand.model}: ${errMsg}`);
      lastError = { status: 0, message: isTimeout ? 'Fetch timeout (30s)' : errMsg, platform: cand.platform, model: cand.model };
      c.executionCtx.waitUntil(logRequest(c.env, userToken.id, cand, 0, Date.now() - start, false, i));
      continue;
    }
  }

  return c.json({
    type: 'error',
    error: { type: 'server_error', message: `All routes failed. Last error: ${JSON.stringify(lastError)}` },
  }, 502);
});

/**
 * 把非流式结果包装成 Responses API 流式 SSE (用于 AIHorde 等不支持流式的 provider)
 */
function wrapStreamResponses(text: string, model: string, respHeaders: Record<string, string>, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): Response {
  const respId = `resp_${Date.now()}`;
  const msgId = `msg_${Date.now()}`;
  const encoder = new TextEncoder();
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // response.created
      send('response.created', {
        type: 'response.created',
        response: { id: respId, object: 'response', status: 'in_progress', model, output: [] },
      });

      // output_item.added
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
      });

      // content_part.added
      send('response.content_part.added', {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      });

      // output_text.delta (一次性发完)
      if (text) {
        send('response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      }

      // output_text.done
      send('response.output_text.done', {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text,
      });

      // content_part.done
      send('response.content_part.done', {
        type: 'response.content_part.done',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text },
      });

      // output_item.done
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
      });

      // response.completed
      send('response.completed', {
        type: 'response.completed',
        response: {
          id: respId,
          object: 'response',
          status: 'completed',
          model,
          output: [{ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        },
      });

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...respHeaders,
    },
  });
}

/**
 * 把 OpenAI Chat Completions SSE 流翻译成 Responses API SSE 流
 * 处理:文本 delta, tool_calls delta, finish_reason, usage
 */
function translateStreamToResponses(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
  respHeaders: Record<string, string>,
  cand: RouteCandidate
): Response {
  const respId = `resp_${Date.now()}`;
  const msgId = `msg_${Date.now()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openaiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let textStarted = false;
      let fullText = '';
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
      let finishReason: string | null = null;

      // 跟踪 tool_calls (可能有多个)
      const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();
      let toolCallOutputIndex = 0;

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) return;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return;

        try {
          const data = JSON.parse(dataStr);
          const choice = data.choices?.[0];
          const delta = choice?.delta;

          // 文本内容
          if (delta?.content) {
            if (!textStarted) {
              textStarted = true;
              // 发送 output_item.added + content_part.added
              send('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
              });
              send('response.content_part.added', {
                type: 'response.content_part.added',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              });
            }
            fullText += delta.content;
            send('response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            });
          }

          // 推理内容 (reasoning_content) — 作为文本发送
          if (delta?.reasoning_content) {
            if (!textStarted) {
              textStarted = true;
              send('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
              });
              send('response.content_part.added', {
                type: 'response.content_part.added',
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              });
            }
            fullText += delta.reasoning_content;
            send('response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: delta.reasoning_content,
            });
          }

          // tool_calls (流式增量)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index || 0;
              if (!toolCallBuffers.has(idx)) {
                // 新 tool call
                toolCallBuffers.set(idx, {
                  id: tc.id || `call_${Date.now()}_${idx}`,
                  name: tc.function?.name || '',
                  args: '',
                });
                const fcId = `fc_${Date.now()}_${idx}`;
                const outputIdx = idx + 1; // tool calls 在文本之后(output_index 从 1 开始)
                if (outputIdx > toolCallOutputIndex) toolCallOutputIndex = outputIdx;

                send('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: outputIdx,
                  item: {
                    type: 'function_call',
                    id: fcId,
                    call_id: tc.id || `call_${Date.now()}_${idx}`,
                    name: tc.function?.name || '',
                    arguments: '',
                    status: 'in_progress',
                  },
                });
              }

              const buf = toolCallBuffers.get(idx)!;
              if (tc.function?.name && !buf.name) {
                buf.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                buf.args += tc.function.arguments;
                const outputIdx = idx + 1;
                send('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  output_index: outputIdx,
                  item_id: `fc_${Date.now()}_${idx}`,
                  delta: tc.function.arguments,
                });
              }
            }
          }

          // finish_reason
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          // usage (通常在最后一个 chunk)
          if (data.usage) {
            usage = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }
        } catch {
          // 跳过无法解析的行
        }
      };

      try {
        // 发送 response.created
        send('response.created', {
          type: 'response.created',
          response: { id: respId, object: 'response', status: 'in_progress', model, output: [] },
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const flushed = decoder.decode();
            if (flushed) buffer += flushed;
            // 处理残留
            if (buffer.trim()) {
              processLine(buffer);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            processLine(line);
          }
        }

        // 收尾:关闭文本 part(如果已开始)
        if (textStarted) {
          send('response.output_text.done', {
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            text: fullText,
          });
          send('response.content_part.done', {
            type: 'response.content_part.done',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: fullText },
          });
          send('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText }] },
          });
        }

        // 收尾:关闭 tool_call items
        for (const [idx, tc] of toolCallBuffers) {
          const fcId = `fc_${Date.now()}_${idx}`;
          send('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            output_index: idx,
            item_id: fcId,
            arguments: tc.args,
          });
          send('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: idx,
            item: {
              type: 'function_call',
              id: fcId,
              call_id: tc.id,
              name: tc.name,
              arguments: tc.args,
              status: 'completed',
            },
          });
        }

        // 构建 final output
        const output: Array<Record<string, unknown>> = [];
        if (textStarted || fullText) {
          output.push({
            type: 'message',
            id: msgId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: fullText }],
          });
        }
        for (const [, tc] of toolCallBuffers) {
          output.push({
            type: 'function_call',
            id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            call_id: tc.id,
            name: tc.name,
            arguments: tc.args,
            status: 'completed',
          });
        }
        if (output.length === 0) {
          output.push({
            type: 'message', id: msgId, status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text: '' }],
          });
        }

        const promptTokens = (usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null)?.prompt_tokens || 0;
        const completionTokens = (usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null)?.completion_tokens || 0;
        const status = finishReason === 'length' ? 'incomplete' : 'completed';

        send('response.completed', {
          type: 'response.completed',
          response: {
            id: respId,
            object: 'response',
            status,
            model,
            output,
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          },
        });
      } catch (e) {
        controller.error(e);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...respHeaders,
    },
  });
}

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
