// Image generation endpoint (OpenAI-compatible)
// POST /v1/images/generations

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { generateChatId, getTimestamp } from '../../lib/crypto';
import type { Env } from '../../types';

interface ImageGenerationParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  userId?: string;
}

interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  quality?: string;
  response_format?: 'url' | 'b64_json';
  size?: string;
  style?: string;
  user?: string;
}

/**
 * Handle POST /v1/images/generations
 * Basic implementation for compatible providers.
 */
export async function handleImageGeneration(params: ImageGenerationParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  // Parse request body
  let imageRequest: ImageGenerationRequest;
  try {
    imageRequest = await request.json<ImageGenerationRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate required fields
  if (!imageRequest.prompt) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: prompt', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const model = imageRequest.model || 'dall-e-3';
  const n = Math.min(imageRequest.n || 1, 10);
  const size = imageRequest.size || '1024x1024';
  const responseFormat = imageRequest.response_format || 'url';

  try {
    // Select a route for image generation
    const route = await selectRoute(db, cache, model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route for image generation', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Decrypt the provider API key
    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    // Build the provider request
    const providerPayload = {
      model: route.model.model_id,
      prompt: imageRequest.prompt,
      n,
      size,
      response_format: responseFormat,
      quality: imageRequest.quality || 'standard',
      style: imageRequest.style || 'vivid',
    };

    // Call the provider's image generation endpoint
    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/images/generations`, {
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

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/images/generations',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: 0,
        tokens_completion: 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    // Return OpenAI-compatible response
    const response = {
      created: getTimestamp(),
      data: providerData.data || [],
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