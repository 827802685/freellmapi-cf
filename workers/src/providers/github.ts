/**
 * GitHub Models 适配器
 * 官方端点:https://models.github.ai/inference/  (2025 中期从 models.inference.ai.azure.com 迁移过来)
 * 必须带 Accept: application/vnd.github+json + X-GitHub-Api-Version: 2024-12-01
 * Auth: Authorization: Bearer <GITHUB_TOKEN>  (普通 PAT, 勾 Models: Read 权限)
 */

import { BaseProvider, ProviderRequest, safeFetch } from './base';
import type { ChatCompletionRequest } from '../types';

export class GithubProvider extends BaseProvider {
  readonly name = 'github';
  readonly baseUrl = 'https://models.github.ai/inference';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    return {
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2024-12-01',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...req, model, stream: req.stream }),
    };
  }

  parseResponse(body: any) {
    return body;
  }

  async healthCheck(apiKey: string) {
    try {
      // GitHub Models 的 /models 端点已不稳定(2026-07 即将下线)
      // 改用轻量级 chat completions 请求来检测 key 有效性
      // 注意:用直接 fetch 而非 safeFetch,避免读取 body 导致超时
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2024-12-01',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      // 200 = healthy, 401/403 = invalid, 429 = rate_limited, 其他 = error
      if (res.status === 200) return { ok: true, status: 200 };
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'Invalid key' };
      if (res.status === 429) return { ok: false, status: 429, message: 'Rate limited' };
      return { ok: false, status: res.status, message: `Error (${res.status})` };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }
}
