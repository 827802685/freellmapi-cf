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
  let query = 'SELECT * FROM models';
  const params: any[] = [];
  if (platform) {
    query += ' WHERE platform = ?';
    params.push(platform);
  }
  query += ' ORDER BY platform, model_name';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ models: rows.results });
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
