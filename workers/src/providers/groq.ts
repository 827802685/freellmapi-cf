/**
 * Groq 适配器
 * 完全 OpenAI 兼容,base_url 改成 https://api.groq.com/openai/v1
 */

import { BaseProvider, ProviderRequest, safeFetch, detectProviderError } from './base';
import type { ChatCompletionRequest } from '../types';

export class GroqProvider extends BaseProvider {
  readonly name = 'groq';
  readonly baseUrl = 'https://api.groq.com/openai/v1';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...req, model, stream: req.stream }),
    };
  }

  parseResponse(body: any, model: string) {
    // 已经是 OpenAI 格式
    return body;
  }

  async healthCheck(apiKey: string) {
    try {
      const res = await safeFetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return { ok: res.status === 200, status: res.status, message: res.status === 200 ? undefined : 'Auth failed' };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }
}
