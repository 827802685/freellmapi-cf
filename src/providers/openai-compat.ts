import {
  ProviderAdapter,
  ChatParams,
  ChatResponse,
  ModelInfo,
  HealthStatus,
  ChatMessage,
  Usage,
} from '../types';

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** Standard CORS headers for all responses. */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/** Return a JSON response with CORS headers. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

/** Return a SSE streaming response. */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders(),
    },
  });
}

/** Generate a unique completion ID. */
export function generateId(prefix = 'chatcmpl'): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${ts}${rand}`;
}

/** Rough token estimation (4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Calculate usage from prompt messages and response text. */
export function calculateUsage(
  messages: ChatMessage[],
  responseText: string,
): Usage {
  const promptText = messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join(' ');
  return {
    prompt_tokens: estimateTokens(promptText),
    completion_tokens: estimateTokens(responseText),
    total_tokens: estimateTokens(promptText) + estimateTokens(responseText),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider adapter
// ---------------------------------------------------------------------------

/**
 * Base adapter for any OpenAI-compatible API endpoint.
 *
 * Subclasses only need to override `name`, `defaultBaseUrl`, and optionally
 * `models()` / `health()`.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
  name: string;
  protected defaultBaseUrl: string;

  constructor(name: string, defaultBaseUrl: string) {
    this.name = name;
    this.defaultBaseUrl = defaultBaseUrl;
  }

  // -----------------------------------------------------------------------
  // Non-streaming chat
  // -----------------------------------------------------------------------

  async chat(params: ChatParams): Promise<Response> {
    try {
      const url = this.buildUrl(params, '/v1/chat/completions');
      const body = this.buildRequestBody(params, false);

      const upstream = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(params),
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!upstream.ok) {
        return this.upstreamErrorResponse(upstream);
      }

      const data = (await upstream.json()) as ChatResponse;
      return jsonResponse(data);
    } catch (err: unknown) {
      return this.catchErrorResponse(err);
    }
  }

  // -----------------------------------------------------------------------
  // Streaming chat
  // -----------------------------------------------------------------------

  async chatStream(params: ChatParams): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildUrl(params, '/v1/chat/completions');
    const body = this.buildRequestBody(params, true);

    const upstream = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(params),
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      throw new Error(
        `[${this.name}] stream error ${upstream.status}: ${errorText}`,
      );
    }

    if (!upstream.body) {
      throw new Error(`[${this.name}] empty response body`);
    }

    return upstream.body;
  }

  // -----------------------------------------------------------------------
  // Models list (override in subclasses)
  // -----------------------------------------------------------------------

  async models(): Promise<ModelInfo[]> {
    return [];
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const url = this.buildUrl({} as ChatParams, '/v1/models');
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
  // Request building helpers
  // -----------------------------------------------------------------------

  /** Build the full request URL. */
  protected buildUrl(params: ChatParams, path: string): string {
    const base = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    return `${base}${path}`;
  }

  /** Build standard Authorization / Content-Type headers. */
  protected buildHeaders(params: ChatParams): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
    };
    return headers;
  }

  /** Build the JSON body for an OpenAI-compatible chat completions request. */
  protected buildRequestBody(
    params: ChatParams,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream,
    };

    // Optional parameters — only include when set.
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
      const value = params[paramKey as keyof ChatParams];
      if (value !== undefined) {
        body[key] = value;
      }
    }

    // Tools & tool_choice
    if (params.tools !== undefined) {
      body.tools = params.tools;
    }
    if (params.tool_choice !== undefined) {
      body.tool_choice = params.tool_choice;
    }

    // Response format
    if (params.response_format !== undefined) {
      body.response_format = params.response_format;
    }

    return body;
  }

  // -----------------------------------------------------------------------
  // Error helpers
  // -----------------------------------------------------------------------

  /** Turn an upstream error response into a structured JSON error. */
  protected async upstreamErrorResponse(upstream: Response): Promise<Response> {
    let details: string;
    try {
      details = await upstream.text();
    } catch {
      details = upstream.statusText;
    }
    return jsonResponse(
      {
        error: {
          message: `[${this.name}] upstream error ${upstream.status}`,
          details,
        },
      },
      upstream.status,
    );
  }

  /** Turn a thrown exception into a 502 JSON error. */
  protected catchErrorResponse(err: unknown): Response {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      {
        error: {
          message: `[${this.name}] request failed: ${message}`,
        },
      },
      502,
    );
  }
}