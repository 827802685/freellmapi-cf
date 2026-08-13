/**
 * 认证模块
 * - JWT 签发与校验
 * - Session token 持久化
 * - 统一 API key 校验(用于 /v1/* 调用)
 */

import { SignJWT, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { sha256Hex, randomToken, randomB64Url } from './crypto';
import type { Env } from '../types';

// ============= JWT =============

const JWT_ISSUER = 'freellmapi-cf';
const JWT_AUDIENCE = 'freellmapi-dashboard';
const COOKIE_NAME = 'fl_session';
const SESSION_TTL_DAYS = 7;

function getJwtSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface DashboardSession {
  accountId: number;
  email: string;
}

export async function signDashboardSession(
  payload: DashboardSession,
  jwtSecret: string
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .sign(getJwtSecret(jwtSecret));
}

export async function verifyDashboardSession(
  token: string,
  jwtSecret: string
): Promise<DashboardSession | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(jwtSecret), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (typeof payload.accountId !== 'number' || typeof payload.email !== 'string') {
      return null;
    }
    return { accountId: payload.accountId, email: payload.email };
  } catch {
    return null;
  }
}

// ============= Hono 中间件 =============

declare module 'hono' {
  interface ContextVariableMap {
    session: DashboardSession;
    userToken: UserToken;
  }
}

export async function requireDashboardAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const token =
    getCookie(c, COOKIE_NAME) ||
    c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const session = await verifyDashboardSession(token, c.env.JWT_SECRET);
  if (!session) {
    return c.json({ error: 'invalid_session' }, 401);
  }

  c.set('session', session);
  await next();
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context) {
  setCookie(c, COOKIE_NAME, '', {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  });
}

// ============= 统一 API Key(客户端调用 /v1 用) =============

export interface UserToken {
  id: number;
  token_hint: string;
  enabled: number;
}

/**
 * 从 Authorization 头或 x-api-key 头提取并验证统一 API key
 *
 * 兼容性:
 * 1. Authorization: Bearer freellmapi-xxx (标准格式)
 * 2. Authorization: Bearer xxx (无前缀,自动补 freellmapi-)
 * 3. x-api-key: freellmapi-xxx (部分 OpenAI 兼容客户端用此头)
 * 4. x-api-key: xxx (无前缀)
 */
export async function authenticateUserToken(
  c: Context<{ Bindings: Env }>
): Promise<UserToken | null> {
  // 提取原始 key — 优先 Authorization Bearer,其次 x-api-key
  let rawKey: string | null = null;

  const auth = c.req.header('Authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      rawKey = match[1].trim();
    }
  }

  if (!rawKey) {
    const xApiKey = c.req.header('x-api-key');
    if (xApiKey) {
      rawKey = xApiKey.trim();
    }
  }

  if (!rawKey) return null;

  // 尝试两种格式:原始 key 和补前缀的 key
  // 用户可能只复制了随机部分,没带 freellmapi- 前缀
  const candidates = rawKey.startsWith('freellmapi-')
    ? [rawKey]
    : [`freellmapi-${rawKey}`, rawKey];

  for (const plaintext of candidates) {
    const tokenHash = await sha256Hex(plaintext);

    const row = await c.env.DB.prepare(
      'SELECT id, token_hint, enabled FROM user_tokens WHERE token_hash = ?'
    ).bind(tokenHash).first<UserToken>();

    if (row && row.enabled) {
      // 更新 last_used_at 和 request_count(异步,失败不影响)
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          'UPDATE user_tokens SET last_used_at = unixepoch(), request_count = request_count + 1 WHERE id = ?'
        ).bind(row.id).run()
      );
      return row;
    }
  }

  return null;
}

export async function requireUserToken(c: Context<{ Bindings: Env }>, next: Next) {
  const token = await authenticateUserToken(c);
  if (!token) {
    return c.json({
      error: {
        message: 'Invalid API key. Pass a Bearer token in Authorization header.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    }, 401);
  }
  c.set('userToken', token);
  await next();
}
