// ============================================================
// FreeLLM API - Health Check Service
// Periodically checks provider API availability.
// ============================================================

import type { HealthCheckResult, ProviderConfig } from '../types';
import { getAllProviders } from '../providers/index';

export class HealthCheckService {
  private results: Map<string, HealthCheckResult> = new Map();
  private checkIntervalMs: number;

  constructor(checkIntervalMs = 300000) {
    // Default: 5 minutes
    this.checkIntervalMs = checkIntervalMs;
  }

  async checkProvider(config: ProviderConfig, apiKey: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${config.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      const latencyMs = Date.now() - startTime;
      const status = response.ok ? 'healthy' : 'unhealthy';

      const result: HealthCheckResult = {
        provider: config.name,
        status,
        latency_ms: latencyMs,
        last_checked: new Date().toISOString(),
        error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
      };

      this.results.set(config.name, result);
      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const result: HealthCheckResult = {
        provider: config.name,
        status: 'unhealthy',
        latency_ms: latencyMs,
        last_checked: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      this.results.set(config.name, result);
      return result;
    }
  }

  async checkAllProviders(apiKeys: Record<string, string>): Promise<HealthCheckResult[]> {
    const providers = getAllProviders();
    const results: HealthCheckResult[] = [];

    for (const config of providers) {
      const apiKey = apiKeys[config.name] || '';
      if (!apiKey) {
        const result: HealthCheckResult = {
          provider: config.name,
          status: 'untested',
          latency_ms: null,
          last_checked: null,
          error: '未配置 API 密钥',
        };
        this.results.set(config.name, result);
        results.push(result);
        continue;
      }

      const result = await this.checkProvider(config, apiKey);
      results.push(result);
    }

    return results;
  }

  getProviderStatus(provider: string): HealthCheckResult | undefined {
    return this.results.get(provider);
  }

  getAllStatuses(): HealthCheckResult[] {
    return Array.from(this.results.values());
  }

  getHealthyProviders(): string[] {
    return Array.from(this.results.entries())
      .filter(([, result]) => result.status === 'healthy')
      .map(([name]) => name);
  }

  async quickCheck(
    baseUrl: string,
    apiKey: string
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      return {
        ok: response.ok,
        latencyMs: Date.now() - startTime,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }
}