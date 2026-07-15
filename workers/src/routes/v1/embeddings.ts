/**
 * /v1/embeddings - 嵌入向量
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { pickRoute, recordKeyResult } from '../../lib/router';
import { getProvider } from '../../providers';
import { err } from '../../lib/response';

export const embeddingsRoute = new Hono<{ Bindings: Env }>();

embeddingsRoute.post('/embeddings', requireUserToken, async (c) => {
  const body = await c.req.json<{
    model: string;
    input: string | string[];
    encoding_format?: 'float' | 'base64';
    user?: string;
  }>();

  // 简化:只走 OpenAI 兼容的嵌入端点(Groq/Mistral/OpenRouter/HF 等)
  // 失败就报错
  const userToken = c.get('userToken' as any);
  const route = await pickRoute(c.env, {
    userTokenId: userToken.id,
    sessionId: null,
    prefersModel: body.model,
  });

  if (route.candidates.length === 0) {
    return err(c, 'No available embedding key', 503, 'no_route');
  }

  for (const cand of route.candidates) {
    // 检查是否支持 embeddings(简化:只有标了 family=embedding 的模型才走)
    // 实际生产中应该按 model 类型分开 fallback
    if (!body.model.includes('embed')) {
      return err(c, `Model ${body.model} is not an embedding model`, 400, 'invalid_model');
    }

    const provider = getProvider(cand.platform, cand.customBaseUrl || undefined);
    try {
      const res = await fetch(`${provider.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cand.keyPlaintext}`,
        },
        body: JSON.stringify(body),
      });
      c.executionCtx.waitUntil(recordKeyResult(c.env, cand.keyId, res.status));
      if (res.ok) {
        return c.json(await res.json());
      }
    } catch {
      continue;
    }
  }

  return err(c, 'All embedding routes failed', 502, 'all_routes_failed');
});
