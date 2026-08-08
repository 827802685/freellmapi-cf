// Embeddings endpoint (OpenAI-compatible)
// POST /v1/embeddings

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { generateChatId, getTimestamp } from '../../lib/crypto';
import type { Env } from '../../types';

interface EmbeddingParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  userId?: string;
}

interface EmbeddingRequest {
  model: string;
  input: string | string[];
  user?: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

/**
 * Handle POST /v1/embeddings
 * Creates embedding vectors for the given input.
 */
export async function handleEmbeddings(params: EmbeddingParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  // Parse request body
  let embeddingRequest: EmbeddingRequest;
  try {
    embeddingRequest = await request.json<EmbeddingRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate required fields
  if (!embeddingRequest.input) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: input', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const model = embeddingRequest.model || 'text-embedding-ada-002';
  const encodingFormat = embeddingRequest.encoding_format || 'float';
  const inputs = Array.isArray(embeddingRequest.input) ? embeddingRequest.input : [embeddingRequest.input];

  if (inputs.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Input must not be empty', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Select a route for embeddings
    const route = await selectRoute(db, cache, model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route for embeddings', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Decrypt the provider API key
    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    // Build the provider request
    const providerPayload: Record<string, unknown> = {
      model: route.model.model_id,
      input: embeddingRequest.input,
      encoding_format: encodingFormat,
    };
    if (embeddingRequest.dimensions !== undefined) {
      providerPayload.dimensions = embeddingRequest.dimensions;
    }

    // Call the provider's embeddings endpoint
    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/embeddings`, {
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

    // Extract usage info
    const usage = (providerData.usage as { prompt_tokens?: number; total_tokens?: number }) || {};
    const promptTokens = usage.prompt_tokens || 0;
    const totalTokens = usage.total_tokens || promptTokens;

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/embeddings',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: promptTokens,
        tokens_completion: 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    // Build OpenAI-compatible response
    const response = {
      object: 'list',
      data: (providerData.data as Array<Record<string, unknown>> || []).map((item, i) => ({
        object: 'embedding',
        index: item.index ?? i,
        embedding: item.embedding,
      })),
      model: model,
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
      },
    };

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