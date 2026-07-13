/**
 * /v1/models - 列出所有可用模型
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { requireUserToken } from '../lib/auth';

export const modelsRoute = new Hono<{ Bindings: Env }>();

modelsRoute.get('/models', requireUserToken, async (c) => {
  // 决定格式:Anthropic 客户端发 anthropic-version,返回 anthropic 格式;否则 OpenAI
  const anthropicVersion = c.req.header('anthropic-version');
  if (anthropicVersion) {
    return c.json(anthropicModelsList(c.env));
  }

  const rows = await c.env.DB.prepare(
    'SELECT * FROM models WHERE enabled = 1 ORDER BY platform, model_name'
  ).all();

  return c.json({
    object: 'list',
    data: (rows.results || []).map((m: any) => ({
      id: `${m.platform}:${m.model_name}`,
      object: 'model',
      created: m.updated_at,
      owned_by: m.platform,
      // 扩展字段(OpenAI 兼容 + 自由扩展)
      display_name: m.display_name,
      family: m.family,
      context_window: m.context_window,
      supports_tools: m.supports_tools === 1,
      supports_vision: m.supports_vision === 1,
      free_tier: {
        rpm: m.free_tier_rpm,
        rpd: m.free_tier_rpd,
        tpm: m.free_tier_tpm,
        tpd: m.free_tier_tpd,
      },
    })),
  });
});

function anthropicModelsList(_env: Env) {
  return {
    data: [],
    has_more: false,
    first_id: null,
    last_id: null,
  };
}
