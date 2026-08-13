/**
 * 响应缓存
 *
 * 使用 Cloudflare KV 实现 LRU 风格的响应缓存。
 * 缓存键为请求的 SHA-256 hash(基于 model, messages, tools, max_tokens 等参数)。
 *
 * 缓存策略:
 * - 仅缓存非流式请求
 * - 默认 TTL: 60 秒(可通过 X-Cache-TTL 请求头覆盖)
 * - 缓存跳过: 包含 temperature > 0 或 seed 参数的请求(非确定性)
 * - 最大缓存大小: 每个 key 10 条(通过 KV 过期时间管理)
 * - 缓存键前缀: "resp_cache:"
 */

import type { ChatCompletionRequest } from '../types';

// 缓存的 TTL 常量(秒)
const DEFAULT_TTL = 60;          // 默认 60 秒
const LONG_TTL = 300;            // 长 TTL 5 分钟(用于完全相同的请求)
const MAX_CACHEABLE_TOKENS = 8192; // 超过此 token 数的请求不缓存

// SHA-256 hash 实现(使用 Web Crypto API)
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 判断请求是否可缓存
 */
function isCacheable(req: ChatCompletionRequest): boolean {
  // 流式请求不缓存
  if (req.stream) return false;

  // 带 temperature > 0 的请求不缓存(非确定性)
  if (req.temperature !== undefined && req.temperature > 0) return false;

  // 带 seed 的请求跳过缓存(用户显式要求确定性)
  if (req.seed !== undefined) return false;

  // 超过最大 token 数的请求不缓存
  if (req.max_tokens && req.max_tokens > MAX_CACHEABLE_TOKENS) return false;

  return true;
}

/**
 * 构建缓存键
 */
export async function buildCacheKey(req: ChatCompletionRequest): Promise<string | null> {
  if (!isCacheable(req)) return null;

  // 只取影响输出的关键字段
  const cachePayload = {
    m: req.model,
    msgs: req.messages,
    tools: req.tools,
    tool_choice: req.tool_choice,
    response_format: req.response_format,
    max_tokens: req.max_tokens,
    top_p: req.top_p,
    stop: req.stop,
    presence_penalty: req.presence_penalty,
    frequency_penalty: req.frequency_penalty,
  };

  const hash = await sha256(JSON.stringify(cachePayload));
  return `resp_cache:${hash}`;
}

/**
 * 从 KV 读取缓存
 */
export async function getCachedResponse(
  kv: KVNamespace,
  cacheKey: string
): Promise<{ body: string; ttl: number } | null> {
  try {
    const raw = await kv.get(cacheKey, 'text');
    if (!raw) return null;

    const cached = JSON.parse(raw) as { body: string; created_at: number; ttl: number };
    const age = Math.floor(Date.now() / 1000) - cached.created_at;

    if (age >= cached.ttl) {
      // 过期了,删除并返回 null
      await kv.delete(cacheKey).catch(() => {});
      return null;
    }

    return { body: cached.body, ttl: cached.ttl - age };
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 */
export async function setCachedResponse(
  kv: KVNamespace,
  cacheKey: string,
  body: string,
  ttl?: number
): Promise<void> {
  const effectiveTtl = ttl || DEFAULT_TTL;

  const cacheEntry = {
    body,
    created_at: Math.floor(Date.now() / 1000),
    ttl: effectiveTtl,
  };

  try {
    await kv.put(cacheKey, JSON.stringify(cacheEntry), {
      expirationTtl: effectiveTtl + 60, // KV 过期时间比缓存 TTL 多 60 秒
    });
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/**
 * 删除缓存(用于手动清除)
 */
export async function invalidateCache(kv: KVNamespace, cacheKey: string): Promise<void> {
  try {
    await kv.delete(cacheKey);
  } catch { /* ignore */ }
}

/**
 * 判断请求是否显式请求跳过缓存(X-Skip-Cache 头)
 */
export function shouldSkipCache(headers: Headers): boolean {
  return headers.get('X-Skip-Cache') === 'true' ||
         headers.get('Cache-Control')?.includes('no-cache') ||
         false;
}

/**
 * 获取自定义 TTL
 */
export function getCustomTtl(headers: Headers): number | undefined {
  const ttl = headers.get('X-Cache-TTL');
  if (!ttl) return undefined;
  const parsed = parseInt(ttl, 10);
  if (isNaN(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, 3600); // 最大 1 小时
}