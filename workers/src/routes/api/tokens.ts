/**
 * /api/tokens - 客户端统一 API Key
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { randomToken, sha256Hex, makeKeyHint } from '../../lib/crypto';
import { ok } from '../../lib/response';

export const tokensRoute = new Hono<{ Bindings: Env }>();
tokensRoute.use('*', requireDashboardAuth);

tokensRoute.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, token_hint, label, enabled, created_at, last_used_at, request_count FROM user_tokens ORDER BY id DESC'
  ).all();
  return c.json({ tokens: rows.results });
});

tokensRoute.post('/', async (c) => {
  const body = await c.req.json<{ label?: string }>();
  const plaintext = randomToken('freellmapi-', 32);
  const hash = await sha256Hex(plaintext);
  const hint = makeKeyHint(plaintext);

  await c.env.DB.prepare(
    'INSERT INTO user_tokens (token_hash, token_hint, label) VALUES (?, ?, ?)'
  ).bind(hash, hint, body.label || null).run();

  // 一次性返回明文
  return ok(c, { tokenPlain: plaintext, tokenHint: hint, label: body.label }, 201);
});

tokensRoute.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM user_tokens WHERE id = ?').bind(c.req.param('id')).run();
  return ok(c, { deleted: true });
});

tokensRoute.patch('/:id', async (c) => {
  const body = await c.req.json<{ enabled?: number; label?: string }>();
  const updates: string[] = [];
  const values: any[] = [];
  if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled); }
  if (body.label !== undefined) { updates.push('label = ?'); values.push(body.label); }
  if (updates.length === 0) return ok(c, { updated: true });
  values.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE user_tokens SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
  return ok(c, { updated: true });
});
