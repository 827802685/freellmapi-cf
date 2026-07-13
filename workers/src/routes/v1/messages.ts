/**
 * /v1/messages - Anthropic Messages API 兼容
 * 让 Claude Code / Anthropic SDK 能直接用
 *
 * 简化实现:把 Anthropic 格式的 messages 翻译成 OpenAI chat 格式,
 * 然后通过 router 转发,响应再翻译回 Anthropic 格式
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { requireUserToken } from '../lib/auth';
import { pickRoute, recordKeyResult, updateStickySession } from '../lib/router';
import { getProvider } from '../providers';
import { err } from '../lib/response';

export const messagesRoute = new Hono<{ Bindings: Env }>();

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; source?: any }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: any[];
  tool_choice?: any;
}

messagesRoute.post('/messages', requireUserToken, async (c) => {
  const start = Date.now();
  const body = await c.req.json<AnthropicRequest>();

  // Anthropic 模型族 -> 我们的模型
  const modelMap: Record<string, string> = {
    'claude-opus-4': 'auto',
    'claude-sonnet-4': 'auto',
    'claude-haiku-4': 'auto',
    'claude-3-5-sonnet': 'auto',
    'claude-3-5-haiku': 'auto',
  };
  let model = body.model;
  if (modelMap[model]) model = modelMap[model];

  // 翻译 messages
  const openaiMessages: any[] = [];
  if (body.system) {
    const sysText = typeof body.system === 'string' ? body.system : body.system.map(s => s.text || '').join('\n');
    openaiMessages.push({ role: 'system', content: sysText });
  }
  for (const m of body.messages) {
    const content = typeof m.content === 'string' ? m.content : m.content.map(p => p.text || '').join('\n');
    openaiMessages.push({ role: m.role, content });
  }

  // 选路
  const userToken = c.get('userToken' as any);
  const sessionId = c.req.header('X-Session-Id') || null;
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId,
    prefersModel: model,
  });

  if (route.candidates.length === 0) {
    return c.json({ type: 'error', error: { type: 'api_error', message: 'No route' } }, 503);
  }

  for (const cand of route.candidates) {
    const provider = getProvider(cand.platform);
    const upstreamReq = provider.transformRequest(
      {
        ...body,
        model: cand.model,
        max_tokens: body.max_tokens,
        stop: body.stop_sequences,
        messages: openaiMessages,
        stream: false,
      },
      cand.keyPlaintext,
      cand.model
    );

    try {
      const res = await fetch(upstreamReq.url, {
        method: upstreamReq.method,
        headers: upstreamReq.headers,
        body: upstreamReq.body,
      });
      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status));
      if (res.ok) {
        const chat = provider.parseResponse(await res.json(), cand.model);
        const text = chat.choices?.[0]?.message?.content || '';

        c.executionCtx.waitUntil(updateStickySession(c.env, sessionId, cand.platform, cand.model));
        c.executionCtx.waitUntil(
          c.env.DB.prepare(
            'INSERT INTO request_logs (user_token_id, model, platform, key_id, status_code, latency_ms, stream, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, unixepoch())'
          ).bind(userToken.id, cand.model, cand.platform, cand.keyId, res.status, Date.now() - start).run()
        );

        // 转回 Anthropic 格式
        return c.json({
          id: 'msg_' + Date.now(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text }],
          model: body.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: chat.usage?.prompt_tokens || 0,
            output_tokens: chat.usage?.completion_tokens || 0,
          },
        });
      }
    } catch {
      continue;
    }
  }

  return c.json({ type: 'error', error: { type: 'api_error', message: 'All routes failed' } }, 502);
});

messagesRoute.post('/messages/count_tokens', requireUserToken, async (c) => {
  // 简化:返回估算
  const body = await c.req.json<{ messages: AnthropicMessage[]; system?: string }>();
  let total = 0;
  for (const m of body.messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    total += Math.ceil(text.length / 4);
  }
  if (body.system) total += Math.ceil((typeof body.system === 'string' ? body.system : '').length / 4);
  return c.json({ input_tokens: total });
});
