/**
 * AI Horde 适配器
 * 文档: https://aihorde.net/api/
 * 异步工作:提交任务->轮询结果
 * 这里只做最简实现
 */

import { BaseProvider, ProviderRequest, safeFetch } from './base';
import type { ChatCompletionRequest } from '../types';

export class AihordeProvider extends BaseProvider {
  readonly name = 'aihorde';
  readonly baseUrl = 'https://aihorde.net/api/v2';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // Horde 接受 OpenAI-ish 格式
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['apikey'] = apiKey;
    return {
      url: `${this.baseUrl}/generate/text/async`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: req.messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n') + '\nassistant:',
        params: {
          max_context_length: 2048,
          max_length: req.max_tokens || 200,
          temperature: req.temperature ?? 0.7,
        },
        models: [model],
      }),
    };
  }

  parseResponse(body: any, model: string) {
    return {
      id: 'horde-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: body.generations?.[0]?.text || '' },
          finish_reason: 'stop',
        },
      ],
    };
  }

  async healthCheck(_apiKey: string) {
    try {
      const res = await fetch(`${this.baseUrl}/status`, { method: 'GET' });
      if (res.status === 200) return { ok: true, status: 200 };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }
}
