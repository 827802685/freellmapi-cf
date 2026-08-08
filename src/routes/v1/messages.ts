// Messages / Responses API (OpenAI Responses API compatible)
// POST /v1/messages
// POST /v1/responses

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { checkRateLimit, getRateLimitHeaders } from '../../lib/rate-limit';
import { generateChatId, getTimestamp } from '../../lib/crypto';
import type { Env, ChatMessage } from '../../types';

interface MessagesParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  userId?: string;
}

interface MessagesRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  metadata?: Record<string, string>;
  store?: boolean;
  previous_response_id?: string;
  instructions?: string;
}

interface ResponsesRequest {
  model: string;
  input: string | ChatMessage | ChatMessage[];
  instructions?: string;
  max_tokens?: number;
  temperature?: number;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
  previous_response_id?: string;
  metadata?: Record<string, string>;
  store?: boolean;
}

/**
 * Handle POST /v1/messages
 * OpenAI Messages API - Create a message (conversation-style).
 */
export async function handleMessagesCreate(params: MessagesParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  let msgRequest: MessagesRequest;
  try {
    msgRequest = await request.json<MessagesRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!msgRequest.model || !msgRequest.messages || !Array.isArray(msgRequest.messages)) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required fields: model and messages', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stream = msgRequest.stream ?? false;

  try {
    const route = await selectRoute(db, cache, msgRequest.model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    // Build provider payload - convert messages format to chat completions format
    const providerPayload: Record<string, unknown> = {
      model: route.model.model_id,
      messages: msgRequest.messages,
      stream,
      max_tokens: msgRequest.max_tokens,
      temperature: msgRequest.temperature,
      top_p: msgRequest.top_p,
    };

    if (msgRequest.tools && msgRequest.tools.length > 0) {
      providerPayload.tools = msgRequest.tools;
    }
    if (msgRequest.instructions) {
      // Prepend instructions as a system message
      const messages = msgRequest.messages;
      messages.unshift({ role: 'system', content: msgRequest.instructions });
      providerPayload.messages = messages;
    }

    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyValue}`,
      },
      body: JSON.stringify(providerPayload),
    });

    if (!providerResponse.ok) {
      const errorBody = await providerResponse.text();
      return new Response(errorBody, {
        status: providerResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const providerData = await providerResponse.json() as Record<string, unknown>;

    // Messages API response format
    const response = {
      id: generateChatId(),
      object: 'message',
      created: getTimestamp(),
      model: route.model.model_id,
      role: 'assistant',
      content: extractContentFromChoices(providerData.choices as Array<Record<string, unknown>> | undefined),
      status: 'completed',
      provider: route.provider,
      usage: providerData.usage || null,
    };

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    const usage = (providerData.usage as { prompt_tokens?: number; completion_tokens?: number }) || {};
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/messages',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: usage.prompt_tokens || 0,
        tokens_completion: usage.completion_tokens || 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'provider_error', code: 502 } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle POST /v1/responses
 * OpenAI Responses API - Create a response.
 */
export async function handleResponsesCreate(params: MessagesParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  let respRequest: ResponsesRequest;
  try {
    respRequest = await request.json<ResponsesRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!respRequest.model || !respRequest.input) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required fields: model and input', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stream = respRequest.stream ?? false;

  try {
    const route = await selectRoute(db, cache, respRequest.model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    // Convert Responses API input to chat messages
    const messages = convertInputToMessages(respRequest.input, respRequest.instructions);

    const providerPayload: Record<string, unknown> = {
      model: route.model.model_id,
      messages,
      stream,
      max_tokens: respRequest.max_tokens,
      temperature: respRequest.temperature,
    };

    if (respRequest.tools && respRequest.tools.length > 0) {
      providerPayload.tools = respRequest.tools;
    }

    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyValue}`,
      },
      body: JSON.stringify(providerPayload),
    });

    if (!providerResponse.ok) {
      const errorBody = await providerResponse.text();
      return new Response(errorBody, {
        status: providerResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const providerData = await providerResponse.json() as Record<string, unknown>;

    // Responses API format
    const response = {
      id: generateChatId(),
      object: 'response',
      created: getTimestamp(),
      model: route.model.model_id,
      output: extractOutputFromChoices(providerData.choices as Array<Record<string, unknown>> | undefined),
      status: 'completed',
      provider: route.provider,
      usage: providerData.usage || null,
    };

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    const usage = (providerData.usage as { prompt_tokens?: number; completion_tokens?: number }) || {};
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/responses',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: usage.prompt_tokens || 0,
        tokens_completion: usage.completion_tokens || 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'provider_error', code: 502 } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Extract content from chat completion choices for Messages API format.
 */
function extractContentFromChoices(choices: Array<Record<string, unknown>> | undefined): Array<{ type: string; text: string }> {
  if (!choices || choices.length === 0) {
    return [{ type: 'text', text: '' }];
  }
  const message = choices[0].message as Record<string, unknown> | undefined;
  const content = (message?.content as string) || '';
  return [{ type: 'text', text: content }];
}

/**
 * Extract output from chat completion choices for Responses API format.
 */
function extractOutputFromChoices(choices: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  if (!choices || choices.length === 0) {
    return [];
  }
  return choices.map((choice, i) => {
    const message = choice.message as Record<string, unknown> | undefined;
    return {
      type: 'message',
      id: `msg_${generateChatId()}`,
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: (message?.content as string) || '',
        },
      ],
      index: i,
    };
  });
}

/**
 * Convert Responses API input format to chat messages.
 */
function convertInputToMessages(
  input: string | ChatMessage | ChatMessage[],
  instructions?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    messages.push(...input);
  } else {
    messages.push(input);
  }

  return messages;
}