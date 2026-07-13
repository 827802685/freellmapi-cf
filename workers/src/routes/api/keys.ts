/**
 * /api/keys - API Key 管理
 *
 * ⭐ 这里是用户最初要求改造的 UI 部分,后端 API 已经为"添加后立刻显示"准备好
 *
 * - GET    /api/keys           列表(只返 hint,不返明文)
 * - POST   /api/keys           添加(返回完整 key 一次!!)
 * - GET    /api/keys/:id       详情(只返 hint)
 * - GET    /api/keys/:id/plain 临时获取明文(记录审计)
 * - PATCH  /api/keys/:id       改 label / enabled
 * - DELETE /api/keys/:id       删除
 * - POST   /api/keys/:id/check 健康检查
 */

import { Hono } from 'hono';
import type { Env, ApiKey, Platform } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { encryptApiKey, decrypt, makeKeyHint, randomB64Url } from '../../lib/crypto';
import { getProvider, PLATFORM_LABELS } from '../../providers';
import { getSetting } from '../../lib/response';
import { err, ok, notFound, badRequest } from '../../lib/response';

export const keysRoute = new Hono<{ Bindings: Env }>();
keysRoute.use('*', requireDashboardAuth);

// 列表
keysRoute.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, platform, label, key_hint, enabled, health_status, last_checked_at, created_at, updated_at FROM api_keys ORDER BY id'
  ).all();
  return c.json({ keys: rows.results });
});

// 添加(⭐ 重点:返回明文一次)
keysRoute.post('/', async (c) => {
  const body = await c.req.json<{ platform: Platform; key: string; label?: string }>();
  if (!body.platform || !body.key) {
    return badRequest(c, 'platform and key are required');
  }
  if (body.key.length < 8) {
    return badRequest(c, 'Key too short');
  }

  const { encrypted, hint } = await encryptApiKey(body.key, c.env.ENCRYPTION_KEY);

  const result = await c.env.DB.prepare(
    `INSERT INTO api_keys (platform, label, key_ciphertext, key_iv, key_tag, key_hint)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(body.platform, body.label || null, encrypted.ciphertext, encrypted.iv, encrypted.tag, hint).first<{ id: number }>();

  // 异步健康检查
  c.executionCtx.waitUntil(checkAndUpdateHealth(c.env, result!.id, body.platform, body.key));

  // ⭐ 关键:立刻返回完整 key,UI 才能在弹窗里展示
  return ok(c, {
    id: result!.id,
    platform: body.platform,
    label: body.label,
    keyHint: hint,
    keyPlain: body.key,  // 一次性返回,前端展示后必须丢弃
    enabled: 1,
    healthStatus: 'unknown',
  }, 201);
});

// 详情(只返 hint,绝不返明文)
keysRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, platform, label, key_hint, enabled, health_status, last_checked_at, created_at, updated_at FROM api_keys WHERE id = ?'
  ).bind(id).first();
  if (!row) return notFound(c);
  return c.json({ key: row });
});

// ⭐ 临时获取明文(用于 UI 临时显示/复制)
keysRoute.get('/:id/plain', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT key_ciphertext, key_iv, key_tag, key_hint FROM api_keys WHERE id = ?'
  ).bind(id).first<{ key_ciphertext: string; key_iv: string; key_tag: string; key_hint: string }>();
  if (!row) return notFound(c);

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );

  // 审计日志(谁看过明文)
  const session = c.get('session');
  console.log(`[AUDIT] account=${session.email} revealed key id=${id} hint=${row.key_hint}`);

  return c.json({ keyPlain: plaintext, keyHint: row.key_hint });
});

// 改 label / enabled
keysRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; enabled?: number }>();
  const updates: string[] = [];
  const values: any[] = [];
  if (body.label !== undefined) { updates.push('label = ?'); values.push(body.label); }
  if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled); }
  if (updates.length === 0) return badRequest(c, 'Nothing to update');
  updates.push('updated_at = unixepoch()');
  values.push(id);
  await c.env.DB.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
  return ok(c, { updated: true });
});

// 删除
keysRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  return ok(c, { deleted: true });
});

// 健康检查
keysRoute.post('/:id/check', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT platform, key_ciphertext, key_iv, key_tag FROM api_keys WHERE id = ?'
  ).bind(id).first<{ platform: Platform; key_ciphertext: string; key_iv: string; key_tag: string }>();
  if (!row) return notFound(c);

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );
  const result = await checkAndUpdateHealth(c.env, parseInt(id, 10), row.platform, plaintext);
  return c.json(result);
});

async function checkAndUpdateHealth(env: Env, id: number, platform: Platform, keyPlain: string) {
  try {
    const provider = getProvider(platform);
    const result = await provider.healthCheck(keyPlain);
    const status = result.ok ? 'healthy' : 'error';
    await env.DB.prepare(
      'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
    ).bind(status, id).run();
    return { ...result, healthStatus: status };
  } catch (e: any) {
    return { ok: false, status: 0, message: e.message, healthStatus: 'error' };
  }
}
