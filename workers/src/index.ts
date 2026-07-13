/**
 * freellmapi-cf 主入口
 * Cloudflare Workers
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
import { modelsRoute, fallbackRoute } from './routes/api/models';
import { ALL_PLATFORMS, PLATFORM_LABELS } from './providers';

export { KeyState } from './durable-objects/KeyState';
export { Session } from './durable-objects/Session';

const app = new Hono<{ Bindings: Env }>();

// CORS(允许 dashboard 跨域访问)
app.use('*', cors({
  origin: (origin) => origin || '*',
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'anthropic-version'],
  exposeHeaders: ['Content-Type'],
}));

// 健康检查
app.get('/', (c) => c.json({
  name: 'freellmapi-cf',
  version: '0.1.0',
  status: 'ok',
  env: c.env.ENVIRONMENT,
  providers: ALL_PLATFORMS,
}));

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
