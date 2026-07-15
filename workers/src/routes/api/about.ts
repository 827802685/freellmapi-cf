/**
 * GET /api/about
 * 公开端点,无需鉴权:返回服务信息、首次部署时间、累计请求数
 */

import { Hono } from 'hono';

export const aboutRoute = new Hono<{ Bindings: Env }>();

aboutRoute.get('/', async (c) => {
  const env = c.env;

  // 1) 首次部署时间(从 KV 读取,缺失则写当前)
  const startedKey = 'system:started_at';
  let startedAt = await env.CONFIG.get(startedKey);
  if (!startedAt) {
    startedAt = String(Date.now());
    await env.CONFIG.put(startedKey, startedAt, { expirationTtl: 60 * 60 * 24 * 365 * 5 });
  }
  const startedMs = parseInt(startedAt, 10) || Date.now();

  // 2) 累计请求数(自增)
  const totalKey = 'system:total_requests';
  const totalRaw = await env.CONFIG.get(totalKey);
  let total = parseInt(totalRaw || '0', 10) || 0;
  total += 1;
  await env.CONFIG.put(totalKey, String(total), { expirationTtl: 60 * 60 * 24 * 365 * 5 });

  // 3) 统计 D1 中的 key / model / token 数量
  const [keysCount, modelsCount, tokensCount, usersCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM api_keys').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM models').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM user_tokens WHERE enabled = 1').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) as c FROM accounts').first<{ c: number }>(),
  ]);

  // 4) 统计 provider 平台
  const platforms = await env.DB.prepare(
    `SELECT platform, COUNT(*) as c, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) as enabled
     FROM api_keys GROUP BY platform ORDER BY platform`
  ).all<{ platform: string; c: number; enabled: number }>();

  // 5) 一次最近请求时间(来自 request_logs)
  const lastReq = await env.DB.prepare(
    `SELECT created_at FROM request_logs ORDER BY id DESC LIMIT 1`
  ).first<{ created_at: number }>();

  return c.json({
    name: 'freellmapi-cf',
    version: (env as any).APP_VERSION || 'dev',
    description: 'Unified LLM Router - 统一大模型 API 路由',
    backendUrl: (env as any).BACKEND_URL || '',
    region: c.req.cf?.colo || 'unknown',
    runtime: 'cloudflare-workers',
    startedAt: startedMs,
    uptimeMs: Date.now() - startedMs,
    stats: {
      totalRequests: total,
      apiKeys: keysCount?.c || 0,
      models: modelsCount?.c || 0,
      activeTokens: tokensCount?.c || 0,
      accounts: usersCount?.c || 0,
      lastRequestAt: lastReq?.created_at || null,
    },
    platforms: (platforms.results || []).map(p => ({
      platform: p.platform,
      total: p.c,
      enabled: p.enabled,
    })),
    endpoints: {
      chat: '/v1/chat/completions',
      embeddings: '/v1/embeddings',
      models: '/api/models',
      keys: '/api/keys',
      tokens: '/api/tokens',
      analytics: '/api/analytics/summary',
    },
    docs: {
      openai_compatible: true,
      auth: 'Bearer token in Authorization header',
    },
  });
});
