/**
 * 路由选择器 (v6 — 性能 + 智能选路 + 并行预检 重写)
 *
 * 核心改进 (v6):
 * 1. precheckCandidates:并行 DO 预检所有候选,一次 round-trip 完成
 *    (之前串行 checkCandidate,N 个候选 = N 次串行 DO 往返)
 * 2. scoreCandidate 修复降级变体 bug:gpt-4o-mini 不再和 gpt-4o 同分
 * 3. buildCandidates 携带模型元数据(contextWindow/supportsTools/supportsVision/healthStatus)
 *    消除 sortCandidatesByMode 中的额外 D1 查询(auto/smartest 模式 0 次额外查询)
 * 4. MODEL_PRIORITY_SQL 用 CASE 语句按模型质量排序 + 降级变体降权
 * 5. consumeQuota 改用 consume 端点(只扣减不检查 — 请求已成功)
 * 6. KV 缓存加速 fastest 模式(5 分钟 TTL)
 */

import type { Env, RouteCandidate, FallbackEntry, ApiKey, ChatCompletionRequest } from '../types';
import { decrypt } from './crypto';
import { getKeyStateStub } from '../durable-objects/KeyState';
import { getSessionStub } from '../durable-objects/Session';

export type RouteMode = 'auto' | 'fastest' | 'smartest' | 'fusion' | 'manual';

// "auto" 的拼写变体 — 当作 auto 处理(走 fallback chain,不匹配具体模型)
const AUTO_VARIANTS = new Set(['autoo', 'auot', 'auto1', 'aut0', 'aauto']);

export interface RouterContext {
  userTokenId: number;
  sessionId: string | null;
  estimatedTokens?: number;
  prefersPlatform?: string;
  prefersModel?: string;
  routeMode?: RouteMode;
  /** 请求是否包含图片(vision)内容 */
  hasImage?: boolean;
}

export interface RouteResult {
  candidates: RouteCandidate[];
  stickyPlatform?: string;
  stickyModel?: string;
}

/**
 * 模型质量评分 SQL — 按 CASE 语句给模型品牌打分,降级变体(mini/haiku/flash)降权
 * auto 模式会优先选 GPT-4/Claude/Gemini 等高质量模型,而非大窗口的低质量模型
 *
 * 注意:此 SQL 作为 UNION ALL 的子查询使用,SQLite 不允许子查询内含 ORDER BY,
 * 所以这里只做 SELECT(带 CASE 评分列),排序和 LIMIT 由外层查询处理。
 */
const MODEL_PRIORITY_SQL = `
  SELECT
    model_name, platform, context_window, supports_tools, supports_vision, health_status,
    CASE
      -- 先检测降级变体 (mini/haiku/flash/lite/small/nano) — 降低分数
      WHEN LOWER(model_name) LIKE '%mini%' OR LOWER(model_name) LIKE '%haiku%' OR
           LOWER(model_name) LIKE '%flash%' OR LOWER(model_name) LIKE '%lite%' OR
           LOWER(model_name) LIKE '%small%' OR LOWER(model_name) LIKE '%nano%' OR
           LOWER(model_name) LIKE '%tiny%' THEN
        CASE
          WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 200
          WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 240
          WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 230
          WHEN model_name LIKE 'claude%' THEN 180
          WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 200
          WHEN model_name LIKE 'gemini%' THEN 150
          WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 150
          WHEN model_name LIKE 'qwen%' THEN 100
          WHEN model_name LIKE 'deepseek%' THEN 160
          WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 120
          WHEN model_name LIKE 'llama%' THEN 70
          WHEN model_name LIKE 'mistral%' THEN 60
          ELSE 40
        END
      -- 顶级模型(非降级变体)
      WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 300
      WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 290
      WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 280
      WHEN model_name LIKE 'claude%' THEN 270
      WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 250
      WHEN model_name LIKE 'deepseek-r%' OR model_name LIKE 'deepseek-v%' THEN 230
      WHEN model_name LIKE 'gemini%' AND model_name LIKE '%flash%' THEN 180
      WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 210
      WHEN model_name LIKE 'qwen%' THEN 150
      WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 160
      WHEN model_name LIKE 'llama%' THEN 100
      WHEN model_name LIKE '%kimi%' OR model_name LIKE '%moonshot%' THEN 130
      WHEN model_name LIKE 'glm-%' THEN 120
      WHEN model_name LIKE 'mistral%' AND (model_name LIKE '%large%' OR model_name LIKE '%mixtral%') THEN 140
      WHEN model_name LIKE 'mistral%' THEN 90
      ELSE 60
    END as quality_score
  FROM models
  WHERE platform = ? AND enabled = 1
    AND (health_status IS NULL OR health_status = 'healthy')
`;

export async function pickRoute(
  env: Env,
  ctx: RouterContext
): Promise<RouteResult> {
  const candidates: RouteCandidate[] = [];
  let stickyPlatform: string | undefined;
  let stickyModel: string | undefined;

  // 1. 并行: sticky session 查询 + fallback chain 查询
  const [stickyData, chainResult] = await Promise.all([
    ctx.sessionId ? getStickySession(env, ctx.sessionId) : Promise.resolve(null),
    env.DB.prepare(
      'SELECT * FROM fallback_chain WHERE enabled = 1 ORDER BY position ASC'
    ).all<FallbackEntry>(),
  ]);

  // 2. sticky session 命中 — 追加候选(但不 return,继续追加 fallback)
  if (stickyData?.session) {
    stickyPlatform = stickyData.session.platform;
    stickyModel = stickyData.session.model;
    const cands = await buildCandidates(env, stickyPlatform, stickyModel);
    // 有图片时:sticky session 的模型可能不支持 vision,只追加 vision 候选
    if (ctx.hasImage) {
      dedupPush(candidates, ...cands.filter(c => c.supportsVision));
    } else {
      dedupPush(candidates, ...cands);
    }
  }

  // 3. 用户明确指定 model(支持无前缀模型名)
  //    "auto" / "autoo" 等拼写变体 → 跳过,走 fallback chain
  const modelLower = (ctx.prefersModel || '').toLowerCase().trim();
  if (ctx.prefersModel && modelLower !== 'auto' && !AUTO_VARIANTS.has(modelLower)) {
    const resolved = await resolveModelId(env, ctx.prefersModel);
    if (resolved.length > 0) {
      // 并行构建所有匹配平台的候选(纯 D1 + 解密,无 DO 调用)
      const candsArrays = await Promise.all(
        resolved.map(({ platform, model }) =>
          buildCandidates(env, platform, model).catch(() => [] as RouteCandidate[])
        )
      );
      for (const arr of candsArrays) {
        dedupPush(candidates, ...arr);
      }
      // 指定模型时:如有图片,先过滤 vision 候选
      if (ctx.hasImage && candidates.length > 0) {
        const visionCands = candidates.filter(c => c.supportsVision);
        if (visionCands.length > 0) candidates.splice(0, candidates.length, ...visionCands);
      }
      // 有候选时直接返回;候选为0(如指定模型只在 key 失效的平台存在)则继续走 fallback
      if (candidates.length > 0) {
        const mode = ctx.routeMode || 'auto';
        if (mode !== 'manual' && candidates.length > 1) {
          await sortCandidatesByMode(env, candidates, mode);
        }
        return { candidates, stickyPlatform, stickyModel };
      }
      // 候选为0 — 继续走 fallback chain + 全量扫描
    }
    // 指定了 model 但没找到匹配 — 继续走 fallback
  }

  // 4. 按 fallback chain 并行收集候选(纯 D1 + 解密,无 DO 调用)
  const chain = chainResult.results || [];
  if (chain.length > 0) {
    const candsArrays = await Promise.all(
      chain.map(entry =>
        buildCandidates(env, entry.platform, entry.model, entry.key_id || undefined)
          .catch(() => [] as RouteCandidate[])
      )
    );
    for (const arr of candsArrays) {
      // 有图片时:只追加 vision 候选(fallback chain 可能有非 vision 模型)
      if (ctx.hasImage) {
        dedupPush(candidates, ...arr.filter(c => c.supportsVision));
      } else {
        dedupPush(candidates, ...arr);
      }
    }
  }

  // 5. 无候选时:一次查询取所有平台最优模型,直接从已查 keys 构建(消除 N+1)
  //    如果有图片:先查 vision 模型;若 vision 模型为 0,回退查全部(让上游报错)
  if (candidates.length === 0) {
    const allKeys = await env.DB.prepare(
      `SELECT id, platform, health_status, key_ciphertext, key_iv, key_tag, key_hint, custom_base_url
       FROM api_keys WHERE enabled = 1 AND health_status != 'invalid'`
    ).all<ApiKey>();

    const keys = allKeys.results || [];
    if (keys.length > 0) {
      const platforms = [...new Set(keys.map(k => k.platform))];
      if (platforms.length > 0) {
        // 单次查询所有平台的模型(用 IN 子句,避免 UNION ALL 超过 SQLite 项数限制)
        // quality_score 通过 CASE 语句计算,在 JS 层按平台取 top 3
        const placeholders = platforms.map(() => '?').join(',');
        const modelRows = await env.DB.prepare(
          `SELECT model_name, platform, context_window, supports_tools, supports_vision, health_status,
            CASE
              WHEN LOWER(model_name) LIKE '%mini%' OR LOWER(model_name) LIKE '%haiku%' OR
                   LOWER(model_name) LIKE '%flash%' OR LOWER(model_name) LIKE '%lite%' OR
                   LOWER(model_name) LIKE '%small%' OR LOWER(model_name) LIKE '%nano%' OR
                   LOWER(model_name) LIKE '%tiny%' THEN
                CASE
                  WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 200
                  WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 240
                  WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 230
                  WHEN model_name LIKE 'claude%' THEN 180
                  WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 200
                  WHEN model_name LIKE 'gemini%' THEN 150
                  WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 150
                  WHEN model_name LIKE 'qwen%' THEN 100
                  WHEN model_name LIKE 'deepseek%' THEN 160
                  WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 120
                  WHEN model_name LIKE 'llama%' THEN 70
                  WHEN model_name LIKE 'mistral%' THEN 60
                  ELSE 40
                END
              WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 300
              WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 290
              WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 280
              WHEN model_name LIKE 'claude%' THEN 270
              WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 250
              WHEN model_name LIKE 'deepseek-r%' OR model_name LIKE 'deepseek-v%' THEN 230
              WHEN model_name LIKE 'gemini%' AND model_name LIKE '%flash%' THEN 180
              WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 210
              WHEN model_name LIKE 'qwen%' THEN 150
              WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 160
              WHEN model_name LIKE 'llama%' THEN 100
              WHEN model_name LIKE '%kimi%' OR model_name LIKE '%moonshot%' THEN 130
              WHEN model_name LIKE 'glm-%' THEN 120
              WHEN model_name LIKE 'mistral%' AND (model_name LIKE '%large%' OR model_name LIKE '%mixtral%') THEN 140
              WHEN model_name LIKE 'mistral%' THEN 90
              ELSE 60
            END as quality_score
           FROM models
           WHERE platform IN (${placeholders}) AND enabled = 1
             AND (health_status IS NULL OR health_status = 'healthy')
             ${ctx.hasImage ? 'AND supports_vision = 1' : ''}
           ORDER BY platform, quality_score DESC, context_window DESC, supports_tools DESC, supports_vision DESC`
        ).bind(...platforms).all<{ model_name: string; platform: string; context_window: number | null; supports_tools: number; supports_vision: number; health_status: string | null; quality_score: number }>();

        // 回退:如果有图片但没找到任何 vision 模型,查全部模型(让上游报错,而非 503 no_route)
        let effectiveModelRows = modelRows;
        if (ctx.hasImage && (!modelRows.results || modelRows.results.length === 0)) {
          effectiveModelRows = await env.DB.prepare(
            `SELECT model_name, platform, context_window, supports_tools, supports_vision, health_status,
              CASE
                WHEN LOWER(model_name) LIKE '%mini%' OR LOWER(model_name) LIKE '%haiku%' OR
                     LOWER(model_name) LIKE '%flash%' OR LOWER(model_name) LIKE '%lite%' OR
                     LOWER(model_name) LIKE '%small%' OR LOWER(model_name) LIKE '%nano%' OR
                     LOWER(model_name) LIKE '%tiny%' THEN
                  CASE
                    WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 200
                    WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 240
                    WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 230
                    WHEN model_name LIKE 'claude%' THEN 180
                    WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 200
                    WHEN model_name LIKE 'gemini%' THEN 150
                    WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 150
                    WHEN model_name LIKE 'qwen%' THEN 100
                    WHEN model_name LIKE 'deepseek%' THEN 160
                    WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 120
                    WHEN model_name LIKE 'llama%' THEN 70
                    WHEN model_name LIKE 'mistral%' THEN 60
                    ELSE 40
                  END
                WHEN model_name LIKE 'gpt-4%' OR model_name LIKE 'gpt-5%' OR model_name LIKE 'o1%' OR model_name LIKE 'o3%' THEN 300
                WHEN model_name LIKE 'claude%' AND model_name LIKE '%opus%' THEN 290
                WHEN model_name LIKE 'claude%' AND model_name LIKE '%sonnet%' THEN 280
                WHEN model_name LIKE 'claude%' THEN 270
                WHEN model_name LIKE 'gemini%' AND model_name LIKE '%pro%' THEN 250
                WHEN model_name LIKE 'deepseek-r%' OR model_name LIKE 'deepseek-v%' THEN 230
                WHEN model_name LIKE 'gemini%' AND model_name LIKE '%flash%' THEN 180
                WHEN model_name LIKE 'qwen%' AND (model_name LIKE '%max%' OR model_name LIKE '%72b%') THEN 210
                WHEN model_name LIKE 'qwen%' THEN 150
                WHEN model_name LIKE 'llama%' AND (model_name LIKE '%70b%' OR model_name LIKE '%405b%') THEN 160
                WHEN model_name LIKE 'llama%' THEN 100
                WHEN model_name LIKE '%kimi%' OR model_name LIKE '%moonshot%' THEN 130
                WHEN model_name LIKE 'glm-%' THEN 120
                WHEN model_name LIKE 'mistral%' AND (model_name LIKE '%large%' OR model_name LIKE '%mixtral%') THEN 140
                WHEN model_name LIKE 'mistral%' THEN 90
                ELSE 60
              END as quality_score
             FROM models
             WHERE platform IN (${placeholders}) AND enabled = 1
               AND (health_status IS NULL OR health_status = 'healthy')
             ORDER BY platform, quality_score DESC, context_window DESC, supports_tools DESC, supports_vision DESC`
          ).bind(...platforms).all<{ model_name: string; platform: string; context_window: number | null; supports_tools: number; supports_vision: number; health_status: string | null; quality_score: number }>();
        }

        // 每个平台取 top 3(已按 quality_score 降序排列)
        const platformModels = new Map<string, Array<{ name: string; ctx: number; tools: boolean; vision: boolean; health: string }>>();
        for (const r of effectiveModelRows.results || []) {
          if (!platformModels.has(r.platform)) {
            platformModels.set(r.platform, []);
          }
          const list = platformModels.get(r.platform)!;
          if (list.length < 3) {
            list.push({
              name: r.model_name,
              ctx: r.context_window || 4096,
              tools: !!r.supports_tools,
              vision: !!r.supports_vision,
              health: r.health_status || 'healthy',
            });
          }
        }

        // 直接从已查 keys 构建候选 + 并行解密(无 DO 调用)
        // 每个 key × 每个模型 = 一个候选(模型按质量排序,第一个最优)
        const tasks = keys.map(async (k) => {
          const modelInfos = platformModels.get(k.platform);
          if (!modelInfos || modelInfos.length === 0) return [];
          try {
            const plaintext = await decrypt(
              { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
              env.ENCRYPTION_KEY
            );
            return modelInfos.map(mi => ({
              platform: k.platform,
              model: mi.name,
              keyId: k.id,
              keyPlaintext: plaintext,
              customBaseUrl: k.custom_base_url,
              contextWindow: mi.ctx,
              supportsTools: mi.tools,
              supportsVision: mi.vision,
              healthStatus: mi.health,
            } as RouteCandidate));
          } catch {
            return [];
          }
        });

        const results = await Promise.all(tasks);
        for (const arr of results) {
          for (const r of arr) {
            dedupPush(candidates, r);
          }
        }
      }
    }
  }

  // 6. 如果请求包含图片,过滤掉不支持 vision 的候选
  if (ctx.hasImage && candidates.length > 0) {
    const visionCandidates = candidates.filter(c => c.supportsVision);
    if (visionCandidates.length > 0) {
      // 有 vision 候选时,只保留它们
      candidates.splice(0, candidates.length, ...visionCandidates);
    }
    // 如果没有 vision 候选,保留全部(让上游报错或自行处理)
  }

  // 7. 按路由策略排序
  const mode = ctx.routeMode || 'auto';
  if (mode !== 'manual' && candidates.length > 1) {
    await sortCandidatesByMode(env, candidates, mode);
  }

  return { candidates, stickyPlatform, stickyModel };
}

/**
 * 检测请求 messages 中是否包含图片内容(image_url)
 */
export function requestHasImage(req: ChatCompletionRequest): boolean {
  if (!req.messages) return false;
  for (const m of req.messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 解析模型 ID — 支持带前缀和不带前缀两种形式
 * - "groq:llama-3.3-70b" → [{platform: "groq", model: "llama-3.3-70b"}]
 * - "gpt-4o" → 查 D1 找所有拥有该模型的平台
 * - "auto" → 返回空数组(交给 fallback chain)
 */
async function resolveModelId(
  env: Env,
  modelId: string
): Promise<Array<{ platform: string; model: string }>> {
  // 带 platform: 前缀
  if (modelId.includes(':')) {
    const [p, ...rest] = modelId.split(':');
    return [{ platform: p, model: rest.join(':') }];
  }

  // 无前缀:查 D1 精确匹配
  const exactRows = await env.DB.prepare(
    `SELECT DISTINCT platform, model_name FROM models
     WHERE model_name = ? AND enabled = 1
     AND (health_status IS NULL OR health_status = 'healthy')`
  ).bind(modelId).all<{ platform: string; model_name: string }>();

  if (exactRows.results && exactRows.results.length > 0) {
    return exactRows.results.map(r => ({ platform: r.platform, model: r.model_name }));
  }

  // 模糊匹配:前缀匹配(如 gpt-4o → gpt-4o-2024-08-06)
  const fuzzyRows = await env.DB.prepare(
    `SELECT DISTINCT platform, model_name FROM models
     WHERE model_name LIKE ? AND enabled = 1
     AND (health_status IS NULL OR health_status = 'healthy')
     ORDER BY LENGTH(model_name) ASC
     LIMIT 5`
  ).bind(`${modelId}%`).all<{ platform: string; model_name: string }>();

  return (fuzzyRows.results || []).map(r => ({ platform: r.platform, model: r.model_name }));
}

/**
 * 判断模型是否为降级变体(mini/haiku/flash/lite/small/nano/tiny)
 */
function isDowngradeVariant(modelName: string): boolean {
  const n = modelName.toLowerCase();
  return n.includes('mini') || n.includes('haiku') || n.includes('flash') ||
         n.includes('lite') || n.includes('small') || n.includes('nano') || n.includes('tiny');
}

/**
 * 模型质量评分(纯函数,不查 D1 — 使用候选携带的元数据)
 * 与 MODEL_PRIORITY_SQL 的 CASE 逻辑保持一致
 * 修复:降级变体(mini/haiku/flash)不再和顶级模型同分
 */
function modelQualityScore(modelName: string): number {
  const name = modelName.toLowerCase();
  const downgraded = isDowngradeVariant(name);

  if (downgraded) {
    // 降级变体:分数降低一档
    if (/^gpt-[45]/.test(name) || /^o[13]\b/.test(name)) return 200;
    if (/claude.*opus/.test(name)) return 240;
    if (/claude.*sonnet|claude-?[34]/.test(name)) return 230;
    if (/claude/.test(name)) return 180;
    if (/gemini.*pro/.test(name)) return 200;
    if (/gemini/.test(name)) return 150;
    if (/qwen.*max|qwen.*72b/.test(name)) return 150;
    if (/qwen/.test(name)) return 100;
    if (/deepseek/.test(name)) return 160;
    if (/llama.*70b|llama.*405b/.test(name)) return 120;
    if (/llama/.test(name)) return 70;
    if (/mistral/.test(name)) return 60;
    return 40;
  }

  // 顶级模型(非降级变体)
  if (/^gpt-[45]/.test(name) || /^o[13]\b/.test(name)) return 300;
  if (/claude.*opus/.test(name)) return 290;
  if (/claude.*sonnet|claude-?[34]/.test(name)) return 280;
  if (/claude/.test(name)) return 270;
  if (/gemini.*pro/.test(name)) return 250;
  if (/deepseek-r[12]/.test(name) || /deepseek-v[34]/.test(name)) return 230;
  if (/gemini.*flash/.test(name)) return 180;
  if (/qwen.*max|qwen.*72b/.test(name)) return 210;
  if (/qwen/.test(name)) return 150;
  if (/llama.*70b|llama.*405b/.test(name)) return 160;
  if (/llama/.test(name)) return 100;
  if (/kimi|moonshot/.test(name)) return 130;
  if (/glm-[45]/.test(name)) return 120;
  if (/mistral.*large|mixtral/.test(name)) return 140;
  if (/mistral/.test(name)) return 90;
  return 60;
}

/**
 * 按路由策略排序候选(使用候选携带的元数据)
 * - auto/fusion: 模型质量 + 能力 + 上下文窗口综合评分(健康度作为门槛而非排序键)— 纯内存,0 次额外查询
 * - fastest: 按 (platform, model) 近 24h 平均延迟排序(KV 缓存 5 分钟)— 1 次 KV/D1 查询
 * - smartest: 按 context_window + supports_tools + 模型品牌综合评分 — 纯内存,0 次额外查询
 */
async function sortCandidatesByMode(env: Env, candidates: RouteCandidate[], mode: RouteMode) {
  if (candidates.length <= 1) return;

  if (mode === 'auto' || mode === 'fusion') {
    // 健康度门槛:rate_limited/error 的模型排到最后,但不剔除(fallback 时还能用)
    const healthRank: Record<string, number> = {
      healthy: 0,
      unknown: 1,
      rate_limited: 2,
      error: 3,
      invalid: 4,
    };

    // 综合评分:质量分(0-300) + 能力分(0-50) + 上下文分(0-30)
    const scoreCandidate = (c: RouteCandidate): number => {
      const quality = modelQualityScore(c.model);

      let capability = 0;
      if (c.supportsTools) capability += 30;
      if (c.supportsVision) capability += 20;

      // 上下文窗口:对数曲线(128k 不会比 4k 好 32 倍)
      const ctx = c.contextWindow || 4096;
      const contextScore = Math.log2(ctx / 4096) * 5;

      return quality + capability + contextScore;
    };

    // 稳定排序:先按健康度分档,同档内按质量分排序,同分保持 fallback 顺序
    const indexed = candidates.map((c, i) => ({ c, i }));
    indexed.sort((a, b) => {
      const ra = healthRank[a.c.healthStatus || 'unknown'] ?? 1;
      const rb = healthRank[b.c.healthStatus || 'unknown'] ?? 1;
      if (ra !== rb) return ra - rb;
      const sa = scoreCandidate(a.c);
      const sb = scoreCandidate(b.c);
      if (sb !== sa) return sb - sa;
      return a.i - b.i; // 保持 fallback 顺序
    });
    candidates.splice(0, candidates.length, ...indexed.map(x => x.c));
    return;
  }

  if (mode === 'fastest') {
    // KV 缓存 5 分钟
    const cacheKey = 'fastest_latency_map';
    let latencyMap: Map<string, number> | null = null;
    try {
      const cached = await env.CONFIG.get(cacheKey);
      if (cached) latencyMap = new Map(JSON.parse(cached));
    } catch { /* ignore */ }

    if (!latencyMap) {
      const dayAgo = Math.floor(Date.now() / 1000) - 86400;
      const rows = await env.DB.prepare(
        `SELECT platform, model, AVG(latency_ms) as avg_lat, COUNT(*) as cnt
         FROM request_logs
         WHERE created_at >= ? AND latency_ms > 0 AND status_code >= 200 AND status_code < 300
         GROUP BY platform, model`
      ).bind(dayAgo).all<{ platform: string; model: string; avg_lat: number; cnt: number }>();
      latencyMap = new Map();
      for (const r of rows.results || []) {
        if (r.cnt >= 3) {
          latencyMap.set(`${r.platform}:${r.model}`, r.avg_lat);
        }
      }
      try {
        await env.CONFIG.put(cacheKey, JSON.stringify([...latencyMap.entries()]), { expirationTtl: 300 });
      } catch { /* ignore */ }
    }

    const indexed = candidates.map((c, i) => ({ c, i }));
    indexed.sort((a, b) => {
      const la = latencyMap!.get(`${a.c.platform}:${a.c.model}`) ?? 999999;
      const lb = latencyMap!.get(`${b.c.platform}:${b.c.model}`) ?? 999999;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    });
    candidates.splice(0, candidates.length, ...indexed.map(x => x.c));
    return;
  }

  if (mode === 'smartest') {
    const scoreCandidate = (c: RouteCandidate): number => {
      let score = (c.contextWindow || 4096) / 1000;
      if (c.supportsTools) score += 50;
      if (c.supportsVision) score += 30;
      score += modelQualityScore(c.model);
      return score;
    };

    const indexed = candidates.map((c, i) => ({ c, i }));
    indexed.sort((a, b) => {
      const sa = scoreCandidate(a.c);
      const sb = scoreCandidate(b.c);
      if (sb !== sa) return sb - sa;
      return a.i - b.i;
    });
    candidates.splice(0, candidates.length, ...indexed.map(x => x.c));
    return;
  }
}

/**
 * 获取 sticky session(辅助函数,用于并行执行)
 */
async function getStickySession(
  env: Env,
  sessionId: string
): Promise<{ session: { platform: string; model: string; expires_at: number } | null }> {
  try {
    const stub = getSessionStub(env, sessionId);
    const res = await stub.fetch('https://session/get');
    const data = (await res.json()) as { session: any };
    if (data.session && data.session.expires_at > Math.floor(Date.now() / 1000)) {
      return data;
    }
    return { session: null };
  } catch {
    return { session: null };
  }
}

/**
 * 构建候选列表(纯 D1 查询 + 解密,无 DO 调用)
 *
 * 性能:之前每个 key 要一次 DO round-trip(check 端点),
 * 现在完全去掉 — 路由阶段 0 次 DO 调用。
 * DO 的 per-model cooldown / rate limit 检查推迟到 precheckCandidates(并行)。
 *
 * v6 改进:同时查询模型元数据(contextWindow/supportsTools/supportsVision/healthStatus)
 * 携带在候选中,避免 sortCandidatesByMode 再次查询 D1。
 */
async function buildCandidates(
  env: Env,
  platform: string,
  model: string,
  pinnedKeyId?: number
): Promise<RouteCandidate[]> {
  let keys: ApiKey[];
  if (pinnedKeyId) {
    const k = await env.DB.prepare(
      `SELECT id, platform, health_status, key_ciphertext, key_iv, key_tag, key_hint, custom_base_url
       FROM api_keys WHERE id = ? AND enabled = 1 AND health_status != 'invalid'`
    ).bind(pinnedKeyId).first<ApiKey>();
    keys = k ? [k] : [];
  } else {
    const result = await env.DB.prepare(
      `SELECT id, platform, health_status, key_ciphertext, key_iv, key_tag, key_hint, custom_base_url
       FROM api_keys WHERE platform = ? AND enabled = 1 AND health_status != 'invalid' ORDER BY id`
    ).bind(platform).all<ApiKey>();
    keys = result.results || [];
  }

  if (keys.length === 0) return [];

  // 查询模型元数据(一次查询)
  const modelMeta = await env.DB.prepare(
    `SELECT context_window, supports_tools, supports_vision, health_status
     FROM models WHERE platform = ? AND model_name = ? AND enabled = 1
     LIMIT 1`
  ).bind(platform, model).first<{ context_window: number | null; supports_tools: number; supports_vision: number; health_status: string | null }>();

  const meta = {
    contextWindow: modelMeta?.context_window || 4096,
    supportsTools: !!modelMeta?.supports_tools,
    supportsVision: !!modelMeta?.supports_vision,
    healthStatus: modelMeta?.health_status || 'healthy',
  };

  // 并行解密(纯 CPU,无网络往返)
  const tasks = keys.map(async (k) => {
    try {
      const plaintext = await decrypt(
        { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
        env.ENCRYPTION_KEY
      );
      return {
        platform: k.platform,
        model,
        keyId: k.id,
        keyPlaintext: plaintext,
        customBaseUrl: k.custom_base_url,
        ...meta,
      } as RouteCandidate;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(tasks);
  return results.filter((r): r is RouteCandidate => r !== null);
}

/**
 * 去重后追加候选(按 platform+model+keyId 去重,保持顺序)
 */
function dedupPush(arr: RouteCandidate[], ...items: RouteCandidate[]): void {
  const seen = new Set(arr.map(c => `${c.platform}:${c.model}:${c.keyId}`));
  for (const item of items) {
    const key = `${item.platform}:${item.model}:${item.keyId}`;
    if (!seen.has(key)) {
      arr.push(item);
      seen.add(key);
    }
  }
}

/**
 * 并行预检所有候选(一次 DO round-trip 完成全部检查)
 *
 * 替代之前在 route handler 中串行 checkCandidate 的做法:
 * 之前:N 个候选 = N 次串行 DO 往返(每次 50-100ms,总延迟 N×100ms)
 * 现在:N 个候选 = 1 次并行 DO 往返(总延迟 ~100ms,与 N 无关)
 *
 * 返回:通过预检的候选列表(保持原顺序)
 */
export async function precheckCandidates(
  env: Env,
  candidates: RouteCandidate[]
): Promise<RouteCandidate[]> {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    // 单个候选:直接检查(避免 Promise.all 开销)
    const allowed = await checkCandidate(env, candidates[0].keyId, candidates[0].model);
    return allowed ? candidates : [];
  }

  // 并行检查所有候选
  const checks = candidates.map(c =>
    checkCandidate(env, c.keyId, c.model).then(allowed => ({ cand: c, allowed }))
  );

  const results = await Promise.all(checks);
  return results.filter(r => r.allowed).map(r => r.cand);
}

/**
 * 只读检查:是否允许请求(不扣配额)
 * 检查 key 级别冷却 + 模型级别冷却 + 速率限制(不扣配额)
 *
 * 如果 DO 不可用或超时,默认允许(让上游 429 来兜底)。
 */
export async function checkCandidate(
  env: Env,
  keyId: number,
  model?: string
): Promise<boolean> {
  try {
    const stub = getKeyStateStub(env, keyId);
    const res = await stub.fetch('https://keystate/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const data = (await res.json()) as { allowed: boolean };
    return data.allowed;
  } catch {
    // DO 不可用时默认允许 — 让上游错误来驱动 fallback
    return true;
  }
}

/**
 * 实际消费配额(请求成功后调用)
 * 使用 consume 端点(只扣减不检查) — 请求已成功,无需再检查速率限制
 */
export async function consumeQuota(
  env: Env,
  keyId: number,
  promptTokens: number,
  completionTokens: number,
  model?: string
): Promise<void> {
  try {
    const totalTokens = (promptTokens || 0) + (completionTokens || 0) || 100;
    const stub = getKeyStateStub(env, keyId);
    await stub.fetch('https://keystate/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estimatedTokens: totalTokens, model }),
    });
  } catch { /* ignore */ }
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
  try {
    const stub = getSessionStub(env, sessionId);
    await stub.fetch('https://session/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, model, ttlMinutes: 30 }),
    });
  } catch { /* ignore */ }
}

/**
 * 记录请求结果到 DO + D1(健康状态更新)
 * @param platform 候选平台(消除 D1 子查询)
 *
 * 模型级:连续失败 5 次后标记 rate_limited(额度耗尽),成功时重置计数
 * Key 级:401/403 → invalid,5xx/408 → error,429 → rate_limited,2xx → healthy
 */
export async function recordKeyResult(
  env: Env,
  keyId: number,
  status: number,
  platform: string,
  errorMessage?: string,
  retryAfter?: number,
  model?: string
): Promise<void> {
  try {
    const stub = getKeyStateStub(env, keyId);
    const tasks: Promise<unknown>[] = [];

    // DO 更新
    tasks.push(stub.fetch('https://keystate/record-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, errorMessage, retryAfter, model }),
    }));

    // ===== Key 级健康状态 =====
    if (status === 401 || status === 403) {
      tasks.push(env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('invalid', keyId).run());
    } else if (status === 429) {
      tasks.push(env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('rate_limited', keyId).run());
    } else if (status >= 500 || status === 408 || status === 504) {
      tasks.push(env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('error', keyId).run());
    } else if (status >= 200 && status < 300) {
      tasks.push(env.DB.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').bind('healthy', keyId).run());
    }

    // ===== 模型级健康状态(连续失败 5 次才标记) =====
    if (model) {
      if (status >= 200 && status < 300) {
        // 成功:重置失败计数 + 恢复健康
        tasks.push(env.CONFIG.delete(`model_fails:${platform}:${model}`));
        tasks.push(
          env.DB.prepare(
            'UPDATE models SET health_status = ? WHERE platform = ? AND model_name = ?'
          ).bind('healthy', platform, model).run()
        );
      } else {
        // 失败:先读取当前失败次数,再决定是否标记
        // 用 await 而非 push 到 tasks,因为后续操作依赖读取结果
        const failKey = `model_fails:${platform}:${model}`;
        const currentStr = await env.CONFIG.get(failKey);
        const currentCount = parseInt(currentStr || '0', 10);
        const newCount = currentCount + 1;

        if (newCount >= 5) {
          // 连续失败 5 次:标记为 rate_limited(额度耗尽),清除计数
          tasks.push(env.CONFIG.delete(failKey));
          tasks.push(
            env.DB.prepare(
              'UPDATE models SET health_status = ? WHERE platform = ? AND model_name = ?'
            ).bind('rate_limited', platform, model).run()
          );
          console.warn(`[router] Model ${platform}:${model} marked as rate_limited after ${newCount} consecutive failures`);
        } else {
          // 未达 5 次:更新计数(1 小时 TTL,无请求则自动重置)
          tasks.push(env.CONFIG.put(failKey, String(newCount), { expirationTtl: 3600 }));
        }
      }
    }

    await Promise.all(tasks);
  } catch { /* ignore */ }
}
