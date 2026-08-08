// Authentication middleware for FreeLLMAPI
// Supports JWT token and API key authentication

import { DB } from '../lib/db';
import { hashAPIKey, verifyJWT } from '../lib/crypto';
import type { User, ApiKey, Env } from '../types';

export interface AuthResult {
  user: User | null;
  apiKey: ApiKey | null;
}

/**
 * Verify authentication from the incoming request.
 * Checks Authorization header for Bearer token.
 * Attempts JWT verification first, then falls back to API key lookup.
 */
export async function verifyAuth(
  request: Request,
  env: Env,
  db: DB
): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, apiKey: null };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { user: null, apiKey: null };
  }

  // Try JWT verification first
  const jwtPayload = await verifyJWT(token, env.JWT_SECRET);
  if (jwtPayload && jwtPayload.sub) {
    const userId = Number(jwtPayload.sub);
    if (!isNaN(userId)) {
      const user = await db.getUserById(userId);
      if (user) {
        return { user, apiKey: null };
      }
    }
  }

  // Fall back to API key authentication
  const keyHash = await hashAPIKey(token);
  const apiKey = await db.getApiKeyByHash(keyHash);
  if (apiKey) {
    // Check if the key has expired
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return { user: null, apiKey: null };
    }

    // Update last used timestamp (fire-and-forget)
    db.updateApiKeyLastUsed(apiKey.id).catch(() => {});

    return { user: null, apiKey };
  }

  return { user: null, apiKey: null };
}

/**
 * Require authentication; returns 401 if not authenticated.
 */
export function requireAuth(result: AuthResult): Response | null {
  if (!result.user && !result.apiKey) {
    return new Response(
      JSON.stringify({ error: { message: 'Authentication required', type: 'auth_error', code: 401 } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}

/**
 * Require admin role; returns 403 if not an admin.
 */
export function requireAdmin(result: AuthResult): Response | null {
  const authError = requireAuth(result);
  if (authError) return authError;

  if (!result.user || result.user.role !== 'admin') {
    return new Response(
      JSON.stringify({ error: { message: 'Admin access required', type: 'auth_error', code: 403 } },
    ),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}