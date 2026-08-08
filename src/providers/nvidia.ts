import {
  ProviderAdapter,
  ChatParams,
  ChatMessage,
  ChatResponse,
  ChatChoice,
  ModelInfo,
  HealthStatus,
  Usage,
} from '../types';
import {
  corsHeaders,
  jsonResponse,
  sseResponse,
  generateId,
  estimateTokens,
  calculateUsage,
} from './openai-compat';

// ---------------------------------------------------------------------------
// Hardcoded NVIDIA NIM model list
// ---------------------------------------------------------------------------

const NVIDIA_MODELS: ModelInfo[] = [
  {
    id: 0,
    model_id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    provider: 'nvidia',
    display_name: 'Llama 3.1 Nemotron 70B Instruct',
    context_window: 131_072,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 5,
    reliability_score: 90,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'nvidia/nemotron-4-340b-instruct',
    provider: 'nvidia',
    display_name: 'Nemotron 4 340B Instruct',
    context_window: 4096,
    max_tokens: 1024,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 9,
    speed_rank: 3,
    reliability_score: 88,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'meta/llama-3.1-405b-instruct',
    provider: 'nvidia',
    display_name: 'Llama 3.1 405B Instruct',
    context_window: 131_072,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 9,
    speed_rank: 4,
    reliability_score: 92,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'meta/llama-3.1-70b-instruct',
    provider: 'nvidia',
    display_name: 'Llama 3.1 70B Instruct',
    context_window: 131_072,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 6,
    reliability_score: 93,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'meta/llama-3.1-8b-instruct',
    provider: 'nvidia',
    display_name: 'Llama 3.1 8B Instruct',
    context_window: 131_072,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 9,
    reliability_score: 94,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'mistralai/mistral-7b-instruct-v0.3',
    provider: 'nvidia',
    display_name: 'Mistral 7B Instruct v0.3',
    context_window: 32_768,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 9,
    reliability_score: 90,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'mistralai/mixtral-8x22b-instruct-v0.1',
    provider: 'nvidia',
    display_name: 'Mixtral 8x22B Instruct v0.1',
    context_window: 65_536,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 5,
    reliability_score: 89,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'google/gemma-2-27b-it',
    provider: 'nvidia',
    display_name: 'Gemma 2 27B IT',
    context_window: 8192,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 6,
    speed_rank: 7,
    reliability_score: 88,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'google/gemma-2-9b-it',
    provider: 'nvidia',
    display_name: 'Gemma 2 9B IT',
    context_window: 8192,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 9,
    reliability_score: 90,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'microsoft/phi-3-mini-4k-instruct',
    provider: 'nvidia',
    display_name: 'Phi 3 Mini 4K Instruct',
    context_window: 4096,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 4,
    speed_rank: 10,
    reliability_score: 88,
    price_hint: 'free',
  },
];

// ---------------------------------------------------------------------------
// NVIDIA NIM adapter
// ---------------------------------------------------------------------------

/**
 * NVIDIA NIM adapter.
 *
 * NVIDIA NIM (NVIDIA Inference Microservices) exposes an OpenAI-compatible
 * chat completions endpoint at `api.nvcf.nvidia.com/v1`.
 *
 * The API key is passed via the `Authorization: Bearer` header (NVCF API key)
 * or via the `NVCF_API_KEY` / `NGC_API_KEY` convention.
 */
export class NvidiaAdapter implements ProviderAdapter {
  name = 'nvidia';
  private defaultBaseUrl = 'https://api.nvcf.nvidia.com/v1';

  // -----------------------------------------------------------------------
  // Non-streaming chat
  // -----------------------------------------------------------------------

  async chat(params: ChatParams): Promise<Response> {
    try {
      const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const url = `${baseUrl}/v1/chat/completions`;
      const body = this.buildRequestBody(params, false);

      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        return jsonResponse(
          {
            error: {
              message: `[nvidia] upstream error ${upstream.status}`,
              details: text,
            },
          },
          upstream.status,
        );
      }

      const data = await upstream.json();
      return jsonResponse(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        { error: { message: `[nvidia] request failed: ${msg}` } },
        502,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Streaming chat
  // -----------------------------------------------------------------------

  async chatStream(params: ChatParams): Promise<ReadableStream<Uint8Array>> {
    const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/chat/completions`;
    const body = this.buildRequestBody(params, true);

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      throw new Error(`[nvidia] stream error ${upstream.status}: ${text}`);
    }

    if (!upstream.body) {
      throw new Error('[nvidia] empty response body');
    }

    return upstream.body;
  }

  // -----------------------------------------------------------------------
  // Models
  // -----------------------------------------------------------------------

  async models(): Promise<ModelInfo[]> {
    return NVIDIA_MODELS;
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const baseUrl = (this.defaultBaseUrl).replace(/\/+$/, '');
      const url = `${baseUrl}/v1/models`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer placeholder' },
      });
      return {
        provider: this.name,
        ok: resp.ok,
        latency_ms: Date.now() - start,
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (err: unknown) {
      return {
        provider: this.name,
        ok: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -----------------------------------------------------------------------
  // Request building
  // -----------------------------------------------------------------------

  private buildRequestBody(
    params: ChatParams,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream,
    };

    const optionalFields: [string, string][] = [
      ['temperature', 'temperature'],
      ['max_tokens', 'max_tokens'],
      ['top_p', 'top_p'],
      ['frequency_penalty', 'frequency_penalty'],
      ['presence_penalty', 'presence_penalty'],
      ['seed', 'seed'],
      ['stop', 'stop'],
      ['user', 'user'],
    ];

    for (const [key, paramKey] of optionalFields) {
      const val = params[paramKey as keyof ChatParams];
      if (val !== undefined) body[key] = val;
    }

    if (params.tools) body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;
    if (params.response_format) body.response_format = params.response_format;

    return body;
  }
}