/**
 * IP-based rate limiting using KV (sliding window)
 * 用于防止登录暴力破解和 API key 枚举
 */

import type { Context } from 'hono';
import type { Env } from '../types';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * 检查并递增速率限制计数器
 * @param kv KV 命名空间
 * @param key 限流键(如 `ratelimit:login:${ip}`)
 * @param maxRequests 窗口内最大请求数
 * @param windowSeconds 窗口大小(秒)
 * @returns 是否允许、剩余次数、重置时间
 */
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  const raw = await kv.get(key);
  let count = 0;
  let windowStart = now;

  if (raw) {
    try {
      const data = JSON.parse(raw) as { count: number; windowStart: number };
      // 如果窗口已过期,重置
      if (now - data.windowStart >= windowMs) {
        count = 0;
        windowStart = now;
      } else {
        count = data.count;
        windowStart = data.windowStart;
      }
    } catch {
      count = 0;
      windowStart = now;
    }
  }

  count += 1;
  const remaining = Math.max(0, maxRequests - count);
  const resetAt = windowStart + windowMs;

  // 写回 KV(异步,不阻塞响应)
  const ttl = Math.ceil(windowSeconds);
  await kv.put(key, JSON.stringify({ count, windowStart }), { expirationTtl: ttl });

  return {
    allowed: count <= maxRequests,
    remaining,
    resetAt,
  };
}

/**
 * 从请求中提取客户端 IP
 * Cloudflare Workers 中 c.req.cf?.cfConnectingIp 或 headers
 */
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

/**
 * 速率限制 Hono 中间件
 * 超限时返回 429
 */
export function rateLimit(maxRequests: number, windowSeconds: number, prefix: string) {
  return async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    const ip = getClientIp(c);
    const key = `ratelimit:${prefix}:${ip}`;
    const result = await checkRateLimit(c.env.CONFIG, key, maxRequests, windowSeconds);

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: { message: 'Too many requests. Please try again later.', type: 'rate_limit_error' } },
        429
      );
    }

    await next();
  };
}
