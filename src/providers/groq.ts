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
// Hardcoded Groq model list
// ---------------------------------------------------------------------------

const GROQ_MODELS: ModelInfo[] = [
  {
    id: 0,
    model_id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    display_name: 'Llama 3.3 70B Versatile',
    context_window: 131_072,
    max_tokens: 32_768,
    supports_vision: 0,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 7,
    reliability_score: 94,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'llama-3.1-8b-instant',
    provider: 'groq',
    display_name: 'Llama 3.1 8B Instant',
    context_window: 131_072,
    max_tokens: 8192,
    supports_vision: 0,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 10,
    reliability_score: 95,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'llama3-70b-8192',
    provider: 'groq',
    display_name: 'Llama 3 70B',
    context_window: 8192,
    max_tokens: 8192,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 6,
    reliability_score: 92,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'llama3-8b-8192',
    provider: 'groq',
    display_name: 'Llama 3 8B',
    context_window: 8192,
    max_tokens: 8192,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 9,
    reliability_score: 93,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'mixtral-8x7b-32768',
    provider: 'groq',
    display_name: 'Mixtral 8x7B',
    context_window: 32_768,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 7,
    reliability_score: 90,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemma2-9b-it',
    provider: 'groq',
    display_name: 'Gemma 2 9B IT',
    context_window: 8192,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 9,
    reliability_score: 91,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemma-7b-it',
    provider: 'groq',
    display_name: 'Gemma 7B IT',
    context_window: 8192,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 4,
    speed_rank: 9,
    reliability_score: 90,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'deepseek-r1-distill-llama-70b',
    provider: 'groq',
    display_name: 'DeepSeek R1 Distill Llama 70B',
    context_window: 131_072,
    max_tokens: 32_768,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 6,
    reliability_score: 88,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'llama-3.2-90b-vision-preview',
    provider: 'groq',
    display_name: 'Llama 3.2 90B Vision Preview',
    context_window: 131_072,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 6,
    reliability_score: 87,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'llama-3.2-11b-vision-preview',
    provider: 'groq',
    display_name: 'Llama 3.2 11B Vision Preview',
    context_window: 131_072,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 6,
    speed_rank: 8,
    reliability_score: 88,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'qwen-2.5-32b',
    provider: 'groq',
    display_name: 'Qwen 2.5 32B',
    context_window: 131_072,
    max_tokens: 8192,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 7,
    reliability_score: 89,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'qwen-2.5-coder-32b',
    provider: 'groq',
    display_name: 'Qwen 2.5 Coder 32B',
    context_window: 131_072,
    max_tokens: 8192,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 7,
    reliability_score: 89,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'deepseek-r1-distill-qwen-32b',
    provider: 'groq',
    display_name: 'DeepSeek R1 Distill Qwen 32B',
    context_window: 131_072,
    max_tokens: 32_768,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 7,
    reliability_score: 87,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'distil-whisper-large-v3-en',
    provider: 'groq',
    display_name: 'Distil Whisper Large v3 EN',
    context_window: 4096,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 0,
    is_enabled: 1,
    intelligence_rank: 1,
    speed_rank: 10,
    reliability_score: 95,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'whisper-large-v3',
    provider: 'groq',
    display_name: 'Whisper Large v3',
    context_window: 4096,
    max_tokens: 4096,
    supports_vision: 0,
    supports_tools: 0,
    supports_streaming: 0,
    is_enabled: 1,
    intelligence_rank: 1,
    speed_rank: 8,
    reliability_score: 94,
    price_hint: 'free',
  },
];

// ---------------------------------------------------------------------------
// Groq adapter
// ---------------------------------------------------------------------------

/**
 * Groq provider adapter.
 *
 * Groq exposes a fully OpenAI-compatible API at `api.groq.com/openai/v1`.
 * This adapter directly forwards requests with minimal transformation.
 */
export class GroqAdapter implements ProviderAdapter {
  name = 'groq';
  private defaultBaseUrl = 'https://api.groq.com/openai/v1';

  // -----------------------------------------------------------------------
  // Non-streaming chat
  // -----------------------------------------------------------------------

  async chat(params: ChatParams): Promise<Response> {
    try {
      const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const url = `${baseUrl}/chat/completions`;
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
              message: `[groq] upstream error ${upstream.status}`,
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
        { error: { message: `[groq] request failed: ${msg}` } },
        502,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Streaming chat
  // -----------------------------------------------------------------------

  async chatStream(params: ChatParams): Promise<ReadableStream<Uint8Array>> {
    const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
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
      throw new Error(`[groq] stream error ${upstream.status}: ${text}`);
    }

    if (!upstream.body) {
      throw new Error('[groq] empty response body');
    }

    return upstream.body;
  }

  // -----------------------------------------------------------------------
  // Models
  // -----------------------------------------------------------------------

  async models(): Promise<ModelInfo[]> {
    return GROQ_MODELS;
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const baseUrl = (this.defaultBaseUrl).replace(/\/+$/, '');
      const url = `${baseUrl}/models`;
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