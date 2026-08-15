/**
 * freellmapi-cf 主入口
 * Cloudflare Workers
 */

import { Hono, type Context } from 'hono';
import type { Env } from './types';
import { chatRoute } from './routes/v1/chat';
import { modelsRoute as v1ModelsRoute } from './routes/v1/models';
import { completionsRoute } from './routes/v1/completions';
import { embeddingsRoute } from './routes/v1/embeddings';
import { imagesRoute } from './routes/v1/images';
import { audioRoute } from './routes/v1/audio';
import { messagesRoute } from './routes/v1/messages';
import { responsesRoute } from './routes/v1/responses';
import { docsRoute } from './routes/v1/docs';
import { geminiRoute } from './routes/v1beta/gemini';
import { mcpRoute } from './routes/mcp';
import { authRoute } from './routes/api/auth';
import { requireDashboardAuth, requireUserToken } from './lib/auth';
import { rateLimit as rateLimitMiddleware } from './lib/ratelimit';
import { keysRoute } from './routes/api/keys';
import { tokensRoute } from './routes/api/tokens';
import { analyticsRoute } from './routes/api/analytics';
import { aboutRoute } from './routes/api/about';
import { settingsRoute } from './routes/api/settings';
import { modelsRoute, fallbackRoute } from './routes/api/models';
import { ALL_PLATFORMS, PLATFORM_LABELS } from './providers';
import { getProvider } from './providers';
import { getLandingHtml } from './landing';
import { decrypt } from './lib/crypto';
import { detectVisionSupport, detectToolSupport } from './lib/model-meta';
import { getSetting } from './lib/response';
import { pickRoute } from './lib/router';
import { extractErrorMessage, sendServerError } from './lib/errors';
import type { Platform } from './types';

export { KeyState } from './durable-objects/KeyState';
export { Session } from './durable-objects/Session';

const app = new Hono<{ Bindings: Env }>();

// 固定的允许请求头白名单(不再反射客户端传入的任意头)
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Session-Id, X-Route-Mode, anthropic-version, X-Latency, X-Latency-Ms, x-api-key, Mcp-Session-Id';
// 固定的暴露响应头
const EXPOSED_HEADERS = 'X-Latency, X-Latency-Ms, X-Platform, X-Model, X-Fallback-Count';

/**
 * 构建可信 Origin 白名单
 * 从环境变量 DASHBOARD_URL / BACKEND_URL 提取,加上 Pages 默认域名
 */
function getAllowedOrigins(env: Env): Set<string> {
  const origins = new Set<string>();
  // Pages 默认域名
  origins.add('https://freellmapi-cf-dashboard.pages.dev');
  // 从环境变量提取
  if (env.DASHBOARD_URL) {
    try { origins.add(new URL(env.DASHBOARD_URL).origin); } catch { /* ignore */ }
  }
  if (env.BACKEND_URL) {
    try { origins.add(new URL(env.BACKEND_URL).origin); } catch { /* ignore */ }
  }
  // 开发环境
  if (env.ENVIRONMENT !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://localhost:8788');
    origins.add('http://127.0.0.1:5173');
    origins.add('http://127.0.0.1:8788');
  }
  return origins;
}

type HonoContext = Context<{ Bindings: Env }>;

/**
 * 安全的 CORS 处理:仅允许白名单内的 Origin
 * - 无 Origin 头(非浏览器客户端):不设置 CORS 头
 * - Origin 在白名单:回显该 Origin + credentials:true
 * - Origin 不在白名单或为 null:不设置 ACAO(浏览器自动拦截)
 */
function applyCors(c: Context<{ Bindings: Env }>, env: Env) {
  const origin = c.req.header('Origin');
  if (!origin) return; // 非浏览器请求,CORS 无意义

  // 严禁反射 null 或通配符 *
  if (origin === 'null' || origin === '*') return;

  const allowed = getAllowedOrigins(env);
  if (!allowed.has(origin)) return; // 不在白名单,不设置 CORS 头

  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  c.header('Access-Control-Max-Age', '86400');
  c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
}

/**
 * 注入安全响应头
 */
function applySecurityHeaders(c: Context<{ Bindings: Env }>) {
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // CSP:允许同源 + inline style(SPA 需要)+ pages.dev 资源
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://*.dpdns.org https://*.pages.dev https://*.workers.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

// CORS + 安全头 + 路径规范化
app.use('*', async (c, next) => {
  // 路径规范化:防止编码点号穿越(%2e, .%2e 等)
  const url = new URL(c.req.url);
  const rawPath = url.pathname;
  // 解码后检查是否包含 ..
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  if (decodedPath.includes('..') || decodedPath.includes('%2e%2e') || decodedPath.includes('.%2e')) {
    return c.json({ error: { message: 'Invalid path' } }, 400);
  }

  applyCors(c, c.env);
  applySecurityHeaders(c);

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

/**
 * 反向代理:当通过 DASHBOARD_URL 访问时,非 API 路径代理到 Pages 前端。
 * 这样管理面板和 API 可以共用同一个域名。
 * /v1/*, /api/*, /health, /__diag 走后端 Worker,其余代理到 Pages。
 */
app.use('*', async (c, next) => {
  const host = c.req.header('Host') || '';
  const dashboardUrl = c.env.DASHBOARD_URL || '';
  // 只在 DASHBOARD_URL 的 host 和当前请求 host 一致时触发代理
  let dashboardHost = '';
  try {
    dashboardHost = dashboardUrl ? new URL(dashboardUrl).host : '';
  } catch { /* ignore */ }
  if (!dashboardHost || host !== dashboardHost) {
    return next(); // 不是通过 dashboard 域名访问,正常走后端
  }
  const path = new URL(c.req.url).pathname;
  // API 路径走后端
  if (path.startsWith('/v1/') || path.startsWith('/api/') || path.startsWith('/__') || path === '/health' || path === '/favicon.ico') {
    return next();
  }
  // 其他路径代理到 Pages 前端
  const pagesUrl = `https://freellmapi-cf-dashboard.pages.dev${path}${new URL(c.req.url).search}`;
  const resp = await fetch(pagesUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
  });
  // 返回 Pages 的响应,保留状态码和头
  const hdrs = new Headers(resp.headers);
  // 安全:清除从 Pages 继承的可能不安全的 CORS 头,用我们的白名单逻辑
  hdrs.delete('Access-Control-Allow-Origin');
  hdrs.delete('Access-Control-Allow-Credentials');
  const newResp = new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: hdrs,
  });
  // 应用安全 CORS + 安全头
  applyCors(c, c.env);
  applySecurityHeaders(c);
  return newResp;
});

// 根路径 — 浏览器访问则跳转 Dashboard,客户端/curl 返回 JSON 元信息
app.get('/', async (c) => {
  const accept = c.req.header('Accept') || '';
  const isBrowser = accept.includes('text/html');
  const dashboardUrl = c.env.DASHBOARD_URL || 'https://freellmapi-cf-dashboard.pages.dev';
  const requestHost = c.req.header('Host') || '';
  const baseUrl = requestHost ? `https://${requestHost}` : dashboardUrl;
  if (!isBrowser) {
    // API 客户端访问根路径,返回 JSON 元信息
    return c.json({
      name: 'freellmapi-cf',
      version: c.env.APP_VERSION || 'dev',
      status: 'ok',
      env: c.env.ENVIRONMENT,
      providers: ALL_PLATFORMS,
      docs: {
        base: '/v1',
        openai_compatible: true,
        endpoints: [
          'POST /v1/chat/completions',
          'GET  /v1/models',
          'POST /v1/embeddings',
          'POST /v1/images/generations',
          'POST /v1/audio/speech',
          'POST /v1/messages  (Anthropic-compatible)',
          'POST /v1/responses  (OpenAI Responses API - Codex compatible)',
          'POST /v1beta/models/{model}:generateContent  (Gemini-native)',
          'GET  /v1/docs  (API documentation)',
        ],
        docs_url: `${baseUrl}/v1/docs`,
        openapi_spec: `${baseUrl}/v1/openapi.json`,
        dashboard: dashboardUrl,
      },
    });
  }
  // 浏览器访问,返回漂亮 HTML 页面 (Galaxy 主题风格)
  const ver = c.env.APP_VERSION || 'dev';

  // 从 D1 读取全局主题偏好(landing page 也跟随主题色)
  const themeStr = await getSetting(c.env.DB, 'user_theme', '{"accent":"violet","glow":1,"glass":1,"gradient":1}');
  let themeAccent = 'violet';
  try { themeAccent = JSON.parse(themeStr).accent || 'violet'; } catch { /* default */ }
  const ac = ACCENT_MAP[themeAccent] || ACCENT_MAP.violet;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>freellmapi-cf · Unified LLM Router</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a24;
    --border:#1f1f2e;--text:#e5e5e7;--muted:#8b8b96;
    --accent:${ac.color};--accent-glow:${ac.glow};
    --accent-soft:${ac.soft};
    --accent-grad:${ac.grad};
    --glass:rgba(18,18,26,.65);
  }
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;overflow-x:hidden}
  /* 动态背景 */
  body::before{content:"";position:fixed;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(ellipse 50% 40% at 20% 30%,var(--accent-glow) 0%,transparent 60%),radial-gradient(ellipse 40% 50% at 80% 70%,var(--accent-soft) 0%,transparent 60%);opacity:.5;pointer-events:none;z-index:0;animation:aurora 25s ease-in-out infinite}
  body::after{content:"";position:fixed;inset:0;background-image:radial-gradient(circle,rgba(42,42,61,.5) 1px,transparent 1.5px);background-size:32px 32px;opacity:.15;pointer-events:none;z-index:0}
  @keyframes aurora{0%,100%{transform:translate(0,0) rotate(0deg) scale(1)}33%{transform:translate(-3%,2%) rotate(120deg) scale(1.05)}66%{transform:translate(2%,-3%) rotate(240deg) scale(.98)}}
  .orb{position:fixed;border-radius:50%;filter:blur(60px);opacity:.2;pointer-events:none;z-index:0}
  .orb1{width:380px;height:380px;background:radial-gradient(circle,var(--accent-glow) 0%,transparent 70%);top:-5%;left:5%;animation:o1 20s ease-in-out infinite}
  .orb2{width:320px;height:320px;background:radial-gradient(circle,var(--accent-glow) 0%,transparent 70%);top:50%;right:-5%;animation:o2 24s ease-in-out infinite}
  .orb3{width:280px;height:280px;background:radial-gradient(circle,var(--accent-soft) 0%,transparent 70%);bottom:-5%;left:30%;animation:o3 28s ease-in-out infinite}
  @keyframes o1{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(40px,30px) scale(1.1)}66%{transform:translate(-30px,50px) scale(.95)}}
  @keyframes o2{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(-50px,-30px) scale(.9)}66%{transform:translate(30px,-50px) scale(1.08)}}
  @keyframes o3{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-40px) scale(1.05)}66%{transform:translate(-40px,-20px) scale(.92)}}
  .container{position:relative;z-index:1;max-width:560px;padding:40px 24px;text-align:center;animation:fadeIn .6s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .logo{font-size:2rem;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
  .logo span{background:var(--accent-grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .tag{color:var(--muted);font-size:.95rem;margin-bottom:32px}
  .card{background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:16px;text-align:left;box-shadow:0 8px 32px rgba(0,0,0,.5);transition:border-color .3s}
  .card:hover{border-color:var(--accent-soft)}
  .card h2{font-size:.8rem;color:var(--accent);margin-bottom:12px;text-transform:uppercase;letter-spacing:.08em}
  .card .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.875rem}
  .card .row:last-child{border-bottom:none}
  .card .row .k{color:var(--muted)}.card .row .v{color:var(--text);font-family:monospace}
  .btn{display:inline-flex;align-items:center;gap:8px;margin-top:8px;padding:12px 32px;background:var(--accent-grad);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:.9rem;transition:transform .2s,box-shadow .2s;box-shadow:0 4px 14px var(--accent-glow)}
  .btn:hover{transform:translateY(-2px);box-shadow:0 8px 30px var(--accent-glow)}
  .ep{font-family:monospace;font-size:.7rem;color:var(--accent);background:var(--accent-soft);padding:3px 8px;border-radius:4px;margin-right:8px;border:1px solid var(--accent-soft)}
  .version{margin-top:24px;color:var(--muted);font-size:.8rem}
  .version .v{color:var(--accent);font-weight:600}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="orb orb3"></div>
<div class="container">
  <div class="logo">freellmapi<span>-cf</span></div>
  <div class="tag">Unified LLM Router · 统一大模型 API 路由</div>
  <div class="card">
    <h2>API 端点</h2>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/chat/completions</span><span class="v">OpenAI 兼容</span></div>
    <div class="row"><span class="k"><span class="ep">GET</span>/v1/models</span><span class="v">模型列表</span></div>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/embeddings</span><span class="v">向量嵌入</span></div>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/messages</span><span class="v">Anthropic 兼容</span></div>
    <div class="row"><span class="k"><span class="ep">GET</span>/v1/docs</span><span class="v">API 文档</span></div>
  </div>
  <div class="card">
    <h2>快速接入</h2>
    <div class="row"><span class="k">Base URL</span><span class="v">${baseUrl}/v1</span></div>
    <div class="row"><span class="k">API Key</span><span class="v">freellmapi-xxx</span></div>
    <div class="row"><span class="k">OpenAI 兼容</span><span class="v">是</span></div>
  </div>
  <a href="${dashboardUrl}" class="btn">前往管理面板 →</a>
  <div class="version"><span class="v">v${ver}</span> · Cloudflare Workers</div>
</div>
</body>
</html>`;
  return c.html(html);
});

// /test — 宣传页
app.get('/test', (c) => {
  const ver = c.env.APP_VERSION || 'dev';
  const dashboardUrl = c.env.DASHBOARD_URL || 'https://freellmapi-cf-dashboard.pages.dev';
  return c.html(getLandingHtml(ver, dashboardUrl));
});

app.get('/health', (c) => c.json({ ok: true }));

// 诊断端点:需鉴权(仅生产环境管理员可访问)
app.get('/__diag', requireDashboardAuth, async (c) => {
  const env = c.env;
  const out: {
    bindings: Record<string, boolean>;
    secrets: Record<string, boolean>;
    vars: Record<string, string>;
    d1?: { ok: boolean; counts?: Record<string, number | null>; error?: string };
  } = {
    bindings: {
      DB: !!env.DB,
      CONFIG: !!env.CONFIG,
      KEY_STATE: !!env.KEY_STATE,
      SESSION: !!env.SESSION,
    },
    secrets: {
      ENCRYPTION_KEY: !!env.ENCRYPTION_KEY,
      JWT_SECRET: !!env.JWT_SECRET,
      ADMIN_BOOTSTRAP_CODE: !!env.ADMIN_BOOTSTRAP_CODE,
    },
    vars: {
      ENVIRONMENT: env.ENVIRONMENT,
      SESSION_TTL_MINUTES: env.SESSION_TTL_MINUTES,
      RATE_LIMIT_WINDOW_SECONDS: env.RATE_LIMIT_WINDOW_SECONDS,
      RATE_LIMIT_MAX_REQUESTS: env.RATE_LIMIT_MAX_REQUESTS,
    },
  };
  // 试着查 D1 关键表
  try {
    const counts: Record<string, number | null> = {};
    for (const t of ['accounts','api_keys','models','user_tokens'] as const) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      counts[t] = r?.n ?? null;
    }
    out.d1 = { ok: true, counts };
  } catch (e: unknown) {
    const msg = extractErrorMessage(e);
    console.error(`[diag] D1 query failed: ${msg}`);
    out.d1 = { ok: false, error: 'Database query failed' };
  }
  return c.json(out);
});

// 路由诊断:检查 keys/models/fallback chain 状态 + 密钥解密测试,帮助排查 503 no_route
app.get('/__route-diag', requireUserToken, async (c) => {
  const env = c.env;
  try {
    // 1. Keys 状态
    const keysResult = await env.DB.prepare(
      `SELECT platform, enabled, health_status, COUNT(*) as count
       FROM api_keys GROUP BY platform, enabled, health_status ORDER BY platform`
    ).all<{ platform: string; enabled: number; health_status: string; count: number }>();

    // 2. Models 状态
    const modelsResult = await env.DB.prepare(
      `SELECT platform, enabled, COUNT(*) as count,
              SUM(supports_vision) as vision_count,
              SUM(supports_tools) as tools_count
       FROM models GROUP BY platform, enabled ORDER BY platform`
    ).all<{ platform: string; enabled: number; count: number; vision_count: number; tools_count: number }>();

    // 3. Fallback chain
    const chainResult = await env.DB.prepare(
      'SELECT position, platform, model, key_id, enabled FROM fallback_chain ORDER BY position'
    ).all();

    // 4. Hidden providers
    const hiddenRaw = await getSetting(env.DB, 'hidden_providers', '');

    // 5. 总计
    const totalKeys = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM api_keys WHERE enabled = 1 AND health_status != \'invalid\''
    ).first<{ n: number }>();
    const totalModels = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM models WHERE enabled = 1 AND (health_status IS NULL OR health_status = \'healthy\')'
    ).first<{ n: number }>();

    // 6. 密钥解密测试 — 逐个尝试解密所有活跃 key,报告成功/失败
    const activeKeys = await env.DB.prepare(
      `SELECT id, platform, key_ciphertext, key_iv, key_tag, key_hint
       FROM api_keys WHERE enabled = 1 AND health_status != 'invalid'`
    ).all<{ id: number; platform: string; key_ciphertext: string; key_iv: string; key_tag: string; key_hint: string }>();

    const decryptTests = await Promise.all(
      (activeKeys.results || []).map(async (k) => {
        try {
          const plaintext = await decrypt(
            { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
            env.ENCRYPTION_KEY
          );
          return { id: k.id, platform: k.platform, hint: k.key_hint, ok: true, plaintextLength: plaintext.length };
        } catch (e: unknown) {
          return { id: k.id, platform: k.platform, hint: k.key_hint, ok: false, error: extractErrorMessage(e) };
        }
      })
    );

    // 7. 平台-密钥-模型交叉匹配检查
    const platformMatch = await env.DB.prepare(
      `SELECT k.platform as key_platform, COUNT(DISTINCT k.id) as key_count,
              (SELECT COUNT(*) FROM models m WHERE m.platform = k.platform AND m.enabled = 1
               AND (m.health_status IS NULL OR m.health_status = 'healthy')) as model_count
       FROM api_keys k
       WHERE k.enabled = 1 AND k.health_status != 'invalid'
       GROUP BY k.platform ORDER BY k.platform`
    ).all<{ key_platform: string; key_count: number; model_count: number }>();

    return c.json({
      keys: keysResult.results || [],
      models: modelsResult.results || [],
      fallbackChain: chainResult.results || [],
      hiddenProviders: hiddenRaw || '',
      summary: {
        activeKeys: totalKeys?.n || 0,
        activeModels: totalModels?.n || 0,
        fallbackChainLength: (chainResult.results || []).length,
      },
      decryptTests,
      platformMatch: platformMatch.results || [],
      encryptionKeySet: !!env.ENCRYPTION_KEY,
    });
  } catch (e: unknown) {
    const msg = extractErrorMessage(e);
    return c.json({ error: msg, stack: e instanceof Error ? e.stack : undefined }, 500);
  }
});

// 路由测试:实际调用 pickRoute,返回候选列表和详细诊断
app.get('/__route-test', requireUserToken, async (c) => {
  const env = c.env;
  const userToken = c.var.userToken;
  const model = c.req.query('model') || 'auto';
  const hasImage = c.req.query('hasImage') === 'true';
  const routeMode = (c.req.query('mode') || 'auto') as 'auto' | 'fastest' | 'smartest' | 'fusion' | 'manual';

  try {
    const route = await pickRoute(env, {
      userTokenId: userToken.id,
      sessionId: null,
      prefersModel: model,
      routeMode,
      hasImage,
    });

    return c.json({
      input: { model, hasImage, routeMode },
      candidateCount: route.candidates.length,
      candidates: route.candidates.map(c => ({
        platform: c.platform,
        model: c.model,
        keyId: c.keyId,
        supportsVision: c.supportsVision,
        supportsTools: c.supportsTools,
        healthStatus: c.healthStatus,
        contextWindow: c.contextWindow,
      })),
      stickyPlatform: route.stickyPlatform,
      stickyModel: route.stickyModel,
    });
  } catch (e: unknown) {
    const msg = extractErrorMessage(e);
    return c.json({ error: msg, stack: e instanceof Error ? e.stack : undefined }, 500);
  }
});

// 临时端点:批量更新已有模型的 supports_vision / supports_tools 标记
// 用启发式检测,修复之前自动发现但没设置 vision/tools 标记的模型
// 同时手动触发 catalog 同步 + auto-discover
app.post('/__update-model-flags', requireUserToken, async (c) => {
  const env = c.env;
  try {
    // 1. 手动触发 catalog 同步(虽然远程 catalog 可能不可用,但试一下)
    await syncCatalog(env);
    // 2. 手动触发 auto-discover(从各 provider 拉取最新模型列表)
    await autoDiscoverModels(env);

    // 3. 批量更新已有模型的 vision/tools 标记
    const rows = await env.DB.prepare(
      'SELECT id, model_name, supports_vision, supports_tools FROM models'
    ).all<{ id: string; model_name: string; supports_vision: number; supports_tools: number }>();

    let updated = 0;
    const updates: string[] = [];
    for (const m of rows.results || []) {
      const newVision = detectVisionSupport(m.model_name);
      const newTools = detectToolSupport(m.model_name);
      // 只更新需要变更的
      if (newVision !== m.supports_vision || newTools !== m.supports_tools) {
        await env.DB.prepare(
          'UPDATE models SET supports_vision = ?, supports_tools = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(newVision, newTools, m.id).run();
        updated++;
        updates.push(`${m.model_name}: vision=${newVision} tools=${newTools}`);
      }
    }

    // 4. 查询更新后的 vision 模型数量
    const visionCount = await env.DB.prepare(
      'SELECT COUNT(*) as n FROM models WHERE supports_vision = 1 AND enabled = 1'
    ).first<{ n: number }>();

    return c.json({
      ok: true,
      totalModels: rows.results?.length || 0,
      flagsUpdated: updated,
      visionModels: visionCount?.n || 0,
      updates: updates.slice(0, 50),
    });
  } catch (e: unknown) {
    const msg = extractErrorMessage(e);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// 主题偏好 — 公开端点(无需鉴权,landing page 和前端都需要读取)
const ACCENT_MAP: Record<string, { color: string; glow: string; soft: string; grad: string }> = {
  violet:  { color: '#7c3aed', glow: 'rgba(124,58,237,.4)',  soft: 'rgba(124,58,237,.12)',  grad: 'linear-gradient(135deg,#7c3aed,#a78bfa)' },
  blue:    { color: '#2563eb', glow: 'rgba(37,99,235,.4)',   soft: 'rgba(37,99,235,.12)',   grad: 'linear-gradient(135deg,#2563eb,#60a5fa)' },
  emerald: { color: '#059669', glow: 'rgba(5,150,105,.4)',   soft: 'rgba(5,150,105,.12)',   grad: 'linear-gradient(135deg,#059669,#34d399)' },
  rose:    { color: '#e11d48', glow: 'rgba(225,29,72,.4)',   soft: 'rgba(225,29,72,.12)',   grad: 'linear-gradient(135deg,#e11d48,#fb7185)' },
  amber:   { color: '#d97706', glow: 'rgba(217,119,6,.4)',   soft: 'rgba(217,119,6,.12)',   grad: 'linear-gradient(135deg,#d97706,#fbbf24)' },
  cyan:    { color: '#0891b2', glow: 'rgba(8,145,178,.4)',   soft: 'rgba(8,145,178,.12)',   grad: 'linear-gradient(135deg,#0891b2,#22d3ee)' },
  pink:    { color: '#db2777', glow: 'rgba(219,39,119,.4)',  soft: 'rgba(219,39,119,.12)',  grad: 'linear-gradient(135deg,#db2777,#f472b6)' },
};

app.get('/api/theme', async (c) => {
  const themeStr = await getSetting(c.env.DB, 'user_theme', '{"accent":"violet","glow":1,"glass":1,"gradient":1}');
  try {
    return c.json(JSON.parse(themeStr));
  } catch {
    return c.json({ accent: 'violet', glow: 1, glass: 1, gradient: 1 });
  }
});

// 平台元数据
app.get('/api/meta/platforms', (c) => {
  return c.json({
    platforms: ALL_PLATFORMS.map(p => ({
      id: p,
      label: PLATFORM_LABELS[p],
    })),
  });
});

// ============== Dashboard API ==============
app.route('/api/auth', authRoute);
app.route('/api/keys', keysRoute);
app.route('/api/tokens', tokensRoute);
app.route('/api/analytics', analyticsRoute);
app.route('/api/about', aboutRoute);
app.route('/api/settings', settingsRoute);
app.route('/api/models', modelsRoute);
app.route('/api/fallback', fallbackRoute);

// ============== OpenAI 兼容 API ==============
// 对 /v1/* 端点施加 IP 速率限制(防止 API key 枚举/撞库)
app.use('/v1/*', rateLimitMiddleware(120, 60, 'v1'));
app.route('/v1', chatRoute);
app.route('/v1', v1ModelsRoute);
app.route('/v1', completionsRoute);
app.route('/v1', embeddingsRoute);
app.route('/v1', imagesRoute);
app.route('/v1', audioRoute);
app.route('/v1', messagesRoute);
app.route('/v1', responsesRoute);
app.route('/v1', docsRoute);
app.route('/v1beta', geminiRoute);
app.route('/mcp', mcpRoute);

// 404
app.notFound((c) => c.json({
  error: { message: 'Not found', path: c.req.path },
}, 404));

// 错误处理:归一化错误响应,不泄露内部实现细节
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err.stack);
  // 对外返回通用错误信息,不暴露 D1/V8 原始错误
  const isDev = c.env.ENVIRONMENT !== 'production';
  return c.json({
    error: {
      message: isDev ? err.message : 'Internal server error',
      type: 'server_error',
    },
  }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // Cron trigger: 同步模型目录 + 自动发现新模型 + 清理过期请求日志
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncCatalog(env));
    ctx.waitUntil(autoDiscoverModels(env));
    ctx.waitUntil(cleanupOldLogs(env));
  },
};

/**
 * 同步远程模型目录 (RSS 源)
 * 从 RSS 拉取免费模型清单,替换远程模型库(source='remote' 的部分)。
 *
 * RSS item 结构:
 *   <title>modelscope/ZhipuAI/GLM-5.2</title>
 *   <guid isPermaLink="false">modelscope:ZhipuAI/GLM-5.2</guid>
 *   <category>对话</category>          (可多个)
 *   <description>厂商: X | Base URL: ... | 分类: A, B | 上下文: 128,000 | 能力: chat, vision | 限速: ...</description>
 *
 * 平台兼容: opencodezen → opencode, zhipu → zai (两端 Base URL 相同,复用已有平台)
 * 分类兼容: 将 RSS 分类标签(对话/代码/视觉理解/...)存入 models.categories 字段
 * RSS URL 可通过 settings 表 catalog_url 覆盖(默认 https://rss.zjkl.dpdns.org/rss.xml)
 */
const RSS_DEFAULT_URL = 'https://rss.zjkl.dpdns.org/rss.xml';

/** RSS 平台 → 系统平台 映射(相同 Base URL 的厂商合并到已有平台) */
const RSS_PLATFORM_MAP: Record<string, string> = {
  opencodezen: 'opencode', // https://opencode.ai/zen/v1
  zhipu: 'zai',            // https://open.bigmodel.cn/api/paas/v4
};

interface RssModel {
  id: string;
  platform: string;
  model_name: string;
  display_name: string;
  categories: string[];
  context_window: number | null;
  supports_vision: number;
  supports_tools: number;
  free_tier_rpm: number | null;
  free_tier_rpd: number | null;
}

/** 从 XML 中提取第一个 <tag ...>value</tag> (支持 tag 属性) */
function extractXmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m ? m[1].trim() : '';
}

/** 解析 description 里的 "key: value | key: value" 字段 */
function parseDescription(desc: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const seg of desc.split('|')) {
    const idx = seg.indexOf(':');
    if (idx > 0) {
      const key = seg.slice(0, idx).trim();
      const val = seg.slice(idx + 1).trim();
      fields[key] = val;
    }
  }
  return fields;
}

/** 解析 RSS XML,提取模型元数据 */
function parseRssModels(xml: string): RssModel[] {
  const out: RssModel[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const title = extractXmlField(item, 'title');
    const guid = extractXmlField(item, 'guid');
    const rawId = guid || title;
    if (!rawId) continue;

    // 平台 + 模型名: guid 为 "platform:model", title 为 "platform/model"
    let platformRaw = '';
    let modelName = '';
    const colon = rawId.indexOf(':');
    if (colon > 0) {
      platformRaw = rawId.slice(0, colon);
      modelName = rawId.slice(colon + 1);
    } else {
      const slash = rawId.indexOf('/');
      if (slash > 0) {
        platformRaw = rawId.slice(0, slash);
        modelName = rawId.slice(slash + 1);
      } else {
        continue;
      }
    }
    if (!modelName) continue;
    const platform = RSS_PLATFORM_MAP[platformRaw] || platformRaw;

    // 分类: 优先 <category> 标签,回退到 description 里的 "分类"
    let categories: string[] = [];
    const catRe = /<category>([^<]*)<\/category>/g;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(item)) !== null) {
      const c = cm[1].trim();
      if (c) categories.push(c);
    }
    const fields = parseDescription(extractXmlField(item, 'description'));
    if (categories.length === 0 && fields['分类']) {
      categories = fields['分类'].split(/[,，]/).map(s => s.trim()).filter(Boolean);
    }
    categories = [...new Set(categories)];

    // 上下文窗口
    let contextWindow: number | null = null;
    if (fields['上下文'] && !fields['上下文'].includes('未知')) {
      const num = fields['上下文'].replace(/,/g, '').match(/\d+/);
      contextWindow = num ? parseInt(num[0], 10) : null;
    }

    // 能力(chat / vision / tool / image / video)
    const caps = (fields['能力'] || '').toLowerCase();
    const supportsVision = caps.includes('vision') ? 1 : 0;
    const supportsTools = caps.includes('tool') ? 1 : 0;

    // 限速: "200 req/day per model" / "15 req/min (tier 1)"
    const limit = fields['限速'] || '';
    let rpm: number | null = null;
    let rpd: number | null = null;
    const rpmMatch = limit.match(/(\d+)\s*(?:req|rpm)?\s*\/\s*min/i);
    if (rpmMatch) rpm = parseInt(rpmMatch[1], 10);
    const rpdMatch = limit.match(/(\d+)\s*(?:req|rpm)?\s*\/\s*day/i);
    if (rpdMatch) rpd = parseInt(rpdMatch[1], 10);

    out.push({
      id: `${platform}:${modelName}`,
      platform,
      model_name: modelName,
      display_name: modelName,
      categories,
      context_window: contextWindow,
      supports_vision: supportsVision,
      supports_tools: supportsTools,
      free_tier_rpm: rpm,
      free_tier_rpd: rpd,
    });
  }
  return out;
}

/**
 * 同步远程模型目录 (RSS 源)
 * (默认从 RSS 源拉,可通过 settings.catalog_url 覆盖)
 */
async function syncCatalog(env: Env): Promise<void> {
  try {
    const urlRaw = await getSetting(env.DB, 'catalog_url', RSS_DEFAULT_URL);
    const url = urlRaw || RSS_DEFAULT_URL;
    const res = await fetch(url, { headers: { 'User-Agent': 'freellmapi-cf rss-sync' } });
    if (!res.ok) {
      console.error(`[CRON] RSS catalog fetch failed: ${res.status}`);
      return;
    }
    const xml = await res.text();
    const models = parseRssModels(xml);
    if (models.length === 0) {
      console.error('[CRON] RSS catalog parsed 0 models, skip sync');
      return;
    }

    // 入库(upsert,不覆盖用户手动 enabled=0 的选择)
    // 能力: RSS 的"能力"字段 + 名称启发式检测取并集(保证路由时 vision/tool 标记可用)
    let updated = 0;
    const syncedIds = new Set<string>();
    for (const m of models) {
      syncedIds.add(m.id);
      const supportsVision = m.supports_vision || detectVisionSupport(m.model_name);
      const supportsTools = m.supports_tools || detectToolSupport(m.model_name);
      await env.DB.prepare(`
        INSERT INTO models (id, platform, model_name, display_name, context_window, supports_tools, supports_vision, free_tier_rpm, free_tier_rpd, categories, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          context_window = excluded.context_window,
          supports_tools = excluded.supports_tools,
          supports_vision = excluded.supports_vision,
          free_tier_rpm = excluded.free_tier_rpm,
          free_tier_rpd = excluded.free_tier_rpd,
          categories = excluded.categories,
          source = 'remote',
          updated_at = unixepoch()
      `).bind(
        m.id,
        m.platform,
        m.model_name,
        m.display_name,
        m.context_window,
        supportsTools,
        supportsVision,
        m.free_tier_rpm,
        m.free_tier_rpd,
        m.categories.join(',')
      ).run();
      updated++;
    }

    // 替换:禁用 RSS 中已不存在的旧远程模型(保留 local / auto / custom)
    const stale = await env.DB.prepare(
      "SELECT id FROM models WHERE source = 'remote' AND enabled = 1"
    ).all<{ id: string }>();
    let disabled = 0;
    for (const r of stale.results || []) {
      if (!syncedIds.has(r.id)) {
        await env.DB.prepare(
          'UPDATE models SET enabled = 0, updated_at = unixepoch() WHERE id = ?'
        ).bind(r.id).run();
        disabled++;
      }
    }

    console.log(`[CRON] RSS catalog synced: ${updated} models, disabled ${disabled} stale remote models`);
  } catch (e: unknown) {
    console.error(`[CRON] RSS catalog sync error: ${extractErrorMessage(e)}`);
  }
}

/**
 * 自动发现新模型
 * 遍历所有启用的 key,调对应 provider 的 listModels()
 * 新发现的模型入库(source='auto'),不覆盖手动添加的(source='manual')
 * 使用启发式检测 supports_vision / supports_tools
 */
async function autoDiscoverModels(env: Env): Promise<void> {
  try {
    // 取所有启用的 key
    const keys = await env.DB.prepare(
      'SELECT id, platform, key_ciphertext, key_iv, key_tag, key_hint, custom_base_url FROM api_keys WHERE enabled = 1 AND health_status != \'invalid\''
    ).all<{ id: number; platform: string; key_ciphertext: string; key_iv: string; key_tag: string; key_hint: string; custom_base_url: string }>();

    let totalNew = 0;

    for (const k of keys.results || []) {
      try {
        const provider = getProvider(k.platform as Platform, k.custom_base_url || undefined);
        if (!provider.listModels) continue;  // 该 provider 不支持 listModels

        // 解密 key
        const plaintext = await decrypt(
          { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
          env.ENCRYPTION_KEY
        );

        // 拉取远程模型列表
        const remoteModels = await provider.listModels(plaintext);
        if (remoteModels.length === 0) continue;

        // 查数据库已有的该平台模型
        const existing = await env.DB.prepare(
          'SELECT model_name, source FROM models WHERE platform = ?'
        ).bind(k.platform).all<{ model_name: string; source: string }>();

        const existingSet = new Set((existing.results || []).map(m => m.model_name));

        // 新模型入库(带 vision/tools 检测)
        let newCount = 0;
        for (const modelName of remoteModels) {
          if (existingSet.has(modelName)) continue;  // 已存在,跳过(不覆盖手动添加的)

          const id = `${k.platform}:${modelName}`;
          const supportsVision = detectVisionSupport(modelName);
          const supportsTools = detectToolSupport(modelName);
          await env.DB.prepare(
            `INSERT OR IGNORE INTO models (id, platform, model_name, display_name, enabled, supports_vision, supports_tools, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'auto', unixepoch(), unixepoch())`
          ).bind(id, k.platform, modelName, modelName, supportsVision, supportsTools).run();
          newCount++;
        }

        if (newCount > 0) {
          console.log(`[CRON] Auto-discovered ${newCount} new models for ${k.platform}`);
          totalNew += newCount;
        }
      } catch (e: unknown) {
        console.error(`[CRON] Auto-discover error for ${k.platform}: ${extractErrorMessage(e)}`);
      }
    }

    console.log(`[CRON] Auto-discover complete: ${totalNew} new models total`);
  } catch (e: unknown) {
    console.error(`[CRON] Auto-discover error: ${extractErrorMessage(e)}`);
  }
}

/**
 * 清理过期的请求日志
 * 根据 settings 表中的 analytics_retention_days 配置(默认 90 天)删除过期日志行
 */
async function cleanupOldLogs(env: Env): Promise<void> {
  try {
    const retentionDaysStr = await getSetting(env.DB, 'analytics_retention_days', '90');
    const retentionDays = parseInt(retentionDaysStr, 10);
    if (isNaN(retentionDays) || retentionDays < 1) {
      console.error(`[CRON] Invalid analytics_retention_days value: "${retentionDaysStr}"`);
      return;
    }

    const result = await env.DB.prepare(
      'DELETE FROM request_logs WHERE created_at < unixepoch() - ?'
    ).bind(retentionDays * 86400).run();

    const deletedCount = result.meta?.changes ?? 0;
    if (deletedCount > 0) {
      console.log(`[CRON] Cleaned up ${deletedCount} old request log rows (retention: ${retentionDays} days)`);
    }
  } catch (e: unknown) {
    console.error(`[CRON] Log cleanup error: ${extractErrorMessage(e)}`);
  }
}
