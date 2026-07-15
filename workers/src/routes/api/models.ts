/**
 * /api/models - 模型目录管理
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { ok, badRequest } from '../../lib/response';

export const modelsRoute = new Hono<{ Bindings: Env }>();
modelsRoute.use('*', requireDashboardAuth);

modelsRoute.get('/', async (c) => {
  const platform = c.req.query('platform');
  const showAll = c.req.query('all') === '1';
  // JOIN keys 表以便标记当前该平台是否至少有一把 enabled 的 key
  let query = `
    SELECT
      m.*,
      (SELECT COUNT(*) FROM api_keys k
        WHERE k.platform = m.platform AND k.enabled = 1) AS active_keys
    FROM models m
  `;
  const params: any[] = [];
  const conds: string[] = [];
  if (platform) {
    conds.push('m.platform = ?');
    params.push(platform);
  }
  if (!showAll) {
    conds.push('m.enabled = 1');
  }
  if (conds.length > 0) {
    query += ' WHERE ' + conds.join(' AND ');
  }
  query += ' ORDER BY m.platform, m.model_name';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  // camelCase
  const models = (rows.results || []).map((m: any) => ({
    id: m.id,
    name: m.model_name,
    displayName: m.display_name,
    platform: m.platform,
    family: m.family,
    context: m.context_window,
    enabled: m.enabled === 1,
    supportsTools: m.supports_tools === 1,
    supportsVision: m.supports_vision === 1,
    freeTier: {
      rpm: m.free_tier_rpm,
      rpd: m.free_tier_rpd,
      tpm: m.free_tier_tpm,
      tpd: m.free_tier_tpd,
    },
    activeKeys: m.active_keys,
  }));
  return c.json({ models });
});

modelsRoute.patch('/:id', async (c) => {
  const body = await c.req.json<{ enabled?: number; display_name?: string }>();
  const updates: string[] = [];
  const values: any[] = [];
  if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled); }
  if (body.display_name !== undefined) { updates.push('display_name = ?'); values.push(body.display_name); }
  if (updates.length === 0) return badRequest(c, 'Nothing to update');
  updates.push('updated_at = unixepoch()');
  values.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
  return ok(c, { updated: true });
});

// Fallback 链
export const fallbackRoute = new Hono<{ Bindings: Env }>();
fallbackRoute.use('*', requireDashboardAuth);

fallbackRoute.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, position, platform, model, key_id, enabled FROM fallback_chain ORDER BY position'
  ).all();
  return c.json({ chain: rows.results });
});

fallbackRoute.put('/', async (c) => {
  const body = await c.req.json<{
    entries: Array<{ platform: string; model: string; key_id?: number; enabled?: number }>;
  }>();
  if (!Array.isArray(body.entries)) return badRequest(c, 'entries must be an array');

  // 整体替换
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM fallback_chain'),
    ...body.entries.map((e, i) =>
      c.env.DB.prepare(
        'INSERT INTO fallback_chain (position, platform, model, key_id, enabled) VALUES (?, ?, ?, ?, ?)'
      ).bind(i, e.platform, e.model, e.key_id || null, e.enabled ?? 1)
    ),
  ]);
  return ok(c, { ok: true });
});
