/**
 * Durable Object: Per-key 状态
 * 负责单条 API key 的:
 * - 速率计数(RPM/RPD/TPM/TPD)
 * - 健康状态
 * - 冷却时间(失败后短期内不再使用)
 * - 按模型级别冷却(百炼等平台每个模型有独立免费额度)
 *
 * 每个 key 一个 DO 实例(通过 idFromName 映射),
 * 强一致 + 高频写都安全。
 */

import type { KeyStateDO, HealthStatus } from '../types';

interface Env {
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT_MAX_REQUESTS: string;
}

const COOLDOWN_SECONDS: Record<string, number> = {
  rate_limited: 60,
  invalid: 600,     // 10 分钟
  error: 30,
  healthy: 0,
  unknown: 0,
};

// 扩展状态:增加按模型冷却
interface ExtendedKeyState extends KeyStateDO {
  modelCooldowns?: Record<string, { until: number; status: string }>;
}

export class KeyState implements DurableObject {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, '');

    switch (action) {
      case 'check-and-consume':
        return this.checkAndConsume(request);
      case 'check':
        return this.check(request);
      case 'consume':
        return this.consume(request);
      case 'record-result':
        return this.recordResult(request);
      case 'get':
        return this.get();
      case 'get-model-status':
        return this.getModelStatus(request);
      case 'reset':
        return this.reset();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async load(): Promise<ExtendedKeyState> {
    const stored = (await this.state.storage.get<ExtendedKeyState>('state')) || {
      rateCount: { minute: 0, day: 0 },
      tokenCount: { minute: 0, day: 0 },
      windowStart: { minute: 0, day: 0 },
      healthStatus: 'unknown',
      lastUsedAt: 0,
      cooldownUntil: 0,
      modelCooldowns: {},
    };
    if (!stored.modelCooldowns) stored.modelCooldowns = {};
    return stored;
  }

  private async save(s: ExtendedKeyState): Promise<void> {
    await this.state.storage.put('state', s);
  }

  private getWindowStart(now: number, type: 'minute' | 'day'): number {
    if (type === 'minute') {
      return Math.floor(now / 60) * 60;
    }
    // 当地 0 点(简化:用 UTC)
    const d = new Date(now * 1000);
    return Math.floor(d.getTime() / 1000 / 86400) * 86400;
  }

  private rollWindow(state: ExtendedKeyState, now: number): void {
    const minStart = this.getWindowStart(now, 'minute');
    const dayStart = this.getWindowStart(now, 'day');

    if (minStart !== state.windowStart.minute) {
      state.rateCount.minute = 0;
      state.tokenCount.minute = 0;
      state.windowStart.minute = minStart;
    }
    if (dayStart !== state.windowStart.day) {
      state.rateCount.day = 0;
      state.tokenCount.day = 0;
      state.windowStart.day = dayStart;
    }
  }

  /**
   * 清理过期的模型冷却
   */
  private cleanModelCooldowns(state: ExtendedKeyState, now: number): void {
    if (!state.modelCooldowns) return;
    for (const model of Object.keys(state.modelCooldowns)) {
      if (state.modelCooldowns[model].until <= now) {
        delete state.modelCooldowns[model];
      }
    }
  }

  /**
   * 只读检查:是否允许请求(不扣配额)
   * POST /check
   * Body: { model? }
   * 用于路由选路阶段 — 避免 buildCandidates 对所有候选都扣配额
   */
  private async check(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const state = await this.load();
    this.cleanModelCooldowns(state, now);

    // key 级别冷却
    if (state.cooldownUntil > now) {
      return Response.json({
        allowed: false,
        reason: 'cooldown',
        retryAfter: state.cooldownUntil - now,
        healthStatus: state.healthStatus,
      });
    }

    const body = (await request.json()) as { model?: string };

    // 模型级别冷却
    if (body.model && state.modelCooldowns?.[body.model]) {
      const mc = state.modelCooldowns[body.model];
      if (mc.until > now) {
        return Response.json({
          allowed: false,
          reason: 'model_cooldown',
          retryAfter: mc.until - now,
          healthStatus: mc.status as any,
          model: body.model,
        });
      }
    }

    // 只读检查速率(不扣减)
    const rpmLimit = parseInt(this.env.RATE_LIMIT_MAX_REQUESTS || '60', 10);
    const rpdLimit = rpmLimit * 1440;
    this.rollWindow(state, now);

    if (state.rateCount.minute >= rpmLimit) {
      return Response.json({ allowed: false, reason: 'rpm_exceeded', retryAfter: 60 - (now % 60), healthStatus: state.healthStatus });
    }
    if (state.rateCount.day >= rpdLimit) {
      return Response.json({ allowed: false, reason: 'rpd_exceeded', retryAfter: state.windowStart.day + 86400 - now, healthStatus: state.healthStatus });
    }

    // 不 save — 只读不写
    return Response.json({ allowed: true, healthStatus: state.healthStatus });
  }

  /**
   * 只消费配额(不检查限制) — 请求已成功,直接扣减
   * POST /consume
   * Body: { estimatedTokens?, model? }
   */
  private async consume(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const state = await this.load();
    this.cleanModelCooldowns(state, now);
    this.rollWindow(state, now);

    const body = (await request.json()) as { estimatedTokens?: number; model?: string };
    const tokens = body.estimatedTokens ?? 100;

    state.rateCount.minute += 1;
    state.rateCount.day += 1;
    state.tokenCount.minute += tokens;
    state.tokenCount.day += tokens;
    state.lastUsedAt = now;
    await this.save(state);

    return Response.json({ ok: true, healthStatus: state.healthStatus });
  }

  /**
   * 检查并消费一次请求配额(实际扣减)
   * POST /check-and-consume
   * Body: { estimatedTokens?, model?, rpmLimit?, rpdLimit?, tpmLimit?, tpdLimit? }
   * model: 指定模型名,用于检查该模型是否有独立冷却(如百炼按模型限流)
   */
  private async checkAndConsume(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const state = await this.load();

    // 清理过期模型冷却
    this.cleanModelCooldowns(state, now);

    // key 级别冷却(401/403/500 等整 key 问题)
    if (state.cooldownUntil > now) {
      return Response.json({
        allowed: false,
        reason: 'cooldown',
        retryAfter: state.cooldownUntil - now,
        healthStatus: state.healthStatus,
      });
    }

    const body = (await request.json()) as {
      estimatedTokens?: number;
      model?: string;
      rpmLimit?: number;
      rpdLimit?: number;
      tpmLimit?: number;
      tpdLimit?: number;
    };

    // 检查模型级别冷却(百炼等平台每个模型有独立免费额度)
    if (body.model && state.modelCooldowns?.[body.model]) {
      const mc = state.modelCooldowns[body.model];
      if (mc.until > now) {
        return Response.json({
          allowed: false,
          reason: 'model_cooldown',
          retryAfter: mc.until - now,
          healthStatus: mc.status as any,
          model: body.model,
        });
      }
    }

    this.rollWindow(state, now);

    const rpmLimit = body.rpmLimit ?? parseInt(this.env.RATE_LIMIT_MAX_REQUESTS || '60', 10);
    const rpdLimit = body.rpdLimit ?? rpmLimit * 1440;
    const tpmLimit = body.tpmLimit ?? rpmLimit * 1000;
    const tpdLimit = body.tpdLimit ?? tpmLimit * 1440;
    const tokens = body.estimatedTokens ?? 100;

    if (state.rateCount.minute >= rpmLimit) {
      return Response.json({
        allowed: false,
        reason: 'rpm_exceeded',
        retryAfter: 60 - (now % 60),
        healthStatus: state.healthStatus,
      });
    }
    if (state.rateCount.day >= rpdLimit) {
      return Response.json({
        allowed: false,
        reason: 'rpd_exceeded',
        retryAfter: state.windowStart.day + 86400 - now,
        healthStatus: state.healthStatus,
      });
    }
    if (state.tokenCount.minute + tokens > tpmLimit) {
      return Response.json({
        allowed: false,
        reason: 'tpm_exceeded',
        retryAfter: 60 - (now % 60),
        healthStatus: state.healthStatus,
      });
    }
    if (state.tokenCount.day + tokens > tpdLimit) {
      return Response.json({
        allowed: false,
        reason: 'tpd_exceeded',
        retryAfter: state.windowStart.day + 86400 - now,
        healthStatus: state.healthStatus,
      });
    }

    // 消费配额
    state.rateCount.minute += 1;
    state.rateCount.day += 1;
    state.tokenCount.minute += tokens;
    state.tokenCount.day += tokens;
    state.lastUsedAt = now;
    await this.save(state);

    return Response.json({ allowed: true, healthStatus: state.healthStatus });
  }

  /**
   * 记录请求结果(用于健康状态更新)
   * POST /record-result
   * Body: { status, errorMessage?, retryAfter?, model? }
   * model: 指定模型名。429 时只冷却该模型,不冷却整个 key
   *        401/403 时冷却整个 key(说明 key 本身有问题)
   */
  private async recordResult(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const body = (await request.json()) as { status: number; errorMessage?: string; retryAfter?: number; model?: string };
    const state = await this.load();

    // 清理过期模型冷却
    this.cleanModelCooldowns(state, now);

    if (body.status === 429) {
      // 429: 按模型级别冷却(百炼等平台每个模型有独立额度)
      if (body.model) {
        const cooldown = body.retryAfter && body.retryAfter > 0
          ? Math.min(body.retryAfter, 86400)
          : COOLDOWN_SECONDS.rate_limited;
        if (!state.modelCooldowns) state.modelCooldowns = {};
        state.modelCooldowns[body.model] = {
          until: now + cooldown,
          status: 'rate_limited',
        };
        // 不设置 key 级别冷却 — 其他模型还能用
      } else {
        // 没有指定模型,冷却整个 key
        const cooldown = body.retryAfter && body.retryAfter > 0
          ? Math.min(body.retryAfter, 86400)
          : COOLDOWN_SECONDS.rate_limited;
        state.healthStatus = 'rate_limited';
        state.cooldownUntil = now + cooldown;
      }
    } else if (body.status === 401 || body.status === 403) {
      // 401/403: key 本身无效,冷却整个 key
      state.healthStatus = 'invalid';
      state.cooldownUntil = now + COOLDOWN_SECONDS.invalid;
    } else if (body.status >= 500 || body.status === 408 || body.status === 504) {
      // 5xx: 服务器错误,短暂冷却整个 key
      state.healthStatus = 'error';
      state.cooldownUntil = now + COOLDOWN_SECONDS.error;
    } else if (body.status >= 200 && body.status < 300) {
      // 成功:清除 key 级别错误状态(不清除模型级冷却)
      state.healthStatus = 'healthy';
      state.cooldownUntil = 0;
    } else {
      state.healthStatus = 'error';
      state.cooldownUntil = now + COOLDOWN_SECONDS.error;
    }

    await this.save(state);

    return Response.json({
      healthStatus: state.healthStatus,
      cooldownUntil: state.cooldownUntil,
      modelCooldowns: state.modelCooldowns,
    });
  }

  /**
   * 获取所有模型的冷却状态(前端用)
   * GET /get-model-status
   * 只读操作 — 不写 storage
   */
  private async getModelStatus(_request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const state = await this.load();
    // 只在内存中清理,不写 storage(避免读操作产生写开销)
    this.cleanModelCooldowns(state, now);

    const result: Record<string, { status: string; retryAfter: number }> = {};
    if (state.modelCooldowns) {
      for (const [model, mc] of Object.entries(state.modelCooldowns)) {
        if (mc.until > now) {
          result[model] = { status: mc.status, retryAfter: mc.until - now };
        }
      }
    }
    return Response.json({ models: result });
  }

  private async get(): Promise<Response> {
    const state = await this.load();
    return Response.json(state);
  }

  private async reset(): Promise<Response> {
    await this.state.storage.delete('state');
    return Response.json({ ok: true });
  }
}

/**
 * 辅助:获取一个 KeyState DO stub
 */
export function getKeyStateStub(env: { KEY_STATE: DurableObjectNamespace }, keyId: number): DurableObjectStub {
  const id = env.KEY_STATE.idFromName(`key-${keyId}`);
  return env.KEY_STATE.get(id);
}
