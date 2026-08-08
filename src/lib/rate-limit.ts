// Rate limiting utilities

import { Cache } from './cache';

interface RateLimitConfig {
  rpm: number;  // requests per minute
  rpd: number;  // requests per day
  tpm: number;  // tokens per minute
  tpd: number;  // tokens per day
}

const DEFAULT_LIMITS: RateLimitConfig = {
  rpm: 60,
  rpd: 10000,
  tpm: 100000,
  tpd: 1000000,
};

export async function checkRateLimit(
  cache: Cache,
  platform: string,
  model: string,
  keyId: string,
  limits?: Partial<RateLimitConfig>
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
  const config = { ...DEFAULT_LIMITS, ...limits };
  const now = Date.now();

  // RPM check
  const rpmWindow = Math.floor(now / 60000).toString(); // minute window
  const rpm = await cache.incrementRateLimit(platform, model, keyId, rpmWindow, 120);
  if (rpm > config.rpm) {
    const resetMs = 60000 - (now % 60000);
    return { allowed: false, remaining: 0, resetMs };
  }

  // RPD check
  const rpdWindow = Math.floor(now / 86400000).toString(); // day window
  const rpd = await cache.incrementRateLimit(platform, model, keyId, rpdWindow, 86400);
  if (rpd > config.rpd) {
    const resetMs = 86400000 - (now % 86400000);
    return { allowed: false, remaining: 0, resetMs };
  }

  const rpmRemaining = Math.max(0, config.rpm - rpm);
  return { allowed: true, remaining: rpmRemaining, resetMs: 60000 - (now % 60000) };
}

export async function trackTokenUsage(
  cache: Cache,
  platform: string,
  model: string,
  keyId: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  const now = Date.now();
  const rpmWindow = Math.floor(now / 60000).toString();
  const rpdWindow = Math.floor(now / 86400000).toString();
  const total = promptTokens + completionTokens;

  if (total > 0) {
    await cache.incrementRateLimit(platform, model, `${keyId}:tpm`, rpmWindow, 120);
    await cache.incrementRateLimit(platform, model, `${keyId}:tpd`, rpdWindow, 86400);
  }
}

export function getRateLimitHeaders(
  remaining: number,
  resetMs: number
): Record<string, string> {
  return {
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(Date.now() / 1000 + resetMs / 1000).toString(),
  };
}