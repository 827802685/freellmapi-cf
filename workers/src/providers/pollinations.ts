/**
 * Pollinations 适配器
 * 匿名即可用,key 可选
 * 文档: https://pollinations.ai/
 */

import { BaseProvider, ProviderRequest } from './base';
import type { ChatCompletionRequest } from '../types';

export class PollinationsProvider extends BaseProvider {
  readonly name = 'pollinations';
  readonly baseUrl = 'https://text.pollinations.ai/openai';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // Pollinations 接受 OpenAI 格式
    const body = JSON.stringify({ ...req, model, stream: req.stream });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers,
      body,
    };
  }

  parseResponse(body: any, model: string) {
    return body; // OpenAI 兼容
  }

  async healthCheck(_apiKey: string) {
    // 匿名可用,健康检查直接 ping
    return { ok: true, status: 200 };
  }
}
