/**
 * GET /api/about
 * 公开端点,无需鉴权:返回服务信息、首次部署时间、累计请求数、版本日志
 */

import { Hono } from 'hono';

export const aboutRoute = new Hono<{ Bindings: Env }>();

// 版本日志(每次发版在这里添加)
const CHANGELOG = [
  {
    version: '2.7.0',
    date: '2026-07-20',
    changes: {
      zh: ['版本日志改为后端动态返回(不再硬编码前端)', '版本号和日志随 Worker 部署自动更新', '修复亮色模式文字偏白:加深 text-primary/secondary/muted 对比度'],
      en: ['Changelog now served from backend (no longer hardcoded in frontend)', 'Version and changelog auto-update with Worker deploy', 'Fixed light mode text contrast: deepened text-primary/secondary/muted'],
    },
  },
  {
    version: '2.6.1',
    date: '2026-07-20',
    changes: {
      zh: ['修复分析页成功率:失败请求现在也记入 request_logs', '修复预估节省:流式请求现在提取 usage token', '预估节省按平台/模型参考定价计算(不再为0)', '登录后默认进入模型页而非密钥页', '修复亮色模式文字偏白对比度不足'],
      en: ['Fixed analytics success rate: failed requests now logged', 'Fixed estimated savings: streaming requests now extract usage tokens', 'Estimated savings calculated by platform pricing (no longer 0)', 'Default page after login changed to Models', 'Fixed light mode text contrast issues'],
    },
  },
  {
    version: '2.6.0',
    date: '2026-07-20',
    changes: {
      zh: ['路由策略真正生效: fastest 按延迟排序, smartest 按模型大小排序', '前端通过 X-Route-Mode 头传递路由模式', '修复非 manual 模式全发 model=auto 的问题', '密钥页加全部刷新按钮'],
      en: ['Routing strategies now work: fastest sorts by latency, smartest by model size', 'Frontend sends route mode via X-Route-Mode header', 'Fixed all non-manual modes sending model=auto', 'Added Check All button to Keys page'],
    },
  },
  {
    version: '2.5.7',
    date: '2026-07-16',
    changes: {
      zh: ['Cloudflare key 格式改为逗号分隔 (ACCOUNT_ID,API_TOKEN)', '设置页提供商卡片加刷新按钮', '关于页加版本日志'],
      en: ['Cloudflare key format changed to comma-separated', 'Added refresh button to provider cards', 'Added changelog to About page'],
    },
  },
  {
    version: '2.5.6',
    date: '2026-07-16',
    changes: {
      zh: ['修复健康检查误判(safeFetch超时问题)', '所有 Provider 健康检查改用直接 fetch', '智谱状态恢复正常'],
      en: ['Fixed health check false positives (safeFetch timeout)', 'All provider health checks now use direct fetch', 'ZAI status restored to healthy'],
    },
  },
  {
    version: '2.5.5',
    date: '2026-07-15',
    changes: {
      zh: ['Worker 反向代理: 0426 域名同时服务前端和 API', '管理面板可通过 api.zjkl0426.dpdns.org 访问'],
      en: ['Worker reverse proxy: 0426 domain serves both frontend and API', 'Dashboard accessible via api.zjkl0426.dpdns.org'],
    },
  },
  {
    version: '2.5.0',
    date: '2026-07-15',
    changes: {
      zh: ['亮色模式全面修复 (WCAG AA 标准)', 'i18n 英文翻译补全 (130+ 新 key)', '开源到 GitHub'],
      en: ['Light mode fully fixed (WCAG AA standard)', 'i18n English translations completed (130+ new keys)', 'Open sourced on GitHub'],
    },
  },
  {
    version: '2.0.0',
    date: '2026-07-05',
    changes: {
      zh: ['完整重写到 Cloudflare Workers', '初始 18 个 LLM 提供商', 'AES-256-GCM 密钥加密', '管理面板 (React + Tailwind)'],
      en: ['Complete rewrite to Cloudflare Workers', 'Initial 18 LLM providers', 'AES-256-GCM key encryption', 'Dashboard (React + Tailwind)'],
    },
  },
];

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
    changelog: CHANGELOG,
  });
});
