/**
 * 路由选择器
 * - 根据 fallback_chain 表 + 各 key 的健康/速率状态
 * - 选出最合适的 (platform, model, key) 组合
 * - 支持 sticky session
 */

import type { Env, RouteCandidate, FallbackEntry, ApiKey, KeyStateDO } from '../types';
import { decrypt } from './crypto';
import { getKeyStateStub } from '../durable-objects/KeyState';
import { getSessionStub } from '../durable-objects/Session';

export interface RouterContext {
  userTokenId: number;
  sessionId: string | null;
  estimatedTokens?: number;
  prefersPlatform?: string;
  prefersModel?: string;
}

export interface RouteResult {
  candidates: RouteCandidate[];   // 已排序,index 0 是首选
  stickyPlatform?: string;
  stickyModel?: string;
}

export async function pickRoute(
  env: Env,
  ctx: RouterContext
): Promise<RouteResult> {
  // 1) sticky session 优先
  if (ctx.sessionId) {
    const stub = getSessionStub(env, ctx.sessionId);
    const res = await stub.fetch('https://session/get');
    const { session } = (await res.json()) as { session: any };
    if (session && session.expires_at > Math.floor(Date.now() / 1000)) {
      // 找到该 platform+model 的候选
      const cands = await buildCandidates(env, session.platform, session.model);
      if (cands.length > 0) {
        return {
          candidates: cands,
          stickyPlatform: session.platform,
          stickyModel: session.model,
        };
      }
    }
  }

  // 2) 用户明确指定 model
  if (ctx.prefersModel) {
    const [platform, model] = parseModelId(ctx.prefersModel);
    if (platform && model) {
      const cands = await buildCandidates(env, platform, model);
      if (cands.length > 0) return { candidates: cands };
    }
  }

  // 3) 按 fallback_chain 顺序逐个尝试
  const chain = await env.DB.prepare(
    'SELECT * FROM fallback_chain WHERE enabled = 1 ORDER BY position ASC'
  ).all<FallbackEntry>();

  const candidates: RouteCandidate[] = [];

  for (const entry of chain.rows || []) {
    const cands = await buildCandidates(env, entry.platform, entry.model, entry.key_id || undefined);
    candidates.push(...cands);
  }

  // 4) 如果没有 fallback_chain,按 key 顺序自动配
  if (candidates.length === 0) {
    const allKeys = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE enabled = 1'
    ).all<ApiKey>();
    for (const k of allKeys.rows || []) {
      const models = await env.DB.prepare(
        'SELECT model_name FROM models WHERE platform = ? AND enabled = 1'
      ).bind(k.platform).all<{ model_name: string }>();
      for (const m of models.rows || []) {
        const cands = await buildCandidates(env, k.platform, m.model_name, k.id);
        candidates.push(...cands);
      }
    }
  }

  return { candidates };
}

function parseModelId(modelId: string): [string | null, string | null] {
  // 'groq:llama-3.3-70b' -> ['groq', 'llama-3.3-70b']
  // 'llama-3.3-70b' -> [null, 'llama-3.3-70b']  (让上层再查)
  if (modelId.includes(':')) {
    const [p, ...rest] = modelId.split(':');
    return [p, rest.join(':')];
  }
  return [null, modelId];
}

async function buildCandidates(
  env: Env,
  platform: string,
  model: string,
  pinnedKeyId?: number
): Promise<RouteCandidate[]> {
  // 找 key(可选指定)
  let keys: ApiKey[];
  if (pinnedKeyId) {
    const k = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE id = ? AND enabled = 1'
    ).bind(pinnedKeyId).first<ApiKey>();
    keys = k ? [k] : [];
  } else {
    const result = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id'
    ).bind(platform).all<ApiKey>();
    keys = result.rows || [];
  }

  const out: RouteCandidate[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const k of keys) {
    // 1) 健康检查:冷却中跳过
    if (k.health_status === 'invalid') continue;

    // 2) DO 速率检查
    try {
      const stub = getKeyStateStub(env, k.id);
      const res = await stub.fetch('https://keystate/check-and-consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimatedTokens: 200 }),
      });
      const data = (await res.json()) as { allowed: boolean; reason?: string; retryAfter?: number; healthStatus?: string };
      if (!data.allowed) continue; // 配额满,跳过
    } catch {
      // DO 失败,保守起见仍加入候选
    }

    // 3) 解密 key
    try {
      const plaintext = await decrypt(
        { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
        env.ENCRYPTION_KEY
      );
      out.push({
        platform: k.platform,
        model,
        keyId: k.id,
        keyPlaintext: plaintext,
      });
    } catch (e) {
      // 解密失败,跳过
      continue;
    }
  }

  return out;
}

/**
 * 请求成功后更新 sticky session
 */
export async function updateStickySession(
  env: Env,
  sessionId: string | null,
  platform: string,
  model: string
): Promise<void> {
  if (!sessionId) return;
  const stub = getSessionStub(env, sessionId);
  await stub.fetch('https://session/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, model, ttlMinutes: 30 }),
  });
}

/**
 * 记录请求结果到 DO(健康状态更新)
 */
export async function recordKeyResult(
  env: Env,
  keyId: number,
  status: number,
  errorMessage?: string
): Promise<void> {
  try {
    const stub = getKeyStateStub(env, keyId);
    await stub.fetch('https://keystate/record-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, errorMessage }),
    });
    // 同步到 D1(只同步 health_status,供前端展示)
    if (status === 429) {
      await env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('rate_limited', keyId).run();
    } else if (status === 401 || status === 403) {
      await env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('invalid', keyId).run();
    } else if (status >= 200 && status < 300) {
      await env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('healthy', keyId).run();
    } else if (status >= 500) {
      await env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('error', keyId).run();
    }
  } catch (e) {
    // DO 失败不影响主流程
  }
}
