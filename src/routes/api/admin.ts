// ============================================================
// FreeLLM API - Admin Routes
// Handles login, stats, key management, model management,
// analytics, and settings.
// ============================================================

import type { Env, ApiResponse, AdminStats, ApiKey, ProviderKey, ModelInfo, AnalyticsRecord, Settings } from '../../types';
import { Db } from '../../lib/db';
import { hashPassword, verifyPassword, createJwt, verifyJwt, sha256, encryptAesGcm, decryptAesGcm, generateApiKeySync, hashApiKey } from '../../lib/crypto';
import { AnalyticsService } from '../../services/analytics';
import { authenticateAdmin } from '../../middleware/auth';

// ==================== Auth Handlers ====================

export async function handleLogin(request: Request, env: Env, db: Db): Promise<Response> {
  try {
    const body = await request.json();
    const { email, password } = body as { email: string; password: string };

    if (!email || !password) {
      return jsonResponse({ success: false, error: '请提供邮箱和密码' }, 400);
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      return jsonResponse({ success: false, error: '邮箱或密码错误' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return jsonResponse({ success: false, error: '邮箱或密码错误' }, 401);
    }

    const token = await createJwt(
      { sub: user.id, email: user.email, role: user.role },
      env.JWT_SECRET,
      env.SESSION_EXPIRY_HOURS || 24
    );

    // Store session
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + (env.SESSION_EXPIRY_HOURS || 24) * 3600 * 1000).toISOString();
    await db.createSession(user.id, tokenHash, expiresAt);

    return jsonResponse({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '登录失败',
    }, 500);
  }
}

export async function handleVerifyToken(request: Request, env: Env, db: Db): Promise<Response> {
  const { auth, response } = await authenticateAdmin(request, env);
  if (response) return response;

  return jsonResponse({
    success: true,
    data: {
      user: {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
      },
    },
  });
}

// ==================== Stats Handler ====================

export async function handleStats(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const analyticsService = new AnalyticsService(db);
    const stats = await analyticsService.getStats();
    return jsonResponse({ success: true, data: stats });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取统计数据失败',
    }, 500);
  }
}

// ==================== Key Management ====================

export async function handleListKeys(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(url.searchParams.get('page_size') || '20', 10);

    const { keys, total } = await db.getApiKeys(page, pageSize);

    // Remove sensitive fields
    const sanitizedKeys = keys.map((k: ApiKey) => ({
      ...k,
      key_hash: undefined,
      key_encrypted: undefined,
    }));

    return jsonResponse({
      success: true,
      data: sanitizedKeys,
      pagination: { page, page_size: pageSize, total },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取密钥列表失败',
    }, 500);
  }
}

export async function handleCreateKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const body = await request.json() as {
      name: string;
      rate_limit?: number;
      expires_at?: string;
    };

    if (!body.name) {
      return jsonResponse({ success: false, error: '请提供密钥名称' }, 400);
    }

    const { plaintext, prefix } = generateApiKeySync();
    const keyHash = await hashApiKey(plaintext);
    const keyEncrypted = await encryptAesGcm(plaintext, env.ENCRYPTION_KEY);

    const newKey = await db.createApiKey(
      prefix,
      keyHash,
      keyEncrypted,
      body.name,
      1, // admin user ID
      body.rate_limit || 60,
      body.expires_at || null
    );

    return jsonResponse({
      success: true,
      data: {
        id: newKey.id,
        key_prefix: newKey.key_prefix,
        name: newKey.name,
        plaintext_key: plaintext, // Only shown once on creation
        is_active: newKey.is_active,
        rate_limit: newKey.rate_limit,
        created_at: newKey.created_at,
        expires_at: newKey.expires_at,
      },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '创建密钥失败',
    }, 500);
  }
}

export async function handleUpdateKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const id = parseInt(url.pathname.split('/').pop() || '0', 10);
    if (!id) {
      return jsonResponse({ success: false, error: '无效的密钥 ID' }, 400);
    }

    const body = await request.json() as { is_active?: number };
    if (body.is_active === undefined) {
      return jsonResponse({ success: false, error: '请提供要更新的字段' }, 400);
    }

    await db.updateApiKeyStatus(id, body.is_active);
    return jsonResponse({ success: true, data: { id, is_active: body.is_active } });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '更新密钥失败',
    }, 500);
  }
}

export async function handleDeleteKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const id = parseInt(url.pathname.split('/').pop() || '0', 10);
    if (!id) {
      return jsonResponse({ success: false, error: '无效的密钥 ID' }, 400);
    }

    await db.deleteApiKey(id);
    return jsonResponse({ success: true, data: { id } });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '删除密钥失败',
    }, 500);
  }
}

// ==================== Model Management ====================

export async function handleListModels(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const models = await db.getModels(false);
    return jsonResponse({ success: true, data: models });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取模型列表失败',
    }, 500);
  }
}

export async function handleUpdateModel(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const modelId = url.pathname.split('/').pop() || '';
    if (!modelId) {
      return jsonResponse({ success: false, error: '无效的模型 ID' }, 400);
    }

    const body = await request.json() as { is_active?: number; display_name?: string };
    await db.updateModel(modelId, body);
    return jsonResponse({ success: true, data: { model_id: modelId, ...body } });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '更新模型失败',
    }, 500);
  }
}

// ==================== Analytics Handler ====================

export async function handleAnalytics(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
    const model = url.searchParams.get('model') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;

    const analyticsService = new AnalyticsService(db);
    const result = await analyticsService.getAnalyticsList(page, pageSize, { model, status, from, to });

    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取分析数据失败',
    }, 500);
  }
}

// ==================== Settings Handler ====================

export async function handleGetSettings(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const settings = await db.getAllSettings();
    const settingsMap: Record<string, string> = {};
    for (const s of settings) {
      settingsMap[s.key] = s.value;
    }
    return jsonResponse({ success: true, data: settingsMap });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取设置失败',
    }, 500);
  }
}

export async function handleUpdateSettings(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const body = await request.json() as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      await db.setSetting(key, value);
    }
    return jsonResponse({ success: true, data: body });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '更新设置失败',
    }, 500);
  }
}

// ==================== Provider Key Management ====================

export async function handleListProviderKeys(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const keys = await db.getProviderKeys();
    // Remove encrypted values
    const sanitized = keys.map((k: ProviderKey) => ({
      ...k,
      key_encrypted: undefined,
      key_prefix: k.key_prefix,
    }));
    return jsonResponse({ success: true, data: sanitized });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '获取提供商密钥失败',
    }, 500);
  }
}

export async function handleCreateProviderKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const body = await request.json() as {
      provider: string;
      api_key: string;
      base_url?: string;
      priority?: number;
    };

    if (!body.provider || !body.api_key) {
      return jsonResponse({ success: false, error: '请提供提供商名称和 API 密钥' }, 400);
    }

    const keyPrefix = body.api_key.substring(0, 8) + '...';
    const keyEncrypted = await encryptAesGcm(body.api_key, env.ENCRYPTION_KEY);

    const newKey = await db.createProviderKey(
      body.provider,
      keyEncrypted,
      keyPrefix,
      body.base_url || null,
      body.priority || 0
    );

    return jsonResponse({ success: true, data: newKey });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '创建提供商密钥失败',
    }, 500);
  }
}

export async function handleUpdateProviderKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const id = parseInt(url.pathname.split('/').pop() || '0', 10);
    if (!id) {
      return jsonResponse({ success: false, error: '无效的密钥 ID' }, 400);
    }

    const body = await request.json() as { is_active?: number; priority?: number; base_url?: string };
    await db.updateProviderKey(id, body);
    return jsonResponse({ success: true, data: { id, ...body } });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '更新提供商密钥失败',
    }, 500);
  }
}

export async function handleDeleteProviderKey(request: Request, env: Env, db: Db): Promise<Response> {
  const { response } = await authenticateAdmin(request, env);
  if (response) return response;

  try {
    const url = new URL(request.url);
    const id = parseInt(url.pathname.split('/').pop() || '0', 10);
    if (!id) {
      return jsonResponse({ success: false, error: '无效的密钥 ID' }, 400);
    }

    await db.deleteProviderKey(id);
    return jsonResponse({ success: true, data: { id } });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : '删除提供商密钥失败',
    }, 500);
  }
}

// ==================== Utility ====================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}