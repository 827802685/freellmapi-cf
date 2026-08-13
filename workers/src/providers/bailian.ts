/**
 * 阿里云百炼 (DashScope) 适配器
 * OpenAI 兼容模式,base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
 * 免费额度: 仅华北2(北京)地域+中国内地部署范围的模型享有
 */

import { BaseProvider, ProviderRequest } from './base';
import type { ChatCompletionRequest } from '../types';

export class BailianProvider extends BaseProvider {
  readonly name = 'bailian';
  readonly baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // 透传 reasoning_effort(去掉 'auto')
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
    // 已经是 OpenAI 兼容格式
    return body;
  }

  async healthCheck(apiKey: string) {
    try {
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
