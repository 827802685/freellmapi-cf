/**
 * AI Horde 适配器
 * 文档: https://aihorde.net/api/
 * 异步工作:提交任务->轮询结果
 * 这里只做最简实现
 *
 * 注意:Horde 不支持 SSE 流式,transformRequest 会强制 stream=false
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
    // body 可能是异步任务提交的返回 { id: "..." },也可能是轮询后的结果 { generations: [...] }
    // 调用方(chat.ts/messages.ts)在非流式模式下会直接 parseResponse
    // 对于异步模式,这里需要处理两种情况
    const text = body.generations?.[0]?.text || body.text || '';
    return {
      id: 'horde-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
    };
  }

  /**
   * 重写:Horde 使用异步任务模式,需要提交任务后轮询结果
   * chat.ts 的标准流程是 fetch → 直接读 body,但 Horde 需要先拿 task_id 再轮询
   * 所以这里提供一个完整的方法来执行请求并获取最终结果
   */
  async executeRequest(
    req: ChatCompletionRequest,
    apiKey: string,
    model: string
  ): Promise<{ status: number; body: any }> {
    const providerReq = this.transformRequest(req, apiKey, model);

    // 1. 提交异步任务
    const submitRes = await fetch(providerReq.url, {
      method: providerReq.method,
      headers: providerReq.headers,
      body: providerReq.body,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => '');
      return { status: submitRes.status, body: { error: { message: errText || `Horde submit failed (${submitRes.status})` } } };
    }

    const taskBody = await submitRes.json() as { id?: string };
    const taskId = taskBody.id;
    if (!taskId) {
      return { status: 500, body: { error: { message: 'Horde did not return task ID' } } };
    }

    // 2. 轮询结果(最多等 60 秒)
    const resultUrl = `${this.baseUrl}/generate/text/status/${taskId}`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['apikey'] = apiKey;

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 每 2 秒轮询一次

      const pollRes = await fetch(resultUrl, { headers });
      if (!pollRes.ok) continue;

      const pollBody = await pollRes.json() as any;

      // 检查是否完成
      if (pollBody.done || pollBody.generations?.length > 0 || pollBody.faulted) {
        if (pollBody.faulted) {
          return { status: 500, body: { error: { message: 'Horde task failed' } } };
        }
        return { status: 200, body: pollBody };
      }
    }

    // 超时
    return { status: 504, body: { error: { message: 'Horde task timed out (60s)' } } };
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
