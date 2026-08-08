// Health check service for FreeLLMAPI
// Checks each provider key's health, updates status in DB, caches results
// Export scheduled handler for cron trigger

import type { ProviderKey, HealthStatus } from '../types';
import { DB } from '../lib/db';
import { Cache } from '../lib/cache';

// Health check configuration
const HEALTH_CHECK_TIMEOUT_MS = 10000; // 10 second timeout per provider
const MAX_CONSECUTIVE_ERRORS = 3; // Cooldown after this many errors
const COOLDOWN_DURATION_MINUTES = 15; // Cooldown duration
const CACHE_TTL_SECONDS = 300; // 5 minutes cache TTL
const CONCURRENCY_LIMIT = 5; // Max concurrent health checks

// Cooldown tracking for consecutive errors
interface KeyErrorTracker {
  [keyId: number]: number;
}

const errorTracker: KeyErrorTracker = {};

/**
 * Perform a health check against a single provider key.
 * Sends a lightweight models list request to verify the endpoint is responsive.
 */
export async function checkProviderHealth(
  provider: string,
  key: ProviderKey,
  signal?: AbortSignal
): Promise<HealthStatus> {
  const startTime = Date.now();
  const baseUrl = key.base_url || getDefaultBaseUrl(provider);
  const apiKey = key.key_data; // Note: In production, this should be decrypted via crypto

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const combinedSignal = signal
      ? combineAbortSignals(signal, controller.signal)
      : controller.signal;

    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: combinedSignal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      return {
        provider,
        ok: true,
        latency_ms: latencyMs,
      };
    }

    return {
      provider,
      ok: false,
      latency_ms: latencyMs,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return {
      provider,
      ok: false,
      latency_ms: latencyMs,
      error: errorMessage,
    };
  }
}

/**
 * Check all provider keys and update their status in the database.
 * Also caches aggregate health results per provider.
 */
export async function checkAllProviders(
  db: DB,
  cache: Cache
): Promise<HealthStatus[]> {
  const allKeys = await db.getProviderKeys();
  const results: HealthStatus[] = [];

  // Group keys by provider for aggregate health reporting
  const keysByProvider = new Map<string, ProviderKey[]>();
  for (const key of allKeys) {
    const existing = keysByProvider.get(key.provider) || [];
    existing.push(key);
    keysByProvider.set(key.provider, existing);
  }

  // Process providers concurrently with a concurrency limit
  const providerEntries = Array.from(keysByProvider.entries());

  for (let i = 0; i < providerEntries.length; i += CONCURRENCY_LIMIT) {
    const batch = providerEntries.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async ([provider, keys]) => {
        const providerResults = await checkProviderKeys(db, provider, keys);
        results.push(...providerResults);

        // Compute aggregate health for caching
        const anyHealthy = providerResults.some(r => r.ok);
        const avgLatency = providerResults.length > 0
          ? Math.round(providerResults.reduce((sum, r) => sum + r.latency_ms, 0) / providerResults.length)
          : 0;

        // Cache aggregate provider health
        await cache.setProviderHealth(provider, {
          ok: anyHealthy,
          latency_ms: avgLatency,
        }, CACHE_TTL_SECONDS);

        return providerResults;
      })
    );

    // Flatten batch results
    for (const batchResult of batchResults) {
      results.push(...batchResult);
    }
  }

  return results;
}

/**
 * Check health for all keys of a specific provider and update DB status.
 */
async function checkProviderKeys(
  db: DB,
  provider: string,
  keys: ProviderKey[]
): Promise<HealthStatus[]> {
  const results = await Promise.all(
    keys.map(async (key) => {
      const status = await checkProviderHealth(provider, key);
      await updateKeyStatus(db, key, status);
      return status;
    })
  );

  return results;
}

/**
 * Update a provider key's status in the database based on health check result.
 */
async function updateKeyStatus(
  db: DB,
  key: ProviderKey,
  status: HealthStatus
): Promise<void> {
  if (status.ok) {
    // Reset error count and mark as active
    errorTracker[key.id] = 0;
    await db.updateProviderKeyChecked(key.id);
  } else {
    // Increment error count
    const currentErrors = (errorTracker[key.id] || 0) + 1;
    errorTracker[key.id] = currentErrors;

    if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Put key into cooldown
      const cooldownUntil = new Date(
        Date.now() + COOLDOWN_DURATION_MINUTES * 60 * 1000
      ).toISOString();
      await db.updateProviderKeyStatus(
        key.id,
        'cooldown',
        currentErrors,
        cooldownUntil
      );
      // Reset error tracker after cooldown is set
      errorTracker[key.id] = 0;
    } else {
      // Just update error count, keep as active
      await db.updateProviderKeyStatus(key.id, 'active', currentErrors);
    }
  }
}

/**
 * Scheduled handler for cron-triggered health checks.
 * Compatible with Cloudflare Workers scheduled events.
 */
export async function scheduledHealthCheck(
  db: DB,
  cache: Cache
): Promise<{
  checked: number;
  healthy: number;
  unhealthy: number;
  duration: string;
  timestamp: string;
}> {
  const startTime = Date.now();
  const results = await checkAllProviders(db, cache);

  const healthy = results.filter(r => r.ok).length;
  const unhealthy = results.filter(r => !r.ok).length;
  const durationMs = Date.now() - startTime;

  console.log(`[HealthCheck] Checked ${results.length} providers: ${healthy} healthy, ${unhealthy} unhealthy in ${durationMs}ms`);

  return {
    checked: results.length,
    healthy,
    unhealthy,
    duration: `${durationMs}ms`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get cached health status for all known providers.
 */
export async function getCachedHealthStatus(
  db: DB,
  cache: Cache
): Promise<HealthStatus[]> {
  const allKeys = await db.getProviderKeys();
  const providers = [...new Set(allKeys.map(k => k.provider))];

  const results = await Promise.all(
    providers.map(async (provider) => {
      const cached = await cache.getProviderHealth(provider);
      if (cached) {
        return {
          provider,
          ok: cached.ok,
          latency_ms: cached.latency_ms,
          cached: true,
          timestamp: new Date(cached.timestamp).toISOString(),
        } as HealthStatus & { cached: boolean; timestamp: string };
      }

      // Default to unknown if no cached data
      return {
        provider,
        ok: false,
        latency_ms: 0,
        error: 'No health data available',
      } as HealthStatus;
    })
  );

  return results;
}

/**
 * Get default base URL for a provider if none is configured.
 */
function getDefaultBaseUrl(provider: string): string {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    together: 'https://api.together.xyz/v1',
    fireworks: 'https://api.fireworks.ai/inference/v1',
    deepseek: 'https://api.deepseek.com/v1',
    mistral: 'https://api.mistral.ai/v1',
    cohere: 'https://api.cohere.ai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    perplexity: 'https://api.perplexity.ai',
  };

  return defaults[provider.toLowerCase()] || `https://api.${provider.toLowerCase()}.com/v1`;
}

/**
 * Combine two AbortSignals into one.
 */
function combineAbortSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
  const controller = new AbortController();

  const onAbort = () => {
    controller.abort();
  };

  s1.addEventListener('abort', onAbort, { once: true });
  s2.addEventListener('abort', onAbort, { once: true });

  // Clean up listeners if the combined signal is aborted
  controller.signal.addEventListener('abort', () => {
    s1.removeEventListener('abort', onAbort);
    s2.removeEventListener('abort', onAbort);
  }, { once: true });

  return controller.signal;
}