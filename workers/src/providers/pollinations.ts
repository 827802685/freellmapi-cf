/**
 * Pollinations 适配器
 * 文档: https://gen.pollinations.ai/docs
 *
 * 注意: 2026 年 Pollinations API 已迁移:
 * - 旧版 text.pollinations.ai → 返回 402 (已弃用)
 * - 旧版 enter.pollinations.ai/openai/... → 返回 405 (已弃用)
 * - 新版 gen.pollinations.ai/v1/... (当前生产环境,需要 API key)
 *
 * 参考: https://github.com/pollinations/pollinations/blob/main/APIDOCS.md
 */

import { BaseProvider, ProviderRequest } from './base';
import type { ChatCompletionRequest } from '../types';

export class PollinationsProvider extends BaseProvider {
  name = 'pollinations';
  baseUrl = 'https://gen.pollinations.ai';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // 透传 reasoning_effort(去掉 'auto')
    const { reasoning_effort, ...rest } = req;
    const body: any = { ...rest, model, stream: req.stream };
    if (reasoning_effort && reasoning_effort !== 'auto') {
      body.reasoning_effort = reasoning_effort;
    }
    // gen.pollinations.ai 要求所有请求必须带 API key
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    return {
      url: `${this.baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: any, model: string) {
    // 某些上游(如 LLM7)返回非标准字段,需要归一化
    // 1. reasoning → reasoning_content (DeepSeek 兼容格式)
    if (body?.choices?.[0]?.message) {
      const msg = body.choices[0].message;
      if (msg.reasoning && !msg.reasoning_content) {
        msg.reasoning_content = msg.reasoning;
        delete msg.reasoning;
      }
    }
    return body; // OpenAI 兼容
  }

  async healthCheck(apiKey: string) {
    try {
      // gen.pollinations.ai 要求所有请求必须带 API key
      if (!apiKey) {
        return { ok: false, status: 0, message: 'Pollinations API requires an API key (gen.pollinations.ai)' };
      }
      // 用 chat completion 最小请求测试
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'openai', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      });
      if (res.status === 200 || res.status === 429) return { ok: true, status: res.status };
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: unknown) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
