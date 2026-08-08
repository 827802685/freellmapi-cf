// Audio endpoints (OpenAI-compatible)
// POST /v1/audio/speech (TTS)
// POST /v1/audio/transcriptions (STT)

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { getTimestamp } from '../../lib/crypto';
import type { Env } from '../../types';

interface AudioParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  userId?: string;
}

interface TTSRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
}

interface STTRequest {
  model: string;
  file?: File;
  language?: string;
  prompt?: string;
  response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  temperature?: number;
  timestamp_granularities?: string[];
}

/**
 * Handle POST /v1/audio/speech (Text-to-Speech)
 */
export async function handleTTSSpeech(params: AudioParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  let ttsRequest: TTSRequest;
  try {
    ttsRequest = await request.json<TTSRequest>();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!ttsRequest.input) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: input', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const model = ttsRequest.model || 'tts-1';
  const voice = ttsRequest.voice || 'alloy';
  const responseFormat = ttsRequest.response_format || 'mp3';
  const speed = ttsRequest.speed ?? 1.0;

  try {
    const route = await selectRoute(db, cache, model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route for TTS', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    const providerPayload = {
      model: route.model.model_id,
      input: ttsRequest.input,
      voice,
      response_format: responseFormat,
      speed,
    };

    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/audio/speech`, {
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

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/audio/speech',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: 0,
        tokens_completion: 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    // Return the audio stream
    const contentType = getAudioContentType(responseFormat);
    const audioBuffer = await providerResponse.arrayBuffer();

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': audioBuffer.byteLength.toString(),
      },
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
 * Handle POST /v1/audio/transcriptions (Speech-to-Text)
 */
export async function handleSTTTranscription(params: AudioParams): Promise<Response> {
  const { request, env, ctx, db, cache, userId } = params;
  const startTime = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const model = (formData.get('model') as string) || 'whisper-1';
    const language = formData.get('language') as string | undefined;
    const prompt = formData.get('prompt') as string | undefined;
    const responseFormat = (formData.get('response_format') as string) || 'json';
    const temperature = formData.get('temperature') ? Number(formData.get('temperature')) : undefined;

    if (!file) {
      return new Response(
        JSON.stringify({ error: { message: 'Missing required field: file', type: 'invalid_request_error', code: 400 } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const route = await selectRoute(db, cache, model);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { message: 'No available route for transcription', type: 'server_error', code: 503 } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { decryptAESGCM } = await import('../../lib/crypto');
    const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

    // Forward the form data to the provider
    const providerFormData = new FormData();
    providerFormData.append('file', file, file.name);
    providerFormData.append('model', route.model.model_id);
    if (language) providerFormData.append('language', language);
    if (prompt) providerFormData.append('prompt', prompt);
    providerFormData.append('response_format', responseFormat);
    if (temperature !== undefined) providerFormData.append('temperature', temperature.toString());

    const providerResponse = await fetch(`${route.key.base_url || `https://api.${route.provider}.com/v1`}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKeyValue}`,
      },
      body: providerFormData,
    });

    if (!providerResponse.ok) {
      const errorBody = await providerResponse.text();
      return new Response(errorBody, {
        status: providerResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Record analytics (fire-and-forget)
    const latencyMs = Date.now() - startTime;
    ctx.waitUntil(
      db.recordAnalytics({
        endpoint: '/v1/audio/transcriptions',
        provider: route.provider,
        model: route.model.model_id,
        latency_ms: latencyMs,
        tokens_prompt: 0,
        tokens_completion: 0,
        status_code: 200,
        user_id: userId || null,
      })
    );

    const providerData = await providerResponse.text();
    const contentType = responseFormat === 'json' || responseFormat === 'verbose_json'
      ? 'application/json'
      : 'text/plain';

    return new Response(providerData, {
      status: 200,
      headers: { 'Content-Type': contentType },
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
 * Get the MIME type for a given audio format.
 */
function getAudioContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/L16',
  };
  return mimeTypes[format] || 'audio/mpeg';
}