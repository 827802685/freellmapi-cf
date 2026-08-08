// Model routing service - Enhanced routing logic wrapping router.ts
// Supports auto, fusion, fast, smart, manual, and specific modes
// Load balances across multiple keys per provider
// Tracks in-progress requests per key for affinity

import type { ModelInfo, ProviderKey, FallbackChain, HealthStatus } from '../types';
import type { RouteResult } from '../lib/router';
import { DB } from '../lib/db';
import { Cache } from '../lib/cache';
import { selectRoute, assignKeysToCandidates, getRoutingStrategy } from '../lib/router';

// Extended route result with additional metadata
export interface RouteResultWithMeta extends RouteResult {
  mode: string;
  strategy: string;
  candidatesConsidered: number;
  loadBalanced: boolean;
}

// Routing mode type
export type RoutingMode = 'auto' | 'fusion' | 'fast' | 'smart' | 'manual' | 'specific';

// In-progress tracking entry
interface InProgressEntry {
  provider: string;
  modelId: string;
  keyId: number;
  startedAt: number;
}

/**
 * Enhanced routing handler that wraps the base router with:
 * - Multi-key load balancing per provider
 * - In-progress request tracking
 * - Multiple mode support
 * - Cooldown-aware key selection
 */
export async function handleRouting(
  db: DB,
  cache: Cache,
  requestModel: string,
  mode: RoutingMode = 'auto',
  sessionId?: string
): Promise<RouteResultWithMeta | null> {
  const startTime = Date.now();
  const strategy = resolveStrategy(requestModel, mode);

  // Step 1: Use base router to get initial route
  const baseRoute = await selectRoute(db, cache, requestModel, sessionId);

  if (!baseRoute) {
    return null;
  }

  // Step 2: For multi-key providers, load balance across available keys
  const allKeys = await db.getProviderKeysByProvider(baseRoute.provider);

  if (allKeys.length === 0) {
    return null;
  }

  // Step 3: Filter and rank keys by load
  const rankedKey = await selectBestKey(db, cache, baseRoute.provider, baseRoute.model.model_id, allKeys);

  if (!rankedKey) {
    return null;
  }

  // Step 4: Track in-progress request
  await trackInProgress(cache, baseRoute.provider, baseRoute.model.model_id, rankedKey.id.toString());

  const elapsed = Date.now() - startTime;

  return {
    provider: baseRoute.provider,
    model: baseRoute.model,
    key: rankedKey,
    sessionId: baseRoute.sessionId,
    mode,
    strategy,
    candidatesConsidered: allKeys.length,
    loadBalanced: allKeys.length > 1,
  };
}

/**
 * Resolve the effective routing strategy from model parameter and mode.
 */
function resolveStrategy(requestModel: string, mode: RoutingMode): string {
  if (requestModel.startsWith('auto:')) {
    return requestModel.split(':')[1];
  }
  if (requestModel === 'auto' || requestModel === 'fusion') {
    return requestModel;
  }
  return mode;
}

/**
 * Select the best key from available keys for a provider based on:
 * - Active status
 * - Cooldown status
 * - Current in-progress request count (load balancing)
 * - Round-robin via lowest in-progress count
 */
async function selectBestKey(
  db: DB,
  cache: Cache,
  provider: string,
  modelId: string,
  keys: ProviderKey[]
): Promise<ProviderKey | null> {
  const now = new Date().toISOString();

  // Filter out inactive and cooldown keys
  const availableKeys = keys.filter(k => {
    if (k.status !== 'active') return false;
    if (k.cooldown_until && k.cooldown_until > now) return false;
    return true;
  });

  if (availableKeys.length === 0) {
    // Check if any key exists but all are in cooldown - return the one with shortest cooldown
    const cooldownKeys = keys
      .filter(k => k.cooldown_until && k.cooldown_until > now)
      .sort((a, b) => (a.cooldown_until || '').localeCompare(b.cooldown_until || ''));

    if (cooldownKeys.length > 0) {
      // Still return the first available key even if on cooldown (will be caught upstream)
      return keys[0];
    }
    return null;
  }

  // Load balance: get in-progress counts for each available key
  const loadCounts = await Promise.all(
    availableKeys.map(async (k) => {
      const count = await cache.getInProgressCount(provider, modelId, k.id.toString());
      return { key: k, count };
    })
  );

  // Sort by in-progress count (ascending) for load balancing
  loadCounts.sort((a, b) => a.count - b.count);

  return loadCounts[0].key;
}

/**
 * Track an in-progress request for a specific key.
 */
async function trackInProgress(
  cache: Cache,
  provider: string,
  modelId: string,
  keyId: string
): Promise<void> {
  await cache.incrementInProgress(provider, modelId, keyId);
}

/**
 * Complete a tracked in-progress request.
 */
export async function completeInProgress(
  cache: Cache,
  provider: string,
  modelId: string,
  keyId: string
): Promise<void> {
  await cache.decrementInProgress(provider, modelId, keyId);
}

/**
 * Get routing recommendations based on context and history.
 */
export async function getRoutingRecommendations(
  db: DB,
  cache: Cache,
  sessionId?: string
): Promise<{
  suggestedMode: RoutingMode;
  suggestedModel: string;
  availableProviders: string[];
  reasons: string[];
}> {
  const reasons: string[] = [];

  // Check if session has existing route
  if (sessionId) {
    const session = await cache.getSession<{ modelId: string; provider: string }>(sessionId);
    if (session) {
      reasons.push(`Existing session routes to ${session.provider}/${session.modelId}`);
      return {
        suggestedMode: 'specific',
        suggestedModel: session.modelId,
        availableProviders: [session.provider],
        reasons,
      };
    }
  }

  // Get all enabled models
  const models = await db.getModels();
  const providers = [...new Set(models.map(m => m.provider))];

  // Get health status to recommend healthy providers
  const healthyProviders: string[] = [];
  for (const provider of providers) {
    const health = await cache.getProviderHealth(provider);
    if (health && health.ok) {
      healthyProviders.push(provider);
    }
  }

  if (healthyProviders.length === 0) {
    reasons.push('No recent health data available, using default routing');
    return {
      suggestedMode: 'auto',
      suggestedModel: 'auto',
      availableProviders: providers,
      reasons,
    };
  }

  reasons.push(`${healthyProviders.length} providers reported healthy`);
  return {
    suggestedMode: 'auto',
    suggestedModel: 'auto',
    availableProviders: healthyProviders,
    reasons,
  };
}

/**
 * Convert a mode string to a normalized RoutingMode.
 */
export function normalizeMode(mode: string): RoutingMode {
  const normalized = mode.toLowerCase().trim();
  const validModes: RoutingMode[] = ['auto', 'fusion', 'fast', 'smart', 'manual', 'specific'];
  if (validModes.includes(normalized as RoutingMode)) {
    return normalized as RoutingMode;
  }
  return 'auto';
}

/**
 * Get the fallback provider chain for a given mode.
 */
export async function getFallbackProviders(
  db: DB,
  mode: RoutingMode
): Promise<FallbackChain[]> {
  const profileName = mode === 'manual' ? 'manual' : 'default';
  return db.getFallbackChain(profileName);
}