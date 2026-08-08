// Admin management API for FreeLLMAPI
// All admin routes require JWT authentication

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import {
  verifyJWT,
  createJWT,
  hashPassword,
  verifyPassword,
  encryptAESGCM,
  decryptAESGCM,
  generateAPIKey,
  hashAPIKey,
} from '../../lib/crypto';
import type { Env, DashboardData, AdminStats, ProviderKey, ModelInfo } from '../../types';

interface AdminParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
}

// ============================================================
// Auth Helpers
// ============================================================

/**
 * Extract and verify JWT from the Authorization header.
 * Returns the user ID if valid, or null.
 */
async function getAdminUserId(request: Request, env: Env): Promise<number | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return null;

  const userId = Number(payload.sub);
  if (isNaN(userId)) return null;

  // Check if user has admin role
  const db = new DB(env.DB);
  const user = await db.getUserById(userId);
  if (!user || user.role !== 'admin') return null;

  return userId;
}

/**
 * Require admin authentication; returns a 401/403 response if not authorized.
 */
async function requireAdminAuth(request: Request, env: Env): Promise<{ userId: number } | Response> {
  const userId = await getAdminUserId(request, env);
  if (!userId) {
    return new Response(
      JSON.stringify({ error: { message: 'Authentication required', type: 'auth_error', code: 401 } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return { userId };
}

// ============================================================
// Route Handlers
// ============================================================

/**
 * GET /api/admin/stats - Dashboard statistics
 */
export async function handleAdminStats(params: AdminParams): Promise<Response> {
  const { request, env, ctx, db, cache } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const analyticsStats = await db.getAnalyticsStats(24);
    const modelCount = await db.getModelCount();
    const userCount = await db.getUserCount();
    const providerKeyCount = await db.getProviderKeyCount();

    // Get provider health info
    const providerKeys = await db.getProviderKeys();
    const providers = [...new Set(providerKeys.map(k => k.provider))];

    const stats: AdminStats = {
      requests: analyticsStats.totalRequests,
      models: modelCount,
      tokens: analyticsStats.totalTokens,
      users: userCount,
      providers: providers.length,
      uptime: 'unknown',
      version: '1.0.0',
      deployment: 'cloudflare-workers',
    };

    const data: DashboardData = {
      stats,
      providerUsage: analyticsStats.providerStats,
      recentEndpoints: analyticsStats.endpointStats,
      version: '1.0.0',
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /api/admin/keys - List provider keys
 */
export async function handleAdminListKeys(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const keys = await db.getProviderKeys();

    // Decrypt key data for display (masked)
    const maskedKeys = await Promise.all(
      keys.map(async (key) => {
        let maskedKey = '***';
        try {
          const decrypted = await decryptAESGCM(key.key_data, key.key_iv, key.key_tag, env.ENCRYPTION_KEY);
          maskedKey = decrypted.length > 8
            ? decrypted.slice(0, 4) + '****' + decrypted.slice(-4)
            : '***';
        } catch {
          // Keep masked on error
        }

        return {
          id: key.id,
          provider: key.provider,
          label: key.label,
          base_url: key.base_url,
          status: key.status,
          key_preview: maskedKey,
          last_checked: key.last_checked,
          error_count: key.error_count,
          cooldown_until: key.cooldown_until,
          created_at: key.created_at,
          updated_at: key.updated_at,
        };
      })
    );

    return new Response(JSON.stringify({ keys: maskedKeys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/keys - Add provider key
 */
export async function handleAdminAddKey(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json() as {
      provider: string;
      key: string;
      label?: string;
      base_url?: string;
    };

    if (!body.provider || !body.key) {
      return new Response(
        JSON.stringify({ error: { message: 'Missing required fields: provider, key', type: 'invalid_request_error', code: 400 } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Encrypt the provider API key
    const encrypted = await encryptAESGCM(body.key, env.ENCRYPTION_KEY);

    const newKey = await db.createProviderKey(
      body.provider.toLowerCase(),
      encrypted.data,
      encrypted.iv,
      encrypted.tag,
      body.label,
      body.base_url || undefined
    );

    return new Response(
      JSON.stringify({
        message: 'Provider key added successfully',
        key: {
          id: newKey.id,
          provider: newKey.provider,
          label: newKey.label,
          base_url: newKey.base_url,
          status: newKey.status,
          created_at: newKey.created_at,
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * DELETE /api/admin/keys/:id - Delete provider key
 */
export async function handleAdminDeleteKey(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    // Extract key ID from URL path
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const keyId = parseInt(pathParts[pathParts.length - 1], 10);

    if (isNaN(keyId)) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid key ID', type: 'invalid_request_error', code: 400 } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const existing = await db.getProviderKeyById(keyId);
    if (!existing) {
      return new Response(
        JSON.stringify({ error: { message: 'Provider key not found', type: 'not_found', code: 404 } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await db.deleteProviderKey(keyId);

    return new Response(
      JSON.stringify({ message: 'Provider key deleted successfully', id: keyId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/keys/check - Check key health
 */
export async function handleAdminCheckKeys(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json() as { key_ids?: number[] };
    const keys = body.key_ids
      ? await Promise.all(body.key_ids.map(id => db.getProviderKeyById(id)))
      : await db.getProviderKeys();

    const validKeys = keys.filter((k): k is ProviderKey => k !== null);
    const results = await Promise.all(
      validKeys.map(async (key) => {
        try {
          const apiKey = await decryptAESGCM(key.key_data, key.key_iv, key.key_tag, env.ENCRYPTION_KEY);
          const baseUrl = key.base_url || `https://api.${key.provider}.com`;
          const startTime = Date.now();

          // Simple health check: list models endpoint
          const response = await fetch(`${baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000),
          });

          const latencyMs = Date.now() - startTime;
          const ok = response.ok || response.status === 401; // 401 means key is valid but may not have model list access

          if (ok) {
            await db.updateProviderKeyChecked(key.id);
          } else {
            await db.updateProviderKeyStatus(key.id, 'error', (key.error_count || 0) + 1, undefined);
          }

          return {
            id: key.id,
            provider: key.provider,
            label: key.label,
            ok,
            status: ok ? 'active' : 'error',
            latency_ms: latencyMs,
            status_code: response.status,
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await db.updateProviderKeyStatus(key.id, 'error', (key.error_count || 0) + 1, undefined);

          return {
            id: key.id,
            provider: key.provider,
            label: key.label,
            ok: false,
            status: 'error',
            latency_ms: 0,
            error: errorMessage,
          };
        }
      })
    );

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /api/admin/models - List models
 */
export async function handleAdminListModels(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const provider = url.searchParams.get('provider') || undefined;
    const models = await db.getModels(provider);

    // Also include disabled models
    const allModelsResult = await (db as unknown as { getAllModels(): Promise<ModelInfo[]> }).getAllModels?.() || models;

    return new Response(
      JSON.stringify({ models: allModelsResult }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/models/sync - Sync models from catalog
 */
export async function handleAdminSyncModels(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const catalogUrl = env.CATALOG_URL;
    if (!catalogUrl) {
      return new Response(
        JSON.stringify({ error: { message: 'CATALOG_URL not configured', type: 'config_error', code: 500 } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const response = await fetch(catalogUrl);
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: { message: 'Failed to fetch catalog', type: 'upstream_error', code: 502 } }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const catalog = await response.json() as { models: Array<Omit<ModelInfo, 'id'>>; version?: string };

    let syncedCount = 0;
    for (const model of catalog.models) {
      await db.upsertModel(model);
      syncedCount++;
    }

    // Store catalog meta
    if (catalog.version) {
      await db.setCatalogMeta(catalog.version, JSON.stringify(catalog));
    }

    return new Response(
      JSON.stringify({
        message: 'Models synced successfully',
        synced_count: syncedCount,
        version: catalog.version || 'unknown',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /api/admin/analytics - Get analytics data
 */
export async function handleAdminAnalytics(params: AdminParams): Promise<Response> {
  const { request, env, ctx, db } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);

    const stats = await db.getAnalyticsStats(Math.min(hours, 168)); // Max 7 days

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /api/admin/settings - Get settings
 */
export async function handleAdminGetSettings(params: AdminParams): Promise<Response> {
  const { request, env, cache } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const settings = await cache.get<Record<string, unknown>>('admin:settings');
    return new Response(
      JSON.stringify({
        settings: settings || {
          site_title: env.SITE_TITLE || 'FreeLLMAPI',
          catalog_url: env.CATALOG_URL || '',
          default_rate_limit_rpm: 60,
          default_rate_limit_rpd: 10000,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/settings - Update settings
 */
export async function handleAdminUpdateSettings(params: AdminParams): Promise<Response> {
  const { request, env, cache } = params;

  const auth = await requireAdminAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json() as Record<string, unknown>;
    const currentSettings = await cache.get<Record<string, unknown>>('admin:settings') || {};
    const updatedSettings = { ...currentSettings, ...body };

    await cache.set('admin:settings', updatedSettings);

    return new Response(
      JSON.stringify({
        message: 'Settings updated successfully',
        settings: updatedSettings,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/auth/login - Login
 */
export async function handleAdminLogin(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  try {
    const body = await request.json() as { email: string; password: string };

    if (!body.email || !body.password) {
      return new Response(
        JSON.stringify({ error: { message: 'Email and password are required', type: 'invalid_request_error', code: 400 } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const user = await db.getUserByEmail(body.email);
    if (!user) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid credentials', type: 'auth_error', code: 401 } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid credentials', type: 'auth_error', code: 401 } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Generate JWT token (1 hour expiry)
    const token = await createJWT(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      env.JWT_SECRET
    );

    // Generate API key for the session
    const apiKey = generateAPIKey('admin');

    return new Response(
      JSON.stringify({
        token,
        api_key: apiKey,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * POST /api/admin/auth/verify - Verify JWT token
 */
export async function handleAdminVerifyToken(params: AdminParams): Promise<Response> {
  const { request, env, db } = params;

  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ valid: false, error: 'No token provided' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.slice(7).trim();
    const payload = await verifyJWT(token, env.JWT_SECRET);

    if (!payload) {
      return new Response(
        JSON.stringify({ valid: false, error: 'Invalid or expired token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userId = Number(payload.sub);
    const user = !isNaN(userId) ? await db.getUserById(userId) : null;

    return new Response(
      JSON.stringify({
        valid: true,
        user: user ? {
          id: user.id,
          email: user.email,
          role: user.role,
        } : null,
        payload: {
          sub: payload.sub,
          email: payload.email,
          role: payload.role,
          exp: payload.exp,
          iat: payload.iat,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ valid: false, error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ============================================================
// Router
// ============================================================

/**
 * Route admin API requests to the appropriate handler.
 */
export async function handleAdminRoute(params: AdminParams): Promise<Response> {
  const { request } = params;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Auth routes (no auth required)
  if (method === 'POST' && path === '/api/admin/auth/login') {
    return handleAdminLogin(params);
  }
  if (method === 'POST' && path === '/api/admin/auth/verify') {
    return handleAdminVerifyToken(params);
  }

  // Protected routes (auth required)
  if (method === 'GET' && path === '/api/admin/stats') {
    return handleAdminStats(params);
  }

  if (path === '/api/admin/keys' || path.startsWith('/api/admin/keys/')) {
    if (method === 'GET') {
      return handleAdminListKeys(params);
    }
    if (method === 'POST') {
      return handleAdminAddKey(params);
    }
    if (method === 'DELETE') {
      return handleAdminDeleteKey(params);
    }
  }

  if (method === 'POST' && path === '/api/admin/keys/check') {
    return handleAdminCheckKeys(params);
  }

  if (method === 'GET' && path === '/api/admin/models') {
    return handleAdminListModels(params);
  }
  if (method === 'POST' && path === '/api/admin/models/sync') {
    return handleAdminSyncModels(params);
  }

  if (method === 'GET' && path === '/api/admin/analytics') {
    return handleAdminAnalytics(params);
  }

  if (path === '/api/admin/settings') {
    if (method === 'GET') return handleAdminGetSettings(params);
    if (method === 'POST') return handleAdminUpdateSettings(params);
  }

  // 404 for unknown routes
  return new Response(
    JSON.stringify({ error: { message: 'Not found', type: 'not_found', code: 404 } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}