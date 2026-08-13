/**
 * Groq 适配器
 * 完全 OpenAI 兼容,base_url 改成 https://api.groq.com/openai/v1
 */

import { BaseProvider, ProviderRequest, safeFetch, detectProviderError } from './base';
import type { ChatCompletionRequest } from '../types';

export class GroqProvider extends BaseProvider {
  name = 'groq';
  baseUrl = 'https://api.groq.com/openai/v1';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // 透传 reasoning_effort(去掉 'auto',因为 'auto' 表示不显式传参)
    const { reasoning_effort, ...rest } = req;
    const body: any = { ...rest, model, stream: req.stream };
    if (reasoning_effort && reasoning_effort !== 'auto') {
      body.reasoning_effort = reasoning_effort;
    }
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: any, model: string) {
    // 已经是 OpenAI 格式,reasoning_content 字段会被保留透传
    return body;
  }

  async healthCheck(apiKey: string) {
    try {
      // 用直接 fetch 而非 safeFetch,健康检查只需要状态码不需要 body
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status === 200) return { ok: true, status: 200 };
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      if (res.status === 429) return { ok: false, status: 429, message: 'Rate limited' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }

  async listModels(apiKey: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string }> };
    return (data.data || []).map(m => m.id);
  }
}
