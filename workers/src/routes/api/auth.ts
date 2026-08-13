/**
 * Dashboard 认证 + 首次设置
 * - POST /api/auth/setup    首次创建账号
 * - POST /api/auth/login    登录
 * - POST /api/auth/logout   登出
 * - GET  /api/auth/me       当前用户
 *
 * 安全措施:
 * - 输入类型强制校验(防止对象/数组注入 D1)
 * - IP 速率限制(防止暴力破解)
 * - try/catch 归一化错误响应(不泄露内部细节)
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { hashPassword, verifyPassword, randomB64Url } from '../../lib/crypto';
import { signDashboardSession, setSessionCookie, clearSessionCookie, requireDashboardAuth } from '../../lib/auth';
import { getSetting, setSetting } from '../../lib/response';
import { rateLimit } from '../../lib/ratelimit';

export const authRoute = new Hono<{ Bindings: Env }>();

authRoute.get('/setup-status', async (c) => {
  const done = await getSetting(c.env.DB, 'first_run_completed', 'false');
  return c.json({ firstRunCompleted: done === 'true' });
});

authRoute.post('/setup', rateLimit(5, 900, 'setup'), async (c) => {
  try {
    const done = await getSetting(c.env.DB, 'first_run_completed', 'false');
    if (done === 'true') {
      return c.json({ error: { message: 'Setup already completed' } }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: { message: 'Invalid request body' } }, 400);
    }

    // 强制类型校验:email/password/bootstrapCode 必须是字符串
    const { bootstrapCode, email, password } = body;
    if (typeof bootstrapCode !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: { message: 'Invalid input types' } }, 400);
    }

    if (bootstrapCode !== c.env.ADMIN_BOOTSTRAP_CODE) {
      return c.json({ error: { message: 'Invalid bootstrap code' } }, 401);
    }
    if (password.length < 8) {
      return c.json({ error: { message: 'Password too short' } }, 400);
    }
    if (!email.includes('@') || email.length > 255) {
      return c.json({ error: { message: 'Invalid email' } }, 400);
    }

    const hashed = await hashPassword(password);
    await c.env.DB.prepare(
      'INSERT INTO accounts (email, password_hash, password_salt) VALUES (?, ?, ?)'
    ).bind(email, hashed.hash, hashed.salt).run();

    await setSetting(c.env.DB, 'first_run_completed', 'true');

    const account = await c.env.DB.prepare('SELECT id, email FROM accounts WHERE email = ?')
      .bind(email).first<{ id: number; email: string }>();

    const token = await signDashboardSession({ accountId: account!.id, email: account!.email }, c.env.JWT_SECRET);
    setSessionCookie(c, token);
    return c.json({ ok: true, account, token });
  } catch (e: unknown) {
    console.error('[auth/setup] error:', e);
    return c.json({ error: { message: 'Setup failed' } }, 500);
  }
});

authRoute.post('/login', rateLimit(10, 900, 'login'), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: { message: 'Invalid request body' } }, 400);
    }

    // 强制类型校验:email/password 必须是字符串
    const { email, password } = body;
    if (typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: { message: 'Invalid credentials' } }, 401);
    }

    // 限制输入长度,防止超长字符串攻击
    if (email.length > 255 || password.length > 1000) {
      return c.json({ error: { message: 'Invalid credentials' } }, 401);
    }

    const account = await c.env.DB.prepare(
      'SELECT id, email, password_hash, password_salt FROM accounts WHERE email = ?'
    ).bind(email).first<{ id: number; email: string; password_hash: string; password_salt: string }>();

    // 统一错误信息,不区分用户是否存在
    if (!account) {
      return c.json({ error: { message: 'Invalid credentials' } }, 401);
    }

    const ok = await verifyPassword(password, {
      hash: account.password_hash,
      salt: account.password_salt,
    });
    if (!ok) {
      return c.json({ error: { message: 'Invalid credentials' } }, 401);
    }

    await c.env.DB.prepare('UPDATE accounts SET last_login_at = unixepoch() WHERE id = ?').bind(account.id).run();

    const token = await signDashboardSession({ accountId: account.id, email: account.email }, c.env.JWT_SECRET);
    setSessionCookie(c, token);
    return c.json({ ok: true, account: { id: account.id, email: account.email }, token });
  } catch (e: unknown) {
    console.error('[auth/login] error:', e);
    // 不泄露内部错误细节
    return c.json({ error: { message: 'Invalid credentials' } }, 401);
  }
});

authRoute.post('/logout', async (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoute.get('/me', requireDashboardAuth, async (c) => {
  const session = c.get('session');
  return c.json({ account: session });
});
