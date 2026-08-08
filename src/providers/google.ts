import {
  ProviderAdapter,
  ChatParams,
  ChatMessage,
  ContentPart,
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
} from './openai-compat';

// ---------------------------------------------------------------------------
// Types for the Gemini API
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
  tools?: GeminiTool[];
}

interface GeminiTool {
  functionDeclarations: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }[];
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
    safetyRatings?: unknown[];
  }[];
  promptFeedback?: unknown;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiStreamChunk {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Hardcoded Gemini model list
// ---------------------------------------------------------------------------

const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 0,
    model_id: 'gemini-2.0-flash',
    provider: 'google',
    display_name: 'Gemini 2.0 Flash',
    context_window: 1_048_576,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 9,
    reliability_score: 95,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-2.0-flash-lite',
    provider: 'google',
    display_name: 'Gemini 2.0 Flash Lite',
    context_window: 1_048_576,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 5,
    speed_rank: 10,
    reliability_score: 95,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-1.5-flash',
    provider: 'google',
    display_name: 'Gemini 1.5 Flash',
    context_window: 1_048_576,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 6,
    speed_rank: 9,
    reliability_score: 93,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-1.5-flash-8b',
    provider: 'google',
    display_name: 'Gemini 1.5 Flash 8B',
    context_window: 1_048_576,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 4,
    speed_rank: 10,
    reliability_score: 92,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-1.5-pro',
    provider: 'google',
    display_name: 'Gemini 1.5 Pro',
    context_window: 2_097_152,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 9,
    speed_rank: 6,
    reliability_score: 94,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-2.5-pro-exp-03-25',
    provider: 'google',
    display_name: 'Gemini 2.5 Pro (experimental)',
    context_window: 1_048_576,
    max_tokens: 65_536,
    supports_vision: 1,
    supports_tools: 1,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 10,
    speed_rank: 5,
    reliability_score: 88,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'gemini-2.0-flash-thinking-exp-01-21',
    provider: 'google',
    display_name: 'Gemini 2.0 Flash Thinking (experimental)',
    context_window: 1_048_576,
    max_tokens: 65_536,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 8,
    speed_rank: 7,
    reliability_score: 85,
    price_hint: 'free',
  },
  {
    id: 0,
    model_id: 'learnlm-1.5-pro-experimental',
    provider: 'google',
    display_name: 'LearnLM 1.5 Pro (experimental)',
    context_window: 1_048_576,
    max_tokens: 8192,
    supports_vision: 1,
    supports_tools: 0,
    supports_streaming: 1,
    is_enabled: 1,
    intelligence_rank: 7,
    speed_rank: 6,
    reliability_score: 80,
    price_hint: 'free',
  },
];

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

export class GoogleAdapter implements ProviderAdapter {
  name = 'google';
  private defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  // -----------------------------------------------------------------------
  // Non-streaming chat
  // -----------------------------------------------------------------------

  async chat(params: ChatParams): Promise<Response> {
    try {
      const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const model = params.model;
      const url = `${baseUrl}/models/${model}:generateContent?key=${params.apiKey}`;

      const geminiReq = this.toGeminiRequest(params);
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiReq),
        signal: params.signal,
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        return jsonResponse(
          {
            error: {
              message: `[google] upstream error ${upstream.status}`,
              details: text,
            },
          },
          upstream.status,
        );
      }

      const geminiResp = (await upstream.json()) as GeminiResponse;
      const openaiResp = this.toOpenAIResponse(geminiResp, model);
      return jsonResponse(openaiResp);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        { error: { message: `[google] request failed: ${msg}` } },
        502,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Streaming chat
  // -----------------------------------------------------------------------

  async chatStream(params: ChatParams): Promise<ReadableStream<Uint8Array>> {
    const baseUrl = (params.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = params.model;
    const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${params.apiKey}`;

    const geminiReq = this.toGeminiRequest(params);
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiReq),
      signal: params.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      throw new Error(`[google] stream error ${upstream.status}: ${text}`);
    }

    if (!upstream.body) {
      throw new Error('[google] empty response body');
    }

    // Translate Gemini SSE chunks to OpenAI SSE format
    return this.translateStream(upstream.body, model);
  }

  // -----------------------------------------------------------------------
  // Models
  // -----------------------------------------------------------------------

  async models(): Promise<ModelInfo[]> {
    return GEMINI_MODELS;
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const baseUrl = this.defaultBaseUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/models?key=placeholder`;
      const resp = await fetch(url, { method: 'GET' });
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
  // Format translation: OpenAI -> Gemini
  // -----------------------------------------------------------------------

  private toGeminiRequest(params: ChatParams): GeminiRequest {
    const { systemMessage, contents } = this.splitMessages(params.messages);
    const req: GeminiRequest = { contents };

    if (systemMessage) {
      req.systemInstruction = { parts: [{ text: systemMessage }] };
    }

    const config: GeminiRequest['generationConfig'] = {};
    if (params.temperature !== undefined) config.temperature = params.temperature;
    if (params.max_tokens !== undefined) config.maxOutputTokens = params.max_tokens;
    if (params.top_p !== undefined) config.topP = params.top_p;
    if (params.stop !== undefined) {
      config.stopSequences = Array.isArray(params.stop) ? params.stop : [params.stop];
    }
    if (Object.keys(config).length > 0) {
      req.generationConfig = config;
    }

    // Tools
    if (params.tools && params.tools.length > 0) {
      req.tools = params.tools.map((t) => ({
        functionDeclarations: [
          {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        ],
      }));
    }

    return req;
  }

  /** Split ChatMessage[] into a system message string and Gemini contents array. */
  private splitMessages(messages: ChatMessage[]): {
    systemMessage: string | undefined;
    contents: GeminiContent[];
  } {
    let systemMessage: string | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = typeof msg.content === 'string' ? msg.content : '';
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text || '' });
          } else if (part.type === 'image_url' && part.image_url) {
            // Extract base64 data from data: URI
            const dataUri = part.image_url.url;
            const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            } else {
              parts.push({ text: `[Image: ${dataUri}]` });
            }
          }
        }
      }

      // Tool calls from assistant
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}'),
            },
          });
        }
      }

      // Tool response
      if (msg.role === 'tool' && msg.tool_call_id) {
        parts.push({
          functionResponse: {
            name: msg.name || msg.tool_call_id,
            response: {
              content: typeof msg.content === 'string' ? msg.content : '',
              name: msg.name || msg.tool_call_id,
            },
          },
        });
      }

      contents.push({ role, parts });
    }

    return { systemMessage, contents };
  }

  // -----------------------------------------------------------------------
  // Format translation: Gemini -> OpenAI
  // -----------------------------------------------------------------------

  private toOpenAIResponse(gemini: GeminiResponse, model: string): ChatResponse {
    const id = generateId();
    const now = Math.floor(Date.now() / 1000);
    const choices: ChatChoice[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    if (gemini.usageMetadata) {
      promptTokens = gemini.usageMetadata.promptTokenCount ?? 0;
      completionTokens = gemini.usageMetadata.candidatesTokenCount ?? 0;
    }

    if (gemini.candidates) {
      for (let i = 0; i < gemini.candidates.length; i++) {
        const cand = gemini.candidates[i];
        const content = cand?.content;
        const text = content?.parts?.map((p) => p.text || '').join('') || '';
        const finishReason = this.mapFinishReason(cand?.finishReason);

        choices.push({
          index: i,
          message: {
            role: 'assistant',
            content: text,
          },
          finish_reason: finishReason,
        });
      }
    }

    if (choices.length === 0) {
      choices.push({
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      });
    }

    return {
      id,
      object: 'chat.completion',
      created: now,
      model,
      choices,
      usage: {
        prompt_tokens: promptTokens || estimateTokens(''),
        completion_tokens: completionTokens || estimateTokens(''),
        total_tokens: (promptTokens || 0) + (completionTokens || 0),
      },
      provider: 'google',
    };
  }

  private mapFinishReason(
    geminiReason: string | undefined,
  ): 'stop' | 'length' | 'content_filter' | 'tool_calls' | null {
    switch (geminiReason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
        return 'content_filter';
      case 'RECITATION':
        return 'content_filter';
      case 'TOOL_CALL':
        // tool_calls finish_reason is not standard in OpenAI, but we map it
        return 'tool_calls' as unknown as 'stop';
      default:
        return null;
    }
  }

  // -----------------------------------------------------------------------
  // Stream translation: Gemini SSE -> OpenAI SSE
  // -----------------------------------------------------------------------

  private translateStream(
    upstream: ReadableStream<Uint8Array>,
    model: string,
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let isFirst = true;
    const id = generateId();
    const created = Math.floor(Date.now() / 1000);
    const self = this;

    return new ReadableStream({
      async pull(controller) {
        const reader = upstream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer));
              }
              // Send final [DONE] signal
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                controller.enqueue(encoder.encode('\n'));
                continue;
              }

              // Gemini SSE lines: `data: {...}`
              // Some may also include `data: ` prefix already
              let raw = trimmed;
              if (raw.startsWith('data: ')) {
                raw = raw.slice(6);
              }

              // Skip non-data lines
              if (!raw.startsWith('{')) continue;

              try {
                const chunk = JSON.parse(raw) as GeminiStreamChunk;
                const openaiChunk = self.toOpenAIChunk(chunk, model, id, created, isFirst);
                isFirst = false;

                if (openaiChunk) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`),
                  );
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.error(new Error(`[google] stream error: ${msg}`));
        }
      },
    });
  }

  private toOpenAIChunk(
    chunk: GeminiStreamChunk,
    model: string,
    id: string,
    created: number,
    isFirst: boolean,
  ): Record<string, unknown> | null {
    if (!chunk.candidates || chunk.candidates.length === 0) {
      // Possibly a usage-only chunk
      if (chunk.usageMetadata) {
        return {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: null,
            },
          ],
          usage: {
            prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
          },
        };
      }
      return null;
    }

    const cand = chunk.candidates[0];
    const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
    const finishReason = this.mapFinishReason(cand?.finishReason);

    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: isFirst ? 'assistant' : undefined,
            content: text || undefined,
          },
          finish_reason: finishReason,
        },
      ],
    };
  }
}