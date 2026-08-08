// Chat Completions endpoint (OpenAI-compatible)
// POST /v1/chat/completions

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { checkRateLimit, trackTokenUsage, getRateLimitHeaders } from '../../lib/rate-limit';
import { generateChatId, getTimestamp } from '../../lib/crypto';
import { compressMessages } from '../../lib/compress';
import type { Env, ChatRequest, ChatResponse, ChatChunk, ChatMessage, ChatChoice, Usage } from '../../types';

interface ChatCompletionParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  userId?: string;
}

/**
 * Handle POST /v1/chat/completions
 */
export async function handleChatCompletion(params: ChatCompletionParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  // Parse request body
  let chatRequest: ChatRequest;
  try {
    chatRequest = await request.json<ChatRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate required fields
  if (!chatRequest.model || !chatRequest.messages || !Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required fields: model and messages', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Compress messages to reduce token usage
  const compressed = compressMessages(chatRequest.messages);
  const messages = compressed.messages;
  const stream = chatRequest.stream ?? false;

  // Select route (provider + model + API key)
  const sessionId = request.headers.get('X-Session-Id') || undefined;
  const route = await selectRoute(db, cache, chatRequest.model, sessionId);

  if (!route) {
    return new Response(
      JSON.stringify({ error: { message: 'No available route for the requested model', type: 'server_error', code: 503 } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check rate limits
  const rateLimitResult = await checkRateLimit(cache, route.provider, route.model.model_id, route.key.id.toString());
  if (!rateLimitResult.allowed) {
    return new Response(
      JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 429 } }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          ...getRateLimitHeaders(rateLimitResult.remaining, rateLimitResult.resetMs),
        },
      }
    );
  }

  // Decrypt the API key data
  const { decryptAESGCM } = await import('../../lib/crypto');
  let apiKeyValue: string;
  try {
    apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Failed to decrypt provider key', type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Build provider adapter params
  const chatParams = {
    model: route.model.model_id,
    messages,
    stream,
    temperature: chatRequest.temperature,
    max_tokens: chatRequest.max_tokens,
    top_p: chatRequest.top_p,
    frequency_penalty: chatRequest.frequency_penalty,
    presence_penalty: chatRequest.presence_penalty,
    tools: chatRequest.tools,
    tool_choice: chatRequest.tool_choice,
    response_format: chatRequest.response_format,
    seed: chatRequest.seed,
    stop: chatRequest.stop,
    apiKey: apiKeyValue,
    baseUrl: route.key.base_url || undefined,
  };

  // Route to provider adapter
  try {
    const adapter = await getProviderAdapter(route.provider, env);

    if (stream) {
      return handleStreamingResponse(adapter, chatParams, route, db, startTime, userId);
    }

    return await handleNonStreamingResponse(adapter, chatParams, route, db, startTime, userId);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Record failed analytics
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/chat/completions',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: Date.now() - startTime,
        tokens_prompt: 0,
        tokens_completion: 0,
        status_code: 502,
        user_id: userId || null,
      })
    );

    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'provider_error', code: 502 } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle non-streaming chat completion response.
 */
async function handleNonStreamingResponse(
  adapter: ProviderAdapter,
  chatParams: ChatParams,
  route: RouteResult,
  db: DB,
  startTime: number,
  userId?: string
): Promise<Response> {
  const response = await adapter.chat(chatParams);
  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errorBody = await response.text();
    return new Response(errorBody, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse the provider response and reformat as OpenAI-compatible
  const providerData = await response.json() as Record<string, unknown>;

  // Extract usage info
  const usage: Usage = extractUsage(providerData);
  const modelId = route.model.model_id;

  // Build OpenAI-compatible response
  const chatResponse: ChatResponse = {
    id: generateChatId(),
    object: 'chat.completion',
    created: getTimestamp(),
    model: modelId,
    choices: extractChoices(providerData, modelId),
    usage,
    provider: route.provider,
  };

  // Track token usage for rate limiting
  await trackTokenUsage(
    new Cache((await import('../../lib/cache')).Cache.prototype.constructor as unknown as KVNamespace),
    route.provider,
    modelId,
    route.key.id.toString(),
    usage.prompt_tokens,
    usage.completion_tokens
  ).catch(() => {});

  // Record analytics (fire-and-forget)
  db.recordAnalytics({
    endpoint: '/v1/chat/completions',
    provider: route.provider,
    model: modelId,
    latency_ms: latencyMs,
    tokens_prompt: usage.prompt_tokens,
    tokens_completion: usage.completion_tokens,
    status_code: 200,
    user_id: userId || null,
  }).catch(() => {});

  return new Response(JSON.stringify(chatResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle streaming chat completion response (SSE).
 */
async function handleStreamingResponse(
  adapter: ProviderAdapter,
  chatParams: ChatParams,
  route: RouteResult,
  db: DB,
  startTime: number,
  userId?: string
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Start the streaming response
  const streamPromise = adapter.chatStream(chatParams);

  // Process the stream in the background
  (async () => {
    try {
      const providerStream = await streamPromise;
      const reader = providerStream.getReader();
      const decoder = new TextDecoder();
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let chunkCount = 0;

      // Write the initial chunk
      const initialChunk: ChatChunk = {
        id: generateChatId(),
        object: 'chat.completion.chunk',
        created: getTimestamp(),
        model: route.model.model_id,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // Parse SSE lines from the provider
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            // Reformat as OpenAI-compatible chunk
            const chunk = transformChunk(parsed, route.model.model_id, initialChunk.id);
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            chunkCount++;

            // Accumulate token counts
            if (parsed.usage) {
              const u = parsed.usage as { prompt_tokens?: number; completion_tokens?: number };
              totalPromptTokens = u.prompt_tokens || 0;
              totalCompletionTokens = u.completion_tokens || 0;
            }
          } catch {
            // Forward raw data if we can't parse it
            await writer.write(encoder.encode(`data: ${data}\n\n`));
          }
        }
      }

      // Write final chunk with usage info
      const finalChunk: ChatChunk = {
        id: initialChunk.id,
        object: 'chat.completion.chunk',
        created: getTimestamp(),
        model: route.model.model_id,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalPromptTokens + totalCompletionTokens,
        },
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));

      // Record analytics (fire-and-forget)
      const latencyMs = Date.now() - startTime;
      db.recordAnalytics({
        endpoint: '/v1/chat/completions',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: totalPromptTokens,
        tokens_completion: totalCompletionTokens,
        status_code: 200,
        user_id: userId || null,
      }).catch(() => {});
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Stream error';
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: errorMessage })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Get a provider adapter instance.
 */
async function getProviderAdapter(provider: string, env: Env): Promise<ProviderAdapter> {
  // Dynamic import of provider adapters
  // Each provider adapter should export a default factory function
  const adapterModule = await import(`../../providers/${provider}`);
  return adapterModule.default(env);
}

/**
 * Extract usage info from provider response.
 */
function extractUsage(data: Record<string, unknown>): Usage {
  const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  if (usage) {
    return {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    };
  }

  // Estimate tokens from content if usage not provided
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  const completionText = choices?.[0]?.message?.content || '';
  const promptTokens = 0; // Can't estimate accurately without original messages
  const completionTokens = Math.ceil(completionText.length / 4);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * Extract choices from provider response, reformatting to OpenAI format.
 */
function extractChoices(data: Record<string, unknown>, modelId: string): ChatChoice[] {
  const choices = data.choices as Array<{
    index?: number;
    message?: Record<string, unknown>;
    finish_reason?: string | null;
    logprobs?: unknown;
  }> | undefined;

  if (choices && Array.isArray(choices)) {
    return choices.map((c, i) => ({
      index: c.index ?? i,
      message: c.message ? normalizeMessage(c.message) : { role: 'assistant', content: '' },
      finish_reason: c.finish_reason ?? null,
      logprobs: c.logprobs ?? null,
    }));
  }

  // Fallback: create a single choice from the raw response
  return [{
    index: 0,
    message: {
      role: 'assistant',
      content: typeof data.content === 'string' ? data.content : JSON.stringify(data),
    },
    finish_reason: null,
  }];
}

/**
 * Normalize a message object to ChatMessage format.
 */
function normalizeMessage(msg: Record<string, unknown>): ChatMessage {
  return {
    role: (msg.role as ChatMessage['role']) || 'assistant',
    content: (msg.content as string | ChatMessage['content']) || '',
    tool_calls: msg.tool_calls as ChatMessage['tool_calls'],
    tool_call_id: msg.tool_call_id as string,
  };
}

/**
 * Transform a provider stream chunk to OpenAI-compatible ChatChunk format.
 */
function transformChunk(
  data: Record<string, unknown>,
  modelId: string,
  chatId: string
): ChatChunk {
  const choices = data.choices as Array<{
    index?: number;
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }> | undefined;

  return {
    id: (data.id as string) || chatId,
    object: 'chat.completion.chunk',
    created: (data.created as number) || getTimestamp(),
    model: modelId,
    choices: (choices || [{ index: 0, delta: {}, finish_reason: null }]).map((c, i) => ({
      index: c.index ?? i,
      delta: {
        role: c.delta?.role as ChatMessage['role'] | undefined,
        content: c.delta?.content as string | undefined,
        tool_calls: c.delta?.tool_calls as ChatMessage['tool_calls'],
      },
      finish_reason: c.finish_reason ?? null,
    })),
  };
}

// Re-export types for convenience
import type { ProviderAdapter, ChatParams } from '../../types';
import type { RouteResult } from '../../lib/router';