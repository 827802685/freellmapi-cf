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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return {
      url: `${this.customBaseUrl}/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify({ ...req, model, stream: req.stream }),
    };
  }

  parseResponse(body: any, _model: string) {
    return body; // 假定 OpenAI 兼容
  }

  async healthCheck(apiKey: string) {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(`${this.customBaseUrl}/models`, { method: 'GET', headers });
      return { ok: res.status === 200, status: res.status };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }
}
