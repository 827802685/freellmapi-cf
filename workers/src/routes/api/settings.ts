/**
 * 设置路由
 * GET    /api/settings/providers           - 列出所有平台 + 每个平台的模型列表
 * POST   /api/settings/providers           - 添加新提供商
 * PUT    /api/settings/providers/:platform - 更新提供商(label/enable/sort)
 * DELETE /api/settings/providers/:platform - 删除提供商(同时删该平台所有模型)
 * PUT    /api/settings/models/:id          - 更新单个模型
 * POST   /api/settings/models              - 添加新模型
 * DELETE /api/settings/models/:id          - 删除模型
 * POST   /api/settings/models/batch-delete - 批量删除模型
 * PUT    /api/settings/platform/:platform/limits - 批量更新额度
 */

import { Hono } from 'hono';
import type { Env, Platform } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { getProvider, PLATFORM_LABELS, ALL_PLATFORMS } from '../../providers';
import { decrypt } from '../../lib/crypto';
import { ok, badRequest, notFound, getSetting, setSetting } from '../../lib/response';

export const settingsRoute = new Hono<{ Bindings: Env }>();

settingsRoute.use('*', requireDashboardAuth);

// 列出所有平台 + 模型
settingsRoute.get('/providers', async (c) => {
  // 读取被用户隐藏(删除)的平台列表
  const hiddenRaw = await getSetting(c.env.DB, 'hidden_providers', '');
  const hiddenSet = new Set(hiddenRaw.split(',').map(s => s.trim()).filter(Boolean));

  // 从 D1 读 providers 表(动态)
  const providersResult = await c.env.DB.prepare(
    'SELECT platform, label, base_url, enabled, sort_order FROM providers ORDER BY sort_order, platform'
  ).all<{ platform: string; label: string; base_url: string | null; enabled: number; sort_order: number }>();

  let providers = (providersResult.results || []).filter(p => !hiddenSet.has(p.platform));

  // 自动补 ALL_PLATFORMS 里有但 providers 表里缺失的平台(跳过被隐藏的)
  const existingSet = new Set(providers.map(p => p.platform));
  const missing = ALL_PLATFORMS.filter(p => !existingSet.has(p) && !hiddenSet.has(p));
  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i++) {
      const p = missing[i];
      const sortOrder = providers.length + i;
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO providers (platform, label, base_url, enabled, sort_order) VALUES (?, ?, NULL, 1, ?)'
      ).bind(p, PLATFORM_LABELS[p] || p, sortOrder).run();
    }
    // 重新查
    const refetched = await c.env.DB.prepare(
      'SELECT platform, label, base_url, enabled, sort_order FROM providers ORDER BY sort_order, platform'
    ).all<{ platform: string; label: string; base_url: string | null; enabled: number; sort_order: number }>();
    providers = refetched.results || [];
  }

  // 如果 providers 表为空,fallback 到硬编码
  if (providers.length === 0) {
    providers = ALL_PLATFORMS.map((p, i) => ({
      platform: p, label: PLATFORM_LABELS[p] || p, base_url: null, enabled: 1, sort_order: i,
    }));
  }

  // 查所有模型
  const modelsResult = await c.env.DB.prepare(
    `SELECT id, platform, model_name, display_name, family, context_window,
            supports_tools, supports_vision, supports_streaming,
            free_tier_rpm, free_tier_rpd, free_tier_tpm, free_tier_tpd,
            enabled, source, updated_at
     FROM models ORDER BY platform, model_name`
  ).all();

  // 查所有 key
  const keysResult = await c.env.DB.prepare(
    'SELECT platform, COUNT(*) as total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) as enabled_count FROM api_keys GROUP BY platform'
  ).all<{ platform: string; total: number; enabled_count: number }>();

  const keyMap = new Map<string, { total: number; enabled: number }>();
  for (const k of keysResult.results || []) {
    keyMap.set(k.platform, { total: k.total, enabled: k.enabled_count });
  }

  // 按 platform 分组模型
  const platformMap = new Map<string, Record<string, unknown>[]>();
  for (const m of modelsResult.results || []) {
    const p = (m as { platform: string }).platform;
    if (!platformMap.has(p)) platformMap.set(p, []);
    platformMap.get(p)!.push(m);
  }

  // 构建平台列表
  const platforms = providers.map(p => ({
    platform: p.platform,
    label: p.label,
    baseUrl: p.base_url,
    enabled: p.enabled,
    sortOrder: p.sort_order,
    keyInfo: keyMap.get(p.platform) || { total: 0, enabled: 0 },
    models: platformMap.get(p.platform) || [],
  }));

  return c.json({ platforms });
});

// 添加新提供商
settingsRoute.post('/providers', async (c) => {
  const body = await c.req.json<{ platform: string; label: string; base_url?: string; sort_order?: number }>();

  if (!body.platform || !body.label) {
    return badRequest(c, 'platform 和 label 必填');
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO providers (platform, label, base_url, sort_order) VALUES (?, ?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET label = excluded.label, base_url = excluded.base_url, sort_order = excluded.sort_order`
    ).bind(
      body.platform,
      body.label,
      body.base_url || null,
      body.sort_order ?? 99
    ).run();

    // 如果该平台之前被隐藏过,现在取消隐藏
    const hiddenRaw = await getSetting(c.env.DB, 'hidden_providers', '');
    const hiddenList = hiddenRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (hiddenList.includes(body.platform)) {
      const newList = hiddenList.filter(p => p !== body.platform);
      await setSetting(c.env.DB, 'hidden_providers', newList.join(','));
    }

    return ok(c, { platform: body.platform, created: true }, 201);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return badRequest(c, '提供商已存在');
    throw e;
  }
});

// 更新提供商
settingsRoute.put('/providers/:platform', async (c) => {
  const platform = c.req.param('platform');
  const body = await c.req.json<{ label?: string; base_url?: string; enabled?: number; sort_order?: number }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.label !== undefined) { updates.push('label = ?'); values.push(body.label); }
  if (body.base_url !== undefined) { updates.push('base_url = ?'); values.push(body.base_url); }
  if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled); }
  if (body.sort_order !== undefined) { updates.push('sort_order = ?'); values.push(body.sort_order); }

  if (updates.length === 0) return badRequest(c, '没有要更新的字段');

  values.push(platform);
  const result = await c.env.DB.prepare(
    `UPDATE providers SET ${updates.join(', ')} WHERE platform = ?`
  ).bind(...values).run();

  if (result.meta.changes === 0) return notFound(c);
  return ok(c, { updated: true });
});

// 删除提供商(同时删该平台所有模型)
settingsRoute.delete('/providers/:platform', async (c) => {
  const platform = c.req.param('platform');

  // 检查是否有关联的 key
  const keyCheck = await c.env.DB.prepare(
    'SELECT COUNT(*) as c FROM api_keys WHERE platform = ?'
  ).bind(platform).first<{ c: number }>();

  if (keyCheck && keyCheck.c > 0) {
    return badRequest(c, `该提供商还有 ${keyCheck.c} 个关联密钥,请先在密钥页面删除密钥`);
  }

  // 删除该平台所有模型
  await c.env.DB.prepare('DELETE FROM models WHERE platform = ?').bind(platform).run();
  // 删除 fallback chain 中该平台的条目
  await c.env.DB.prepare('DELETE FROM fallback_chain WHERE platform = ?').bind(platform).run();
  // 删除提供商记录
  await c.env.DB.prepare('DELETE FROM providers WHERE platform = ?').bind(platform).run();

  // 标记为隐藏,防止 GET /providers 自动补全时再加回来
  const hiddenRaw = await getSetting(c.env.DB, 'hidden_providers', '');
  const hiddenList = hiddenRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!hiddenList.includes(platform)) {
    hiddenList.push(platform);
    await setSetting(c.env.DB, 'hidden_providers', hiddenList.join(','));
  }

  return ok(c, { deleted: true });
});

// 更新模型
settingsRoute.put('/models/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const body = await c.req.json();

  const fields = [
    'display_name', 'family', 'context_window',
    'supports_tools', 'supports_vision', 'supports_streaming',
    'free_tier_rpm', 'free_tier_rpd', 'free_tier_tpm', 'free_tier_tpd',
    'enabled',
  ];

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(body[f] as string | number | null);
    }
  }

  if (updates.length === 0) {
    return badRequest(c, '没有要更新的字段');
  }

  updates.push('updated_at = unixepoch()');
  values.push(id);

  const result = await c.env.DB.prepare(
    `UPDATE models SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  if (result.meta.changes === 0) return notFound(c);

  return ok(c, { updated: true });
});

// 添加新模型
settingsRoute.post('/models', async (c) => {
  const body = await c.req.json<{ platform: string; model_name: string; display_name?: string; enabled?: number }>();

  if (!body.platform || !body.model_name) {
    return badRequest(c, 'platform 和 model_name 必填');
  }

  const id = `${body.platform}:${body.model_name}`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO models (id, platform, model_name, display_name, enabled, source)
       VALUES (?, ?, ?, ?, ?, 'local')`
    ).bind(id, body.platform, body.model_name, body.display_name || null, body.enabled ?? 1).run();
    return ok(c, { id, created: true }, 201);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return badRequest(c, '模型已存在');
    throw e;
  }
});

// 删除模型
settingsRoute.delete('/models/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM models WHERE id = ?').bind(id).run();
  return ok(c, { deleted: true });
});

// 批量删除模型
settingsRoute.post('/models/batch-delete', async (c) => {
  const body = await c.req.json<{ ids: string[] }>();
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return badRequest(c, 'ids 数组不能为空');
  }
  let deleted = 0;
  for (const id of body.ids) {
    const r = await c.env.DB.prepare('DELETE FROM models WHERE id = ?').bind(id).run();
    deleted += r.meta.changes || 0;
  }
  return ok(c, { deleted, total: body.ids.length });
});

// 保存主题偏好(全局持久化到 D1)
settingsRoute.put('/theme', async (c) => {
  const body = await c.req.json<{ accent?: string; glow?: number; glass?: number; gradient?: number }>();
  const theme = JSON.stringify({
    accent: body.accent || 'violet',
    glow: body.glow ?? 1,
    glass: body.glass ?? 1,
    gradient: body.gradient ?? 1,
  });
  await setSetting(c.env.DB, 'user_theme', theme);
  return ok(c, { success: true });
});

// 批量更新某平台所有模型的额度
settingsRoute.put('/platform/:platform/limits', async (c) => {
  const platform = c.req.param('platform');
  const body = await c.req.json<{ rpm?: number; rpd?: number; tpm?: number; tpd?: number }>();

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.rpm !== undefined) { updates.push('free_tier_rpm = ?'); values.push(body.rpm); }
  if (body.rpd !== undefined) { updates.push('free_tier_rpd = ?'); values.push(body.rpd); }
  if (body.tpm !== undefined) { updates.push('free_tier_tpm = ?'); values.push(body.tpm); }
  if (body.tpd !== undefined) { updates.push('free_tier_tpd = ?'); values.push(body.tpd); }

  if (updates.length === 0) return badRequest(c, '没有要更新的字段');

  updates.push('updated_at = unixepoch()');
  values.push(platform);

  const result = await c.env.DB.prepare(
    `UPDATE models SET ${updates.join(', ')} WHERE platform = ?`
  ).bind(...values).run();

  return ok(c, { updated: result.meta.changes });
});
