// ============================================================
// FreeLLM API - Authentication Middleware
// Verifies JWT tokens for admin routes or API keys for public routes.
// ============================================================

import type { Env, JwtPayload } from '../types';
import { verifyJwt, verifyApiKey, hashApiKey } from '../lib/crypto';
import { Db } from '../lib/db';

export interface AuthContext {
  authenticated: boolean;
  type: 'jwt' | 'api_key' | 'none';
  userId?: number;
  email?: string;
  role?: string;
  jwtPayload?: JwtPayload;
  apiKeyId?: number;
}

export async function authenticateAdmin(
  request: Request,
  env: Env
): Promise<{ auth: AuthContext; response?: Response }> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return {
      auth: { authenticated: false, type: 'none' },
      response: new Response(JSON.stringify({ success: false, error: '未提供认证令牌' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // Try JWT Bearer token
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = await verifyJwt(token, env.JWT_SECRET);

    if (!payload) {
      return {
        auth: { authenticated: false, type: 'none' },
        response: new Response(JSON.stringify({ success: false, error: '令牌无效或已过期' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }

    return {
      auth: {
        authenticated: true,
        type: 'jwt',
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
        jwtPayload: payload,
      },
    };
  }

  return {
    auth: { authenticated: false, type: 'none' },
    response: new Response(JSON.stringify({ success: false, error: '不支持的认证方式' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  db: Db
): Promise<{ auth: AuthContext; response?: Response }> {
  const authHeader = request.headers.get('Authorization');
  const apiKeyHeader = request.headers.get('X-API-Key');

  if (!authHeader && !apiKeyHeader) {
    return {
      auth: { authenticated: false, type: 'none' },
      response: new Response(JSON.stringify({ error: '未提供认证信息' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }

  // Try API key first (X-API-Key header or Bearer token)
  let keyToCheck = apiKeyHeader;

  if (!keyToCheck && authHeader && authHeader.startsWith('Bearer ')) {
    keyToCheck = authHeader.slice(7);
  }

  if (keyToCheck) {
    const keyHash = await hashApiKey(keyToCheck);
    const apiKey = await db.getApiKeyByHash(keyHash);

    if (apiKey && apiKey.is_active === 1) {
      // Check expiry
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        return {
          auth: { authenticated: false, type: 'none' },
          response: new Response(JSON.stringify({ error: 'API 密钥已过期' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        };
      }

      // Update last used timestamp (fire and forget)
      db.updateApiKeyLastUsed(apiKey.id).catch(() => {});

      return {
        auth: {
          authenticated: true,
          type: 'api_key',
          userId: apiKey.user_id,
          apiKeyId: apiKey.id,
        },
      };
    }
  }

  // Try JWT admin auth
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = await verifyJwt(token, env.JWT_SECRET);

    if (payload) {
      return {
        auth: {
          authenticated: true,
          type: 'jwt',
          userId: payload.sub,
          email: payload.email,
          role: payload.role,
          jwtPayload: payload,
        },
      };
    }
  }

  return {
    auth: { authenticated: false, type: 'none' },
    response: new Response(JSON.stringify({ error: '认证失败' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}