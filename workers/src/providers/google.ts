/**
 * Google Gemini 适配器
 * Gemini 用自己的格式,需要双向转换
 * 文档: https://ai.google.dev/api/generate-content
 */

import { BaseProvider, ProviderRequest, safeFetch, detectProviderError } from './base';
import type { ChatCompletionRequest, ChatMessage } from '../types';

export class GoogleProvider extends BaseProvider {
  readonly name = 'google';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  transformRequest(req: ChatCompletionRequest, apiKey: string, model: string): ProviderRequest {
    // OpenAI messages -> Gemini contents
    const contents = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content)
          ? m.content.map(p => ({ text: p.text || '' }))
          : [{ text: m.content || '' }],
      }));

    const systemInstruction = req.messages.find(m => m.role === 'system');

    const body: any = { contents };
    if (systemInstruction && typeof systemInstruction.content === 'string') {
      body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    }
    if (req.temperature !== undefined) body.generationConfig = { ...body.generationConfig, temperature: req.temperature };
    if (req.top_p !== undefined) body.generationConfig = { ...body.generationConfig, topP: req.top_p };
    if (req.max_tokens !== undefined) body.generationConfig = { ...body.generationConfig, maxOutputTokens: req.max_tokens };
    if (req.stop) body.generationConfig = { ...body.generationConfig, stopSequences: Array.isArray(req.stop) ? req.stop : [req.stop] };

    if (req.stream) {
      return {
        url: `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    }

    return {
      url: `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: any, model: string) {
    const cand = body.candidates?.[0];
    if (!cand) {
      return { choices: [] };
    }
    const parts = cand.content?.parts || [];
    const text = parts.map((p: any) => p.text || '').join('');
    return {
      id: 'gemini-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: cand.finishReason === 'STOP' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: body.usageMetadata?.promptTokenCount || 0,
        completion_tokens: body.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: body.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  async healthCheck(apiKey: string) {
    try {
      const res = await safeFetch(`${this.baseUrl}/models?key=${apiKey}`, { method: 'GET' });
      return { ok: res.status === 200, status: res.status };
    } catch (e: any) {
      return { ok: false, status: 0, message: e.message };
    }
  }
}
