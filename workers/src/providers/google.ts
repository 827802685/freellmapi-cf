/**
 * Google Gemini 适配器
 * Gemini 用自己的格式,需要双向转换
 * 文档: https://ai.google.dev/api/generate-content
 */

import { BaseProvider, ProviderRequest, safeFetch, detectProviderError } from './base';
import type { ChatCompletionRequest, ChatMessage, ChatContentPart } from '../types';

export class GoogleProvider extends BaseProvider {
  readonly name = 'google';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  /**
   * 判断模型是否需要使用 Interactions API
   * deep-research-*, antigravity-*, gemini-omni-flash-preview 等模型
   * 使用旧的 generateContent 端点会返回 "This model only supports Interactions API" 错误
   */
  private needsInteractionsApi(model: string): boolean {
    return model.startsWith('deep-research-') ||
           model.startsWith('antigravity-') ||
           model === 'gemini-omni-flash-preview';
  }

  /**
   * 把 OpenAI 格式的 content part 转为 Gemini parts
   * - text → { text }
   * - image_url(data:URL) → { inlineData: { mimeType, data } }
   * - image_url(http URL) → { fileData: { mimeType, fileUri } }
   */
  private contentPartsToGeminiParts(content: string | ChatContentPart[]): Record<string, unknown>[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }
    return content.map((part): Record<string, unknown> => {
      if (part.type === 'text') {
        return { text: part.text || '' };
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        // data:image/jpeg;base64,/9j/4AAQ...
        const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataMatch) {
          return {
            inlineData: {
              mimeType: dataMatch[1],
              data: dataMatch[2],
            },
          };
        }
        // http(s) URL — Gemini 支持 fileData(fileUri + mimeType)
        // 注意:Gemini fileData 的 fileUri 需要是 Google Cloud Storage 或 Gemini File API 的 URI
        // 普通 http URL 可能不被支持,但先传给 Gemini 让它报错
        const mimeFromExt = url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i);
        const mimeType = mimeFromExt
          ? { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[mimeFromExt[1].toLowerCase()] || 'image/jpeg'
          : 'image/jpeg';
        return {
          fileData: {
            mimeType,
            fileUri: url,
          },
        };
      }
      return { text: '' };
    });
  }

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // Interactions API 模型走单独的端点
    if (this.needsInteractionsApi(model)) {
      return this.transformInteractionsRequest(req, apiKey, model);
    }

    // OpenAI messages -> Gemini contents(支持多模态:图片转 inlineData/fileData)
    const contents = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: this.contentPartsToGeminiParts(m.content as string | ChatContentPart[]),
      }));

    const systemInstruction = req.messages.find(m => m.role === 'system');

    const body: any = { contents };
    if (systemInstruction) {
      const sysText = typeof systemInstruction.content === 'string'
        ? systemInstruction.content
        : (systemInstruction.content || []).map(p => p.text || '').join('\n');
      if (sysText) body.systemInstruction = { parts: [{ text: sysText }] };
    }
    if (req.temperature !== undefined) body.generationConfig = { ...body.generationConfig, temperature: req.temperature };
    if (req.top_p !== undefined) body.generationConfig = { ...body.generationConfig, topP: req.top_p };
    if (req.max_tokens !== undefined) body.generationConfig = { ...body.generationConfig, maxOutputTokens: req.max_tokens };
    if (req.stop) body.generationConfig = { ...body.generationConfig, stopSequences: Array.isArray(req.stop) ? req.stop : [req.stop] };

    // 推理模式:Gemini 用 thinkingConfig.thinkingBudget
    if (req.reasoning_effort && req.reasoning_effort !== 'auto') {
      const budgetMap: Record<string, number> = {
        minimal: 0, low: 2048, medium: 8192, high: 24576,
      };
      const budget = budgetMap[req.reasoning_effort];
      if (budget !== undefined) {
        body.generationConfig = { ...body.generationConfig, thinkingConfig: { thinkingBudget: budget } };
      }
    }

    if (req.stream) {
      return {
        url: `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    }

    return {
      url: `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  /**
   * Interactions API 请求转换 (consumer API: generativelanguage.googleapis.com)
   *
   * 官方文档: https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
   * 端点: POST /v1beta/interactions?key=API_KEY
   *
   * 请求体格式(官方 REST 示例):
   * {
   *   "model": "gemini-3.5-flash",
   *   "input": "user message text",
   *   "stream": true/false,
   *   "generation_config": {
   *     "max_output_tokens": 8192,
   *     "thinking_level": "medium",
   *     "temperature": 0.7,
   *     "top_p": 0.9,
   *     "stop_sequences": ["..."]
   *   }
   * }
   *
   * 注意:
   * - 使用 "model" 字段名,不是 "agent"(agent 是 managed agent 专用)
   * - 参数放在 generation_config 内,使用 snake_case(符合 REST API 规范)
   * - temperature/top_p 在 Gemini 3.x 中已不推荐,但保持兼容
   * - 使用 thinking_level 替代 thinking_budget(3.x 不推荐 thinking_budget)
   */
  private transformInteractionsRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // 取最后一条 user 消息作为 input(Interactions API 是 stateful 的,传全部历史会有问题)
    const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user');
    const inputText = lastUserMsg
      ? (typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : (lastUserMsg.content as ChatContentPart[]).map(p => p.text || '').join('\n'))
      : '';

    const body: any = {
      model,
      input: inputText,
      stream: !!req.stream,
    };

    // 构建 generation_config (snake_case for REST)
    const gc: Record<string, unknown> = {};

    // max_tokens → max_output_tokens
    if (req.max_tokens !== undefined) gc.max_output_tokens = req.max_tokens;

    // temperature/top_p 在 Gemini 3.x 不推荐,但保留兼容
    if (req.temperature !== undefined) gc.temperature = req.temperature;
    if (req.top_p !== undefined) gc.top_p = req.top_p;

    // stop → stop_sequences
    if (req.stop) {
      gc.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }

    // reasoning_effort → thinking_level (Gemini 3.x 推荐方式)
    if (req.reasoning_effort && req.reasoning_effort !== 'auto') {
      gc.thinking_level = req.reasoning_effort;
    }

    // 如果有 generation_config 参数,才设置
    if (Object.keys(gc).length > 0) {
      body.generation_config = gc;
    }

    // system instruction
    const systemInstruction = req.messages.find(m => m.role === 'system');
    if (systemInstruction) {
      const sysText = typeof systemInstruction.content === 'string'
        ? systemInstruction.content
        : (systemInstruction.content || []).map(p => p.text || '').join('\n');
      if (sysText) {
        body.system_instruction = sysText;
      }
    }

    return {
      url: `${this.baseUrl}/interactions?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: unknown, model: string) {
    const data = body as Record<string, unknown> | undefined | null;

    // Interactions API 响应格式: 包含 outputs 数组(官方格式)或 steps 数组(旧格式)
    if (data?.outputs) {
      return this.parseInteractionsResponse(data, model);
    }
    if (data?.steps) {
      return this.parseInteractionsResponse(data, model);
    }

    // 原有的 generateContent 响应格式
    const candidates = data?.candidates as Array<Record<string, unknown>> | undefined;
    const cand = candidates?.[0];
    if (!cand) {
      return { choices: [] };
    }
    const parts = (cand.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined || [];
    // 分离 text parts 和 thought parts(Gemini 2.5 Thinking 模型会返回 thought=true 的 parts)
    let text = '';
    let reasoning = '';
    for (const p of parts) {
      if (p.thought) {
        reasoning += (p.text as string) || '';
      } else {
        text += (p.text as string) || '';
      }
    }
    const usageMeta = data?.usageMetadata as Record<string, unknown> | undefined;
    const result: any = {
      id: 'gemini-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: (cand.finishReason as string) === 'STOP' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: (usageMeta?.promptTokenCount as number) || 0,
        completion_tokens: (usageMeta?.candidatesTokenCount as number) || 0,
        total_tokens: (usageMeta?.totalTokenCount as number) || 0,
      },
    };
    // 如果有推理内容,加到 message 上(DeepSeek 兼容的 reasoning_content 字段)
    if (reasoning) {
      result.choices[0].message.reasoning_content = reasoning;
    }
    return result;
  }

  /**
   * 解析 Interactions API 非流式响应
   *
   * 官方格式 (Google Gemini API):
   * {
   *   "id": "interaction-xxx",
   *   "status": "completed",
   *   "outputs": [
   *     {"type": "text", "text": "Hello"},
   *     {"type": "thought", "text": "thinking..."}
   *   ],
   *   "usage": {"total_input_tokens": 10, "total_output_tokens": 20, "total_tokens": 30}
   * }
   *
   * 旧格式 (自定义):
   * {
   *   "steps": [
   *     {"type": "thought", "content": {...}},
   *     {"type": "model_output", "content": {"role": "model", "parts": [{"text": "Hello"}]}}
   *   ],
   *   ...
   * }
   */
  private parseInteractionsResponse(data: Record<string, unknown>, model: string): any {
    let text = '';
    let reasoning = '';

    // 官方格式: outputs 数组
    const outputs = data.outputs as Array<Record<string, unknown>> || [];
    if (outputs.length > 0) {
      for (const output of outputs) {
        const type = output.type as string;
        const outputText = (output.text as string) || '';
        if (type === 'thought') {
          reasoning += outputText;
        } else if (type === 'text' || type === 'model_output') {
          text += outputText;
        }
      }
    }

    // 旧格式: steps 数组
    const steps = data.steps as Array<Record<string, unknown>> || [];
    if (steps.length > 0 && !text && !reasoning) {
      for (const step of steps) {
        if (step.type === 'model_output') {
          const content = step.content as Record<string, unknown> || {};
          const parts = content.parts as Array<Record<string, unknown>> || [];
          text = parts.map(p => (p.text as string) || '').join('');
        } else if (step.type === 'thought') {
          const content = step.content as Record<string, unknown> || {};
          if (content.parts) {
            const parts = content.parts as Array<Record<string, unknown>> || [];
            reasoning = parts.map(p => (p.text as string) || '').join('');
          } else if (content.text) {
            reasoning = content.text as string;
          }
        }
      }
    }

    const usage = data.usage as Record<string, unknown> | undefined;

    const result: any = {
      id: (data.id as string) || 'interaction-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: data.status === 'completed' ? 'stop' : 'length',
      }],
      usage: {
        prompt_tokens: (usage?.total_input_tokens as number) || 0,
        completion_tokens: (usage?.total_output_tokens as number) || 0,
        total_tokens: (usage?.total_tokens as number) || 0,
      },
    };

    if (reasoning) {
      result.choices[0].message.reasoning_content = reasoning;
    }

    return result;
  }

  async healthCheck(apiKey: string) {
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${apiKey}`, { method: 'GET' });
      if (res.status === 200) {
        // 额外验证 interactions API 端点是否可访问
        // 发送一个最小请求,预期返回 400(无效参数)而非 401/403
        try {
          const interactionsRes = await fetch(`${this.baseUrl}/interactions?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gemini-3.5-flash', input: 'test', stream: false }),
          });
          if (interactionsRes.status === 401 || interactionsRes.status === 403) {
            return { ok: false, status: interactionsRes.status, message: 'Key not valid for interactions API' };
          }
        } catch {
          // interactions 端点测试失败不影响主健康检查结果
        }
        return { ok: true, status: 200 };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      if (res.status === 429) return { ok: false, status: 429, message: 'Rate limited' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: unknown) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listModels(apiKey: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models?key=${apiKey}`);
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
    return (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent') ||
                   m.supportedGenerationMethods?.includes('interactions'))
      .map(m => m.name.replace(/^models\//, ''));
  }
}
