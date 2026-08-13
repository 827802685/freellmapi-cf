/**
 * 自定义 OpenAI 兼容端点
 * base_url 用户在 dashboard 配置
 */

import { BaseProvider, ProviderRequest } from './base';
import type { ChatCompletionRequest } from '../types';

export class CustomProvider extends BaseProvider {
  readonly name = 'custom';

  constructor(private customBaseUrl: string) {
    super();
  }

  get baseUrl() {
    return this.customBaseUrl;
  }

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // 透传 reasoning_effort(去掉 'auto')
    const { reasoning_effort, ...rest } = req;
    const body: any = { ...rest, model, stream: req.stream };
    if (reasoning_effort && reasoning_effort !== 'auto') {
      body.reasoning_effort = reasoning_effort;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return {
      url: `${this.customBaseUrl}/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: unknown, _model: string) {
    return body; // 假定 OpenAI 兼容
  }

  async healthCheck(apiKey: string) {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(`${this.customBaseUrl}/models`, { method: 'GET', headers });
      return { ok: res.status === 200, status: res.status };
    } catch (e: unknown) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listModels(apiKey: string): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${this.customBaseUrl}/models`, { headers });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string }> };
    return (data.data || []).map(m => m.id);
  }
}
