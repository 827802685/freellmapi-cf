// ============================================================
// FreeLLM API - CORS Middleware
// ============================================================

import type { Env } from '../types';

const DEFAULT_ALLOWED_ORIGINS = '*';

export function getCorsHeaders(env: Env): Record<string, string> {
  const allowedOrigins = env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;

  return {
    'Access-Control-Allow-Origin': allowedOrigins,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export function handleCors(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;

  const headers = getCorsHeaders(env);
  return new Response(null, {
    status: 204,
    headers,
  });
}

export function addCorsHeaders(response: Response, env: Env): Response {
  const headers = getCorsHeaders(env);
  const newHeaders = new Headers(response.headers);

  for (const [key, value] of Object.entries(headers)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}