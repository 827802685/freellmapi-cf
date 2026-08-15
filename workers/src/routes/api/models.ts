/**
 * /api/models - 模型目录管理
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { ok, badRequest } from '../../lib/response';

export const modelsRoute = new Hono<{ Bindings: Env }>();
modelsRoute.use('*', requireDashboardAuth);

// 各平台默认月度免费令牌额度 (tokens/month)
// 基于各平台公开的免费层限制估算
const PLATFORM_MONTHLY_QUOTA: Record<string, number> = {
  google: 1_000_000,       // Gemini Flash: ~1M tokens/day → 30M/month, 但实际限制更严
  groq: 6_000,             // ~6000 TPM, 但有 RPD 限制
  cloudflare: 10_000,      // 10000 neurons/day
  // github: 100_000,       // 已停用 (2026-07-30 退役)
  cerebras: 100_000,       // 高速但有限
  zai: 100_000,            // 智谱免费层
  nvidia: 5_000,           // NIM 限制
  mistral: 500_000,        // Mistral 免费
  cohere: 100_000,         // Cohere trial
  openrouter: 0,           // 按提供商不同
  huggingface: 1_000,      // HF Inference 限制
  ollama: 0,               // 自托管
  kilo: 0,
  pollinations: 0,         // 无限但慢
  llm7: 0,
  ovh: 0,
  aihorde: 0,
  bailian: 3_000_000,      // 百炼免费层: 每模型约 100万 tokens 限额
  opencode: 0,
  modelscope: 200_000,     // ModelScope 免费层(按请求限,估算)
  agnes: 100_000,          // AGNES 免费层(按请求限,估算)
  custom: 0,
};

// 计算模型的月度额度
function getMonthlyQuota(m: { free_tier_tpd?: number | null; platform: string }): number {
  // 优先用数据库里的 tpd * 30
  if (m.free_tier_tpd) return m.free_tier_tpd * 30;
  // 其次用 tpm * 60 * 24 * 30 (理论最大值,但通常远高于实际限制)
  // 降级到平台默认值
  return PLATFORM_MONTHLY_QUOTA[m.platform] || 0;
}

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
  const params: string[] = [];
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

  // 查询当月每个 platform 的已用 token(只统计成功的请求)
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getUTCFullYear(), now.getUTCMonth(), 1).getTime() / 1000);
  const usageRows = await c.env.DB.prepare(
    `SELECT platform, SUM(total_tokens) as used_tokens
     FROM request_logs
     WHERE status_code >= 200 AND status_code < 300
       AND created_at >= ?
     GROUP BY platform`
  ).bind(monthStart).all<{ platform: string; used_tokens: number }>();

  const platformUsage = new Map<string, number>();
  for (const r of usageRows.results || []) {
    platformUsage.set(r.platform, r.used_tokens || 0);
  }

  // camelCase
  const models = (rows.results || []).map((m: Record<string, unknown>) => ({
    id: m.id,
    name: m.model_name,
    displayName: m.display_name,
    platform: m.platform,
    family: m.family,
    categories: (m.categories as string || '').split(',').map((s: string) => s.trim()).filter(Boolean),
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
    healthStatus: m.health_status || 'healthy',
    source: m.source || 'local',
    monthlyQuota: getMonthlyQuota(m as { free_tier_tpd?: number | null; platform: string }),
    monthlyUsed: platformUsage.get(m.platform as string) || 0,
  }));
  return c.json({ models });
});

modelsRoute.patch('/:id', async (c) => {
  const body = await c.req.json<{ enabled?: number; display_name?: string }>();
  const updates: string[] = [];
  const values: (string | number)[] = [];
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
