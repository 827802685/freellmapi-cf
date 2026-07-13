/**
 * Dashboard 认证 + 首次设置
 * - POST /api/auth/setup    首次创建账号
 * - POST /api/auth/login    登录
 * - POST /api/auth/logout   登出
 * - GET  /api/auth/me       当前用户
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { hashPassword, verifyPassword, randomB64Url } from '../../lib/crypto';
import { signDashboardSession, setSessionCookie, clearSessionCookie, requireDashboardAuth } from '../../lib/auth';
import { getSetting, setSetting } from '../../lib/response';

export const authRoute = new Hono<{ Bindings: Env }>();

authRoute.get('/setup-status', async (c) => {
  const done = await getSetting(c.env.DB, 'first_run_completed', 'false');
  return c.json({ firstRunCompleted: done === 'true' });
});

authRoute.post('/setup', async (c) => {
  const done = await getSetting(c.env.DB, 'first_run_completed', 'false');
  if (done === 'true') {
    return c.json({ error: { message: 'Setup already completed' } }, 400);
  }
  const body = await c.req.json<{ bootstrapCode: string; email: string; password: string }>();
  if (body.bootstrapCode !== c.env.ADMIN_BOOTSTRAP_CODE) {
    return c.json({ error: { message: 'Invalid bootstrap code' } }, 401);
  }
  if (body.password.length < 8) {
    return c.json({ error: { message: 'Password too short' } }, 400);
  }

  const hashed = await hashPassword(body.password);
  await c.env.DB.prepare(
    'INSERT INTO accounts (email, password_hash, password_salt) VALUES (?, ?, ?)'
  ).bind(body.email, hashed.hash, hashed.salt).run();

  await setSetting(c.env.DB, 'first_run_completed', 'true');

  const account = await c.env.DB.prepare('SELECT id, email FROM accounts WHERE email = ?')
    .bind(body.email).first<{ id: number; email: string }>();

  const token = await signDashboardSession({ accountId: account!.id, email: account!.email }, c.env.JWT_SECRET);
  setSessionCookie(c, token);
  return c.json({ ok: true, account });
});

authRoute.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const account = await c.env.DB.prepare(
    'SELECT id, email, password_hash, password_salt FROM accounts WHERE email = ?'
  ).bind(body.email).first<{ id: number; email: string; password_hash: string; password_salt: string }>();

  if (!account) {
    return c.json({ error: { message: 'Invalid credentials' } }, 401);
  }

  const ok = await verifyPassword(body.password, {
    hash: account.password_hash,
    salt: account.password_salt,
  });
  if (!ok) {
    return c.json({ error: { message: 'Invalid credentials' } }, 401);
  }

  await c.env.DB.prepare('UPDATE accounts SET last_login_at = unixepoch() WHERE id = ?').bind(account.id).run();

  const token = await signDashboardSession({ accountId: account.id, email: account.email }, c.env.JWT_SECRET);
  setSessionCookie(c, token);
  return c.json({ ok: true, account: { id: account.id, email: account.email } });
});

authRoute.post('/logout', async (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoute.get('/me', requireDashboardAuth, async (c) => {
  const session = c.get('session');
  return c.json({ account: session });
});
