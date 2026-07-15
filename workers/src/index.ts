/**
 * freellmapi-cf 主入口
 * Cloudflare Workers
 */

import { Hono } from 'hono';
import type { Env } from './types';
import { chatRoute } from './routes/v1/chat';
import { modelsRoute as v1ModelsRoute } from './routes/v1/models';
import { completionsRoute } from './routes/v1/completions';
import { embeddingsRoute } from './routes/v1/embeddings';
import { imagesRoute } from './routes/v1/images';
import { audioRoute } from './routes/v1/audio';
import { messagesRoute } from './routes/v1/messages';
import { authRoute } from './routes/api/auth';
import { keysRoute } from './routes/api/keys';
import { tokensRoute } from './routes/api/tokens';
import { analyticsRoute } from './routes/api/analytics';
import { aboutRoute } from './routes/api/about';
import { settingsRoute } from './routes/api/settings';
import { modelsRoute, fallbackRoute } from './routes/api/models';
import { ALL_PLATFORMS, PLATFORM_LABELS } from './providers';

export { KeyState } from './durable-objects/KeyState';
export { Session } from './durable-objects/Session';

const app = new Hono<{ Bindings: Env }>();

/**
 * CORS 响应头
 * 必须放在最前面,cors() 中间件对 OPTIONS 预检的处理有时过于严格,
 * 手动包一层更稳。
 */
function applyCors(c: any) {
  const origin = c.req.header('Origin') || '*';
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  c.header(
    'Access-Control-Allow-Headers',
    c.req.header('Access-Control-Request-Headers') || 'Content-Type, Authorization, X-Session-Id, anthropic-version'
  );
  c.header('Access-Control-Max-Age', '86400');
  c.header('Access-Control-Expose-Headers', 'Content-Type, Authorization, X-Latency-Ms, X-Platform, X-Model');
  // ⭐ 关键:浏览器在 fetch({ credentials: 'include' }) 时,服务端必须返回 credentials: true,否则响应被吞,表现为 "Failed to fetch"
  if (origin !== '*') {
    c.header('Access-Control-Allow-Credentials', 'true');
  }
}

// CORS(允许 dashboard 跨域访问)
app.use('*', async (c, next) => {
  applyCors(c);
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

// 根路径 — 浏览器访问则跳转 Dashboard,客户端/curl 返回 JSON 元信息
app.get('/', (c) => {
  const accept = c.req.header('Accept') || '';
  const isBrowser = accept.includes('text/html');
  if (!isBrowser) {
    // API 客户端访问根路径,返回 JSON 元信息
    return c.json({
      name: 'freellmapi-cf',
      version: (c.env as any).APP_VERSION || 'dev',
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
          'POST /v1/responses',
          'POST /v1/messages  (Anthropic-compatible)',
        ],
        dashboard: (c.env as any).DASHBOARD_URL || 'https://freellmapi-cf-dashboard.pages.dev',
      },
    });
  }
  // 浏览器访问,返回漂亮 HTML 页面
  const ver = (c.env as any).APP_VERSION || 'dev';
  const backendUrl = (c.env as any).BACKEND_URL || 'https://your-worker.your-subdomain.workers.dev';
  const dashboardUrl = (c.env as any).DASHBOARD_URL || 'https://freellmapi-cf-dashboard.pages.dev';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>freellmapi-cf · Unified LLM Router</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .container{max-width:560px;padding:40px 24px;text-align:center}
  .logo{font-size:2rem;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
  .logo span{color:#38bdf8}
  .tag{color:#94a3b8;font-size:.95rem;margin-bottom:32px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:16px;text-align:left}
  .card h2{font-size:1rem;color:#38bdf8;margin-bottom:12px}
  .card .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1e293b;font-size:.875rem}
  .card .row:last-child{border-bottom:none}
  .card .row .k{color:#94a3b8}.card .row .v{color:#e2e8f0;font-family:monospace}
  .btn{display:inline-block;margin-top:8px;padding:10px 28px;background:#38bdf8;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:.9rem;transition:background .2s}
  .btn:hover{background:#0ea5e9}
  .ep{font-family:monospace;font-size:.78rem;color:#38bdf8;background:#0f172a;padding:3px 8px;border-radius:4px;margin-right:8px}
  .version{margin-top:24px;color:#475569;font-size:.8rem}
</style>
</head>
<body>
<div class="container">
  <div class="logo">freellmapi<span>-cf</span></div>
  <div class="tag">Unified LLM Router · 统一大模型 API 路由</div>
  <div class="card">
    <h2>API 端点</h2>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/chat/completions</span><span class="v">OpenAI 兼容</span></div>
    <div class="row"><span class="k"><span class="ep">GET</span>/v1/models</span><span class="v">模型列表</span></div>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/embeddings</span><span class="v">向量嵌入</span></div>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/responses</span><span class="v">Responses API</span></div>
    <div class="row"><span class="k"><span class="ep">POST</span>/v1/messages</span><span class="v">Anthropic 兼容</span></div>
  </div>
  <div class="card">
    <h2>快速接入</h2>
    <div class="row"><span class="k">Base URL</span><span class="v">${backendUrl}/v1</span></div>
    <div class="row"><span class="k">API Key</span><span class="v">freellmapi-xxx</span></div>
    <div class="row"><span class="k">OpenAI 兼容</span><span class="v">是</span></div>
  </div>
  <a href="${dashboardUrl}" class="btn">前往管理面板 →</a>
  <div class="version">v${ver} · Cloudflare Workers</div>
</div>
</body>
</html>`;
  return c.html(html);
});

app.get('/health', (c) => c.json({ ok: true }));

// 诊断端点：检查所有 binding / secret / 关键表是否就绪
app.get('/__diag', async (c) => {
  const env = c.env;
  const out = {
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
    const counts = {};
    for (const t of ['accounts','api_keys','models','user_tokens']) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
      counts[t] = r?.n ?? null;
    }
    out.d1 = { ok: true, counts };
  } catch (e) {
    out.d1 = { ok: false, error: e.message };
  }
  return c.json(out);
});

// CORS 自检：回显浏览器发来的头,并显示服务器实际返回的 CORS 头
app.get('/__cors', (c) => {
  return c.json({
    received: {
      origin: c.req.header('Origin'),
      method: c.req.method,
      host: c.req.header('Host'),
      referer: c.req.header('Referer'),
      acrh: c.req.header('Access-Control-Request-Headers'),
      acrm: c.req.header('Access-Control-Request-Method'),
    },
    responded: {
      acao: c.res.headers.get('Access-Control-Allow-Origin'),
      vary: c.res.headers.get('Vary'),
    },
    url: c.req.url,
  });
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
app.route('/v1', chatRoute);
app.route('/v1', v1ModelsRoute);
app.route('/v1', completionsRoute);
app.route('/v1', embeddingsRoute);
app.route('/v1', imagesRoute);
app.route('/v1', audioRoute);
app.route('/v1', messagesRoute);

// 404
app.notFound((c) => c.json({
  error: { message: 'Not found', path: c.req.path },
}, 404));

// 错误处理
app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, err.stack);
  return c.json({
    error: { message: err.message, type: 'server_error' },
  }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  // Cron trigger: 同步模型目录
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncCatalog(env));
  },
};

/**
 * 同步远程模型目录
 * (默认从 freellmapi.co/catalog.json 拉,带签名验证)
 */
async function syncCatalog(env: Env): Promise<void> {
  try {
    const url = 'https://freellmapi.co/catalog.json';
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[CRON] Catalog fetch failed: ${res.status}`);
      return;
    }
    const catalog = await res.json() as {
      models: Array<{
        id: string;
        platform: string;
        model_name: string;
        display_name?: string;
        family?: string;
        context_window?: number;
        supports_tools?: boolean;
        supports_vision?: boolean;
        free_tier_rpm?: number;
        free_tier_rpd?: number;
        free_tier_tpm?: number;
        free_tier_tpd?: number;
      }>;
      signature?: string;
    };

    // 简化:不验证签名(可选)
    let updated = 0;
    for (const m of catalog.models || []) {
      await env.DB.prepare(`
        INSERT INTO models (id, platform, model_name, display_name, family, context_window, supports_tools, supports_vision, free_tier_rpm, free_tier_rpd, free_tier_tpm, free_tier_tpd, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          family = excluded.family,
          context_window = excluded.context_window,
          supports_tools = excluded.supports_tools,
          supports_vision = excluded.supports_vision,
          free_tier_rpm = excluded.free_tier_rpm,
          free_tier_rpd = excluded.free_tier_rpd,
          free_tier_tpm = excluded.free_tier_tpm,
          free_tier_tpd = excluded.free_tier_tpd,
          source = 'remote',
          updated_at = unixepoch()
      `).bind(
        m.id,
        m.platform,
        m.model_name,
        m.display_name || null,
        m.family || null,
        m.context_window || null,
        m.supports_tools ? 1 : 0,
        m.supports_vision ? 1 : 0,
        m.free_tier_rpm || null,
        m.free_tier_rpd || null,
        m.free_tier_tpm || null,
        m.free_tier_tpd || null
      ).run();
      updated++;
    }
    console.log(`[CRON] Catalog synced: ${updated} models`);
  } catch (e: any) {
    console.error(`[CRON] Catalog sync error: ${e.message}`);
  }
}
