// ============================================================
// FreeLLM API - Cloudflare Worker Entry Point
// ============================================================

import type { Env } from './types';
import { Db } from './lib/db';
import { handleCors, addCorsHeaders } from './middleware/cors';
import { authenticateRequest } from './middleware/auth';

// Route handlers
import { handleLogin, handleVerifyToken, handleStats, handleListKeys, handleCreateKey, handleUpdateKey, handleDeleteKey, handleListModels as adminListModels, handleUpdateModel, handleAnalytics, handleGetSettings, handleUpdateSettings, handleListProviderKeys, handleCreateProviderKey, handleUpdateProviderKey, handleDeleteProviderKey } from './routes/api/admin';
import { handleChatCompletion } from './routes/v1/chat';
import { handleListModels } from './routes/v1/models';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    const corsResponse = handleCors(request, env);
    if (corsResponse) return corsResponse;

    // Initialize database
    const db = new Db(env.DB);

    try {
      // Route matching
      let response: Response;

      // ---- Admin Auth Routes ----
      if (path === '/api/admin/auth/login' && method === 'POST') {
        response = await handleLogin(request, env, db);
      } else if (path === '/api/admin/auth/verify' && method === 'GET') {
        response = await handleVerifyToken(request, env, db);
      }
      // ---- Admin Stats ----
      else if (path === '/api/admin/stats' && method === 'GET') {
        response = await handleStats(request, env, db);
      }
      // ---- Admin Keys ----
      else if (path === '/api/admin/keys' && method === 'GET') {
        response = await handleListKeys(request, env, db);
      } else if (path === '/api/admin/keys' && method === 'POST') {
        response = await handleCreateKey(request, env, db);
      } else if (path.match(/^\/api\/admin\/keys\/\d+$/) && method === 'PATCH') {
        response = await handleUpdateKey(request, env, db);
      } else if (path.match(/^\/api\/admin\/keys\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteKey(request, env, db);
      }
      // ---- Admin Provider Keys ----
      else if (path === '/api/admin/provider-keys' && method === 'GET') {
        response = await handleListProviderKeys(request, env, db);
      } else if (path === '/api/admin/provider-keys' && method === 'POST') {
        response = await handleCreateProviderKey(request, env, db);
      } else if (path.match(/^\/api\/admin\/provider-keys\/\d+$/) && method === 'PATCH') {
        response = await handleUpdateProviderKey(request, env, db);
      } else if (path.match(/^\/api\/admin\/provider-keys\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteProviderKey(request, env, db);
      }
      // ---- Admin Models ----
      else if (path === '/api/admin/models' && method === 'GET') {
        response = await adminListModels(request, env, db);
      } else if (path.match(/^\/api\/admin\/models\/.+$/) && method === 'PATCH') {
        response = await handleUpdateModel(request, env, db);
      }
      // ---- Admin Analytics ----
      else if (path === '/api/admin/analytics' && method === 'GET') {
        response = await handleAnalytics(request, env, db);
      }
      // ---- Admin Settings ----
      else if (path === '/api/admin/settings' && method === 'GET') {
        response = await handleGetSettings(request, env, db);
      } else if (path === '/api/admin/settings' && method === 'POST') {
        response = await handleUpdateSettings(request, env, db);
      }
      // ---- API Routes (require API key or JWT) ----
      else if (path === '/v1/chat/completions' && method === 'POST') {
        const { auth, response: authResponse } = await authenticateRequest(request, env, db);
        if (authResponse) return addCorsHeaders(authResponse, env);
        response = await handleChatCompletion(request, env, db, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
        });
      } else if (path === '/v1/models' && method === 'GET') {
        const { auth, response: authResponse } = await authenticateRequest(request, env, db);
        if (authResponse) return addCorsHeaders(authResponse, env);
        response = await handleListModels(request, env, db);
      }
      // ---- Serve Dashboard ----
      else if (path === '/' || path.startsWith('/dashboard')) {
        response = await serveDashboard(request, env);
      }
      // ---- 404 ----
      else {
        response = new Response(
          JSON.stringify({ error: 'Not Found', path }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return addCorsHeaders(response, env);
    } catch (error) {
      console.error('Unhandled error:', error);
      return addCorsHeaders(
        new Response(
          JSON.stringify({ error: '服务器内部错误', detail: error instanceof Error ? error.message : '未知错误' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        ),
        env
      );
    }
  },
};

async function serveDashboard(request: Request, env: Env): Promise<Response> {
  try {
    // In production, the dashboard HTML would be embedded or loaded from KV/assets
    // For now, return a simple redirect or inline HTML
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FreeLLM API - 管理面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f13;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #10b981; font-size: 2.5rem; margin-bottom: 1rem; }
    p { color: #888; font-size: 1.1rem; margin-bottom: 2rem; }
    .links { display: flex; gap: 1rem; justify-content: center; }
    a {
      color: #10b981;
      text-decoration: none;
      padding: 0.75rem 1.5rem;
      border: 1px solid #10b981;
      border-radius: 8px;
      transition: all 0.2s;
    }
    a:hover { background: #10b981; color: #0f0f13; }
  </style>
</head>
<body>
  <div class="container">
    <h1>FreeLLM API</h1>
    <p>管理面板已加载。请查看 /dashboard/index.html 获取完整的管理界面。</p>
    <div class="links">
      <a href="/api/admin/stats">API 统计</a>
      <a href="/v1/models">模型列表</a>
    </div>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error) {
    return new Response('Dashboard load failed', { status: 500 });
  }
}