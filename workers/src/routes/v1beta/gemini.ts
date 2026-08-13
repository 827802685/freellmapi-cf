/**
 * /v1beta/* — 原生 Gemini API 表面
 *
 * 让 Gemini SDK 和 Gemini CLI 工具可以直接使用原生 wire format。
 *
 * 支持的端点:
 * - POST /v1beta/models/{model}:generateContent
 * - POST /v1beta/models/{model}:streamGenerateContent
 * - POST /v1beta/models/{model}:countTokens
 * - GET  /v1beta/models (列出模型)
 * - GET  /v1beta/models/{model} (获取模型详情)
 *
 * 实现思路:将 Gemini 原生请求格式翻译为内部 Chat Completions 格式,
 * 通过 router 转发,响应再翻译回 Gemini 格式。
 */

import { Hono } from 'hono';
import type { Env, RouteCandidate, ChatMessage, ChatContentPart, ChatCompletionRequest } from '../../types';
import { requireUserToken } from '../../lib/auth';
import type { UserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession, consumeQuota, precheckCandidates } from '../../lib/router';
import type { RouteMode } from '../../lib/router';
import { getProvider } from '../../providers';
import { err } from '../../lib/response';

export const geminiRoute = new Hono<{ Bindings: Env }>();

// ===== Gemini 请求类型 =====

interface GeminiContent {
  parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
    fileData?: { mimeType: string; fileUri: string };
  }>;
  role?: string;
}

interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent;
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    candidateCount?: number;
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
    googleSearchRetrieval?: Record<string, unknown>;
    codeExecution?: Record<string, unknown>;
  }>;
  toolConfig?: {
    functionCallingConfig?: {
      mode?: string;
      allowedFunctionNames?: string[];
    };
  };
  system_instruction?: GeminiContent;
}

interface GeminiCountTokensRequest {
  contents: GeminiContent[];
}

// ===== 翻译函数 =====

/**
 * Gemini content → OpenAI messages
 */
function translateContents(contents: GeminiContent[], systemInstruction?: GeminiContent): {
  messages: ChatMessage[];
  hasImage: boolean;
} {
  const messages: ChatMessage[] = [];
  let hasImage = false;

  // system instruction
  if (systemInstruction) {
    const text = systemInstruction.parts.map(p => p.text || '').filter(Boolean).join('\n');
    if (text) {
      messages.push({ role: 'system', content: text });
    }
  }

  // contents → messages
  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : (content.role || 'user') as 'user' | 'assistant';

    const textParts: string[] = [];
    const contentParts: ChatContentPart[] = [];

    for (const part of content.parts) {
      if (part.text) {
        textParts.push(part.text);
        contentParts.push({ type: 'text', text: part.text });
      }
      if (part.inlineData) {
        // 图片数据
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          },
        });
        hasImage = true;
      }
      // fileData 作为文本引用处理
      if (part.fileData) {
        textParts.push(`[File: ${part.fileData.fileUri} (${part.fileData.mimeType})]`);
        contentParts.push({
          type: 'text',
          text: `[File: ${part.fileData.fileUri} (${part.fileData.mimeType})]`,
        });
      }
    }

    // 纯文本 → 简化为字符串(兼容更多 provider)
    if (textParts.length > 0) {
      messages.push({ role, content: textParts.join('\n') });
    } else if (contentParts.length > 0) {
      messages.push({ role, content: contentParts });
    }
  }

  return { messages, hasImage };
}

/**
 * Gemini tools → OpenAI tools
 */
function translateTools(tools: GeminiGenerateContentRequest['tools']): ChatCompletionRequest['tools'] {
  if (!tools || tools.length === 0) return undefined;

  const openaiTools: NonNullable<ChatCompletionRequest['tools']> = [];

  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const fn of tool.functionDeclarations) {
        openaiTools.push({
          type: 'function',
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          },
        });
      }
    }
    // googleSearchRetrieval 和 codeExecution 不做翻译,留给 Google provider 处理
  }

  return openaiTools.length > 0 ? openaiTools : undefined;
}

/**
 * OpenAI chat completion → Gemini generateContent 响应
 */
function translateResponse(chat: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = chat.choices as Array<{
    message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> };
    finish_reason?: string;
  }> | undefined;

  const choice = choices?.[0];
  const message = choice?.message;
  const text = message?.content || '';
  const toolCalls = message?.tool_calls;

  const parts: Array<Record<string, unknown>> = [];
  if (text) {
    parts.push({ text });
  }

  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      parts.push({
        functionCall: {
          name: (tc.function as Record<string, unknown> | undefined)?.name,
          args: (tc.function as Record<string, unknown> | undefined)?.arguments ?
            (typeof (tc.function as Record<string, unknown>).arguments === 'string'
              ? JSON.parse((tc.function as Record<string, unknown>).arguments as string)
              : (tc.function as Record<string, unknown>).arguments) :
            {},
        },
      });
    }
  }

  // finish_reason → Gemini finishReason
  const finishReasonMap: Record<string, string> = {
    stop: 'STOP',
    length: 'MAX_TOKENS',
    tool_calls: 'FUNCTION_CALL',
    content_filter: 'SAFETY',
  };
  const finishReason = finishReasonMap[choice?.finish_reason || ''] || 'STOP';

  const chatUsage = chat.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const promptTokens = chatUsage?.prompt_tokens || 0;
  const completionTokens = chatUsage?.completion_tokens || 0;

  return {
    candidates: [
      {
        content: {
          parts,
          role: 'model',
        },
        finishReason,
        safetyRatings: [],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: completionTokens,
          totalTokenCount: promptTokens + completionTokens,
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: promptTokens + completionTokens,
    },
    modelVersion: model,
  };
}

/**
 * 把 OpenAI 流式 chunk 翻译成 Gemini SSE 格式
 */
function translateStreamToGemini(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
  reqId: string,
  created: number
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const reader = openaiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;

            try {
              const data = JSON.parse(payload);
              const choice = data.choices?.[0];
              const delta = choice?.delta;

              const parts: Array<Record<string, unknown>> = [];
              if (delta?.content) {
                parts.push({ text: delta.content });
              }
              if (delta?.reasoning_content) {
                parts.push({ text: delta.reasoning_content, thought: true });
              }

              if (parts.length > 0) {
                send({
                  candidates: [
                    {
                      content: { parts, role: 'model' },
                      finishReason: null,
                    },
                  ],
                });
              }

              if (choice?.finish_reason) {
                const finishReasonMap: Record<string, string> = {
                  stop: 'STOP',
                  length: 'MAX_TOKENS',
                  tool_calls: 'FUNCTION_CALL',
                };
                const usage = data.usage || {};
                send({
                  candidates: [
                    {
                      content: { parts: [], role: 'model' },
                      finishReason: finishReasonMap[choice.finish_reason] || 'STOP',
                      usageMetadata: {
                        promptTokenCount: usage.prompt_tokens || 0,
                        candidatesTokenCount: usage.completion_tokens || 0,
                        totalTokenCount: usage.total_tokens || 0,
                      },
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: usage.prompt_tokens || 0,
                    candidatesTokenCount: usage.completion_tokens || 0,
                    totalTokenCount: usage.total_tokens || 0,
                  },
                });
              }
            } catch { /* skip */ }
          }
        }
      } catch (e) {
        // 流异常
        send({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'RECITATION' }] });
      } finally {
        controller.close();
      }
    },
  });
}

// ===== 路由处理器 =====

// POST /v1beta/models/{model}:generateContent
geminiRoute.post('/v1beta/models/:model:generateContent', requireUserToken, async (c) => {
  const start = Date.now();
  const model = c.req.param('model') || '';
  const body = await c.req.json<GeminiGenerateContentRequest>();

  // 翻译 contents → messages
  const { messages: openaiMessages, hasImage } = translateContents(body.contents, body.systemInstruction || body.system_instruction);
  const tools = translateTools(body.tools);

  // 构建 OpenAI Chat Completions 请求
  const gc = body.generationConfig || {};
  const maxTokens = gc.maxOutputTokens || 8192;
  const chatReq: ChatCompletionRequest = {
    model,
    messages: openaiMessages,
    stream: false,
    max_tokens: maxTokens,
    ...(gc.temperature !== undefined ? { temperature: gc.temperature } : {}),
    ...(gc.topP !== undefined ? { top_p: gc.topP } : {}),
    ...(gc.topK !== undefined ? { top_k: gc.topK } : {}),
    ...(gc.stopSequences ? { stop: gc.stopSequences } : {}),
    ...(tools ? { tools } : {}),
    ...(body.toolConfig?.functionCallingConfig?.mode ? {
      tool_choice: body.toolConfig.functionCallingConfig.mode === 'ANY' ? 'required' as const :
                   body.toolConfig.functionCallingConfig.mode === 'NONE' ? 'none' as const : 'auto' as const,
    } : {}),
  };

  // 选路
  const userToken = c.get('userToken') as UserToken;
  const sessionId = c.req.header('X-Session-Id') || null;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: model,
    routeMode: 'auto',
    hasImage,
  });

  if (route.candidates.length === 0) {
    return c.json({ error: { message: 'No route available', code: 'NO_ROUTE' } }, 503);
  }

  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return c.json({ error: { message: 'All candidates are in cooldown', code: 'ALL_COOLDOWN' } }, 503);
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);
    const upstreamReq = provider.transformRequest(chatReq, cand.keyPlaintext, cand.model);

    try {
      const fetchController = new AbortController();
      const timeoutId = setTimeout(() => fetchController.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(upstreamReq.url, {
          method: upstreamReq.method,
          headers: upstreamReq.headers,
          body: upstreamReq.body,
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status, cand.platform, undefined, undefined, cand.model));

      if (res.ok) {
        const latencyMs = Date.now() - start;
        const rawBody = await res.json() as Record<string, unknown>;

        // 200+error body 检测
        if (rawBody.error && !rawBody.choices) {
          lastError = { status: 200, message: 'Upstream error in 200 response' };
          continue;
        }

        const chat = provider.parseResponse(rawBody, cand.model) as Record<string, unknown>;
        const promptTokens = (chat.usage as any)?.prompt_tokens || 0;
        const completionTokens = (chat.usage as any)?.completion_tokens || 0;
        c.executionCtx.waitUntil(consumeQuota(c.env, cand.keyId, promptTokens, completionTokens, cand.model));
        c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));

        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };

        const geminiResp = translateResponse(chat, cand.model);
        return c.json(geminiResp, 200, respHeaders);
      } else {
        const errBody = await res.text();
        lastError = { status: res.status, body: errBody };
        continue;
      }
    } catch (e: unknown) {
      lastError = { status: 0, message: e instanceof Error ? e.message : String(e) };
      continue;
    }
  }

  return c.json({ error: { message: `All routes failed: ${JSON.stringify(lastError)}`, code: 'ALL_FAILED' } }, 502);
});

// POST /v1beta/models/{model}:streamGenerateContent
geminiRoute.post('/v1beta/models/:model:streamGenerateContent', requireUserToken, async (c) => {
  const start = Date.now();
  const model = c.req.param('model') || '';
  const body = await c.req.json<GeminiGenerateContentRequest>();

  // 同 generateContent 但 stream=true
  const { messages: openaiMessages, hasImage } = translateContents(body.contents, body.systemInstruction || body.system_instruction);
  const tools = translateTools(body.tools);

  const gc = body.generationConfig || {};
  const chatReq: ChatCompletionRequest = {
    model,
    messages: openaiMessages,
    stream: true,
    max_tokens: gc.maxOutputTokens || 8192,
    ...(gc.temperature !== undefined ? { temperature: gc.temperature } : {}),
    ...(gc.topP !== undefined ? { top_p: gc.topP } : {}),
    ...(gc.stopSequences ? { stop: gc.stopSequences } : {}),
    ...(tools ? { tools } : {}),
  };

  const userToken = c.get('userToken') as UserToken;
  const sessionId = c.req.header('X-Session-Id') || null;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: model,
    routeMode: 'auto',
    hasImage,
  });

  if (route.candidates.length === 0) {
    return c.json({ error: { message: 'No route available', code: 'NO_ROUTE' } }, 503);
  }

  const candidates = await precheckCandidates(c.env, route.candidates);
  if (candidates.length === 0) {
    return c.json({ error: { message: 'All candidates in cooldown', code: 'ALL_COOLDOWN' } }, 503);
  }

  let lastError: Record<string, unknown> | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);
    const upstreamReq = provider.transformRequest(chatReq, cand.keyPlaintext, cand.model);

    try {
      const fetchController = new AbortController();
      const timeoutId = setTimeout(() => fetchController.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(upstreamReq.url, {
          method: upstreamReq.method,
          headers: upstreamReq.headers,
          body: upstreamReq.body,
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status, cand.platform, undefined, undefined, cand.model));

      if (res.ok) {
        const latencyMs = Date.now() - start;
        const respHeaders: Record<string, string> = {
          'X-Platform': cand.platform,
          'X-Model': cand.model,
          'X-Latency': String(latencyMs),
          'X-Fallback-Count': String(i),
        };

        // 把 OpenAI SSE 翻译成 Gemini SSE
        const geminiStream = translateStreamToGemini(res.body!, cand.model, `gemini-${Date.now()}`, Math.floor(Date.now() / 1000));

        c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));

        return new Response(geminiStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            ...respHeaders,
          },
        });
      } else {
        const errBody = await res.text();
        lastError = { status: res.status, body: errBody };
        continue;
      }
    } catch (e: unknown) {
      lastError = { status: 0, message: e instanceof Error ? e.message : String(e) };
      continue;
    }
  }

  return c.json({ error: { message: `All routes failed: ${JSON.stringify(lastError)}`, code: 'ALL_FAILED' } }, 502);
});

// POST /v1beta/models/{model}:countTokens
geminiRoute.post('/v1beta/models/:model:countTokens', requireUserToken, async (c) => {
  const body = await c.req.json<GeminiCountTokensRequest>();
  let totalTokens = 0;

  for (const content of body.contents || []) {
    for (const part of content.parts || []) {
      if (part.text) {
        totalTokens += Math.ceil(part.text.length / 4);
      }
    }
  }

  return c.json({ totalTokens });
});

// GET /v1beta/models
geminiRoute.get('/v1beta/models', requireUserToken, async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM models WHERE enabled = 1 ORDER BY platform, model_name'
  ).all<{ id: string; platform: string; model_name: string; display_name: string | null; context_window: number | null; supports_tools: number; supports_vision: number }>();

  return c.json({
    models: (rows.results || []).map(m => ({
      name: `models/${m.platform}:${m.model_name}`,
      version: '1',
      displayName: m.display_name || m.model_name,
      description: `${m.platform}/${m.model_name}`,
      inputTokenLimit: m.context_window || 4096,
      outputTokenLimit: 8192,
      supportedGenerationMethods: [
        'generateContent',
        'streamGenerateContent',
        'countTokens',
      ],
      temperature: { min: 0, max: 2, default: 0.7 },
      topP: { min: 0, max: 1, default: 0.95 },
      topK: { min: 1, max: 40, default: 40 },
    })),
  });
});

// GET /v1beta/models/{model}
geminiRoute.get('/v1beta/models/:model', requireUserToken, async (c) => {
  const model = c.req.param('model') || '';

  const m = await c.env.DB.prepare(
    'SELECT * FROM models WHERE id = ? OR model_name = ? AND enabled = 1 LIMIT 1'
  ).bind(model, model).first<{ id: string; platform: string; model_name: string; display_name: string | null; context_window: number | null }>();

  if (!m) {
    return c.json({ error: { message: `Model not found: ${model}`, code: 'NOT_FOUND' } }, 404);
  }

  return c.json({
    name: `models/${m.platform}:${m.model_name}`,
    version: '1',
    displayName: m.display_name || m.model_name,
    description: `${m.platform}/${m.model_name}`,
    inputTokenLimit: m.context_window || 4096,
    outputTokenLimit: 8192,
    supportedGenerationMethods: [
      'generateContent',
      'streamGenerateContent',
      'countTokens',
    ],
  });
});