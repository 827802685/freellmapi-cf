/**
 * /api/tokens - 客户端统一 API Key
 *
 * 设计:token 明文用 AES-256-GCM 加密存(跟供应商 key 一样),保留 hash 用于鉴权时快查。
 *       "想看明文" -> GET /:id/plain -> 解密返回(不修改任何状态)
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { randomToken, sha256Hex, makeKeyHint, encrypt, decrypt } from '../../lib/crypto';
import { ok } from '../../lib/response';

export const tokensRoute = new Hono<{ Bindings: Env }>();
tokensRoute.use('*', requireDashboardAuth);

tokensRoute.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, token_hint, label, enabled, created_at, last_used_at, request_count FROM user_tokens ORDER BY id DESC'
  ).all();
  // 转成 camelCase 给前端
  const tokens = (rows.results || []).map((r: any) => ({
    id: r.id,
    tokenHint: r.token_hint,
    label: r.label,
    enabled: r.enabled,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    requestCount: r.request_count,
  }));
  return c.json({ tokens });
});

tokensRoute.post('/', async (c) => {
  const body = await c.req.json<{ label?: string }>();
  const plaintext = randomToken('freellmapi-', 32);
  const hash = await sha256Hex(plaintext);
  const hint = makeKeyHint(plaintext);
  const enc = await encrypt(plaintext, c.env.ENCRYPTION_KEY);

  await c.env.DB.prepare(
    'INSERT INTO user_tokens (token_hash, token_hint, label, token_ciphertext, token_iv, token_tag) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(hash, hint, body.label || null, enc.ciphertext, enc.iv, enc.tag).run();

  // 一次性返回明文
  return ok(c, { tokenPlain: plaintext, tokenHint: hint, label: body.label }, 201);
});

/**
 * 查看 token 明文(不解密失败抛 500)
 * 保留原 hash 不变 — 任何用旧 hash 鉴权的客户端不受影响
 */
tokensRoute.get('/:id/plain', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, token_ciphertext, token_iv, token_tag, token_hint, label FROM user_tokens WHERE id = ?'
  ).bind(id).first<{
    id: number; token_ciphertext: string; token_iv: string; token_tag: string;
    token_hint: string; label: string | null;
  }>();
  if (!row) return ok(c, { error: 'not_found' }, 404);
  if (!row.token_ciphertext || !row.token_iv || !row.token_tag) {
    return ok(c, { error: 'plaintext_not_stored' }, 410);
  }
  try {
    const plain = await decrypt(
      { ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag },
      c.env.ENCRYPTION_KEY
    );
    return c.json({ keyPlain: plain, keyHint: row.token_hint, label: row.label });
  } catch (e: any) {
    return ok(c, { error: 'decrypt_failed', message: e?.message }, 500);
  }
});

/**
 * 重新生成 token(保留作为应急:旧 key 泄露时可用)
 */
tokensRoute.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id');
  const old = await c.env.DB.prepare('SELECT id, label FROM user_tokens WHERE id = ?')
    .bind(id).first<{ id: number; label: string | null }>();
  if (!old) return ok(c, { error: 'not_found' }, 404);

  const plaintext = randomToken('freellmapi-', 32);
  const hash = await sha256Hex(plaintext);
  const hint = makeKeyHint(plaintext);
  const enc = await encrypt(plaintext, c.env.ENCRYPTION_KEY);

  await c.env.DB.prepare(
    `UPDATE user_tokens
     SET token_hash = ?, token_hint = ?,
         token_ciphertext = ?, token_iv = ?, token_tag = ?,
         created_at = unixepoch()
     WHERE id = ?`
  ).bind(hash, hint, enc.ciphertext, enc.iv, enc.tag, id).run();

  return ok(c, {
    tokenPlain: plaintext,
    tokenHint: hint,
    label: old.label,
    regenerated: true,
  });
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
