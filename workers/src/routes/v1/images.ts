/**
 * /v1/images/generations
 * 简化:直接走 OpenAI 兼容端点(OpenRouter 等)
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireUserToken } from '../../lib/auth';
import { err } from '../../lib/response';

export const imagesRoute = new Hono<{ Bindings: Env }>();

imagesRoute.post('/images/generations', requireUserToken, async (c) => {
  // 简化:用户需要在 dashboard 配置 image provider
  return err(c, 'Image generation requires explicit image provider configuration. Not yet wired in fallback chain.', 501, 'not_implemented');
});
