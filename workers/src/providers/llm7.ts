/**
 * LLM7 适配器
 * 匿名可用(部分模型需要 key)
 * 注意: LLM7 的 endpoint 格式与 Pollinations 不同(没有 /openai/ 前缀)
 * 健康检查: LLM7 需要专门测试 chat/completions 端点,因为 /models 端点可能不可用
 */

import { PollinationsProvider } from './pollinations';
import { BaseProvider, ProviderRequest } from './base';
import type { ChatCompletionRequest } from '../types';

export class Llm7Provider extends PollinationsProvider {
  readonly name = 'llm7';
  readonly baseUrl = 'https://api.llm7.io/v1';

  // LLM7 的端点路径不同(没有 /openai/ 前缀)
  // 同时需要处理:某些模型(如 deepseek-v4-flash)需要 valid API key
  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    const { reasoning_effort, ...rest } = req;
    const body: any = { ...rest, model, stream: req.stream };
    if (reasoning_effort && reasoning_effort !== 'auto') {
      body.reasoning_effort = reasoning_effort;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  // LLM7 的健康检查:用 chat completions 最小请求测试
  // 不能继承 Pollinations 的 healthCheck(因为 base URL 不同)
  async healthCheck(apiKey: string) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      // 匿名请求也支持(部分模型)
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      });
      // 200(成功)或 400(参数问题但 key 有效)都算健康
      if (res.status === 200 || res.status === 400 || res.status === 429) return { ok: true, status: res.status };
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: unknown) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
