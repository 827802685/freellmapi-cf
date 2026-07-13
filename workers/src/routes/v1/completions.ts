/**
 * /v1/completions - 老式 prompt 补全(给 Continue.dev 等用)
 * 翻译成 chat 格式
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { err } from '../../lib/response';

export const completionsRoute = new Hono<{ Bindings: Env }>();

interface LegacyCompletionRequest {
  model: string;
  prompt: string | string[];
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  logprobs?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

completionsRoute.post('/completions', requireUserToken, async (c) => {
  const body = await c.req.json<LegacyCompletionRequest>();

  // 翻译:把 prompt+suffix 变成单条 user 消息
  const promptText = Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt;
  const fullPrompt = body.suffix ? promptText + body.suffix : promptText;

  // 转发到 /v1/chat/completions
  const internal = await fetch(new URL('/v1/chat/completions', c.req.url).toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: c.req.header('Authorization') || '',
    },
    body: JSON.stringify({
      model: body.model,
      messages: [{ role: 'user', content: fullPrompt }],
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop: body.stop,
      stream: false,
    }),
  });

  if (!internal.ok) {
    return c.json(await internal.json(), internal.status as any);
  }

  const chatResp = await internal.json();
  // 把 OpenAI chat 格式反向转成 completions 格式
  const text = chatResp.choices?.[0]?.message?.content || '';
  return c.json({
    id: chatResp.id,
    object: 'text_completion',
    created: chatResp.created,
    model: chatResp.model,
    choices: [
      {
        text,
        index: 0,
        logprobs: null,
        finish_reason: chatResp.choices?.[0]?.finish_reason || 'stop',
      },
    ],
    usage: chatResp.usage,
  });
});
