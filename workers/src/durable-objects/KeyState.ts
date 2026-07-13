/**
 * Durable Object: Per-key 状态
 * 负责单条 API key 的:
 * - 速率计数(RPM/RPD/TPM/TPD)
 * - 健康状态
 * - 冷却时间(失败后短期内不再使用)
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
      case 'record-result':
        return this.recordResult(request);
      case 'get':
        return this.get();
      case 'reset':
        return this.reset();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async load(): Promise<KeyStateDO> {
    const stored = (await this.state.storage.get<KeyStateDO>('state')) || {
      rateCount: { minute: 0, day: 0 },
      tokenCount: { minute: 0, day: 0 },
      windowStart: { minute: 0, day: 0 },
      healthStatus: 'unknown',
      lastUsedAt: 0,
      cooldownUntil: 0,
    };
    return stored;
  }

  private async save(s: KeyStateDO): Promise<void> {
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

  private rollWindow(state: KeyStateDO, now: number): void {
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
   * 检查并消费一次请求配额
   * POST /check-and-consume
   * Body: { estimatedTokens?: number, rpmLimit?, rpdLimit?, tpmLimit?, tpdLimit? }
   * Response: { allowed: boolean, reason?: string, retryAfter?: number }
   */
  private async checkAndConsume(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const state = await this.load();

    // 冷却期
    if (state.cooldownUntil > now) {
      return Response.json({
        allowed: false,
        reason: 'cooldown',
        retryAfter: state.cooldownUntil - now,
        healthStatus: state.healthStatus,
      });
    }

    this.rollWindow(state, now);

    const body = (await request.json()) as {
      estimatedTokens?: number;
      rpmLimit?: number;
      rpdLimit?: number;
      tpmLimit?: number;
      tpdLimit?: number;
    };

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
   * Body: { status: number, errorMessage?: string }
   */
  private async recordResult(request: Request): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const body = (await request.json()) as { status: number; errorMessage?: string };
    const state = await this.load();

    let health: HealthStatus = 'healthy';
    let cooldown = 0;

    if (body.status === 429) {
      health = 'rate_limited';
      cooldown = COOLDOWN_SECONDS.rate_limited;
    } else if (body.status === 401 || body.status === 403) {
      health = 'invalid';
      cooldown = COOLDOWN_SECONDS.invalid;
    } else if (body.status >= 500 || body.status === 408 || body.status === 504) {
      health = 'error';
      cooldown = COOLDOWN_SECONDS.error;
    } else if (body.status >= 200 && body.status < 300) {
      health = 'healthy';
      cooldown = 0;
    } else {
      health = 'error';
      cooldown = COOLDOWN_SECONDS.error;
    }

    state.healthStatus = health;
    state.cooldownUntil = cooldown > 0 ? now + cooldown : 0;
    await this.save(state);

    return Response.json({ healthStatus: health, cooldownUntil: state.cooldownUntil });
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
