/**
 * 通用响应辅助
 */
import type { Context } from 'hono';
import type { Env } from '../types';

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json(data, status);
}

export function err(c: Context, message: string, status = 400, code?: string) {
  return c.json({ error: { message, type: 'api_error', code: code || message } }, status);
}

export function notFound(c: Context, message = 'Not found') {
  return err(c, message, 404, 'not_found');
}

export function unauthorized(c: Context, message = 'Unauthorized') {
  return err(c, message, 401, 'unauthorized');
}

export function badRequest(c: Context, message: string) {
  return err(c, message, 400, 'invalid_request_error');
}

export function serverError(c: Context, message = 'Internal server error') {
  return err(c, message, 500, 'server_error');
}

export async function getSetting(db: D1Database, key: string, defaultValue = ''): Promise<string> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? defaultValue;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()'
  ).bind(key, value).run();
}
