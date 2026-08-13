/**
 * Cloudflare Workers AI 适配器
 * 走 CF 账户自己的 AI(无需外部 key)
 * 但我们也支持用户用 CF 账户的 API token
 */

import { BaseProvider, ProviderRequest, safeFetch } from './base';
import type { ChatCompletionRequest } from '../types';

interface CfAccountInfo {
  accountId: string;
  apiToken: string;
}

export class CloudflareProvider extends BaseProvider {
  readonly name = 'cloudflare';

  // apiKey 格式: "ACCOUNT_ID:API_TOKEN" 或 "ACCOUNT_ID,API_TOKEN"
  private parseApiKey(apiKey: string): CfAccountInfo | null {
    // 支持冒号和逗号两种分隔符
    const parts = apiKey.split(/[:,]/);
    if (parts.length < 2) return null;
    const accountId = parts[0].trim();
    const token = parts.slice(1).join(':').trim(); // token 本身可能含冒号
    if (!accountId || !token) return null;
    return { accountId, apiToken: token };
  }

  get baseUrl() {
    return ''; // 不固定,每个请求都拼
  }

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    const info = this.parseApiKey(apiKey);
    if (!info) {
      throw new Error('Cloudflare provider requires apiKey in format "ACCOUNT_ID,API_TOKEN"');
    }

    // OpenAI messages -> CF AI 格式
    // 提取图片:CF Workers AI vision 模型接受顶层 image 字段(data URL 或 base64)
    let imageData: string | null = null;
    const messages = req.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }
      // 多模态 content:分离 text 和 image
      const texts: string[] = [];
      for (const p of (m.content || [])) {
        if (p.type === 'text' && p.text) {
          texts.push(p.text);
        } else if (p.type === 'image_url' && p.image_url?.url && !imageData) {
          // CF 接受 data:image/...;base64,... 格式
          imageData = p.image_url.url;
        }
      }
      return { role: m.role, content: texts.join('\n') };
    });

    const body: any = { messages, stream: req.stream };
    // 如果有图片,作为顶层 image 字段传入
    if (imageData) {
      body.image = imageData;
    }

    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${info.accountId}/ai/run/${model}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.apiToken}`,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: any, model: string) {
    // CF AI 响应: { response: "...", tool_calls?: [], ... }
    return {
      id: 'cf-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: body.response || '',
          },
          finish_reason: 'stop',
        },
      ],
    };
  }

  async healthCheck(apiKey: string) {
    const info = this.parseApiKey(apiKey);
    if (!info) return { ok: false, status: 0, message: 'Invalid Cloudflare key format (expected ACCOUNT_ID,API_TOKEN)' };
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${info.accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct-fp8`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${info.apiToken}`,
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        }
      );
      if (res.status === 200) return { ok: true, status: 200 };
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      if (res.status === 429) return { ok: false, status: 429, message: 'Rate limited' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }

  async listModels(apiKey: string): Promise<string[]> {
    const info = this.parseApiKey(apiKey);
    if (!info) return [];
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${info.accountId}/ai/models/search`,
        {
          headers: { Authorization: `Bearer ${info.apiToken}` },
        }
      );
      if (!res.ok) return [];
      const data = await res.json() as { result?: Array<{ id: string; type?: string }> };
      // 只返回文本生成类模型
      return (data.result || [])
        .filter(m => !m.type || m.type === 'chat' || m.type === 'text-generation')
        .map(m => m.id);
    } catch {
      return [];
    }
  }
}
