// Model routing engine

import type { ModelInfo, FallbackChain, ProviderKey } from '../types';
import { DB } from './db';
import { Cache } from './cache';

interface RouteCandidate {
  provider: string;
  model: ModelInfo;
  key: ProviderKey;
  priority: number;
}

export interface RouteResult {
  provider: string;
  model: ModelInfo;
  key: ProviderKey;
  sessionId?: string;
}

export async function selectRoute(
  db: DB,
  cache: Cache,
  requestModel: string,
  sessionId?: string,
  profileName: string = 'default'
): Promise<RouteResult | null> {
  // Check sticky session first
  if (sessionId) {
    const session = await cache.getSession<{ modelId: string; provider: string }>(sessionId);
    if (session) {
      const model = await db.getModelByModelId(session.modelId);
      const keys = await db.getProviderKeysByProvider(session.provider);
      if (model && model.is_enabled && keys.length > 0) {
        const activeKey = keys.find(k => k.status === 'active' && (!k.cooldown_until || k.cooldown_until < new Date().toISOString()));
        if (activeKey) {
          return { provider: session.provider, model, key: activeKey, sessionId };
        }
      }
    }
  }

  // Get enabled models
  const allModels = await db.getModels();
  const fallbackChain = await db.getFallbackChain(profileName);

  if (fallbackChain.length === 0) {
    return null;
  }

  // Build candidate list based on model selection strategy
  let candidates: RouteCandidate[] = [];

  if (requestModel === 'auto' || requestModel.startsWith('auto:')) {
    // Auto mode: pick best from fallback chain
    const strategy = requestModel.startsWith('auto:') ? requestModel.split(':')[1] : 'balanced';
    candidates = buildAutoCandidates(allModels, fallbackChain, strategy);
  } else if (requestModel === 'fusion') {
    // Fusion mode: use highest-intelligence models from each provider
    candidates = buildFusionCandidates(allModels, fallbackChain);
  } else {
    // Specific model: find it across providers
    candidates = buildSpecificModelCandidates(allModels, fallbackChain, requestModel);
  }

  // Try each candidate in priority order
  for (const candidate of candidates) {
    // Check if key is on cooldown
    if (candidate.key.cooldown_until && candidate.key.cooldown_until > new Date().toISOString()) {
      continue;
    }
    if (candidate.key.status !== 'active') {
      continue;
    }

    // Check rate limits from cache
    const rpmCount = await cache.getRateLimit(candidate.provider, candidate.model.model_id, candidate.key.id.toString(), 'rpm');
    if (rpmCount >= 60) continue; // 60 RPM default limit

    // Return first viable route
    // Generate new session if sessionId provided
    const newSessionId = sessionId;
    if (newSessionId) {
      await cache.setSession(newSessionId, {
        modelId: candidate.model.model_id,
        provider: candidate.provider,
      }, 1800);
    }

    return {
      provider: candidate.provider,
      model: candidate.model,
      key: candidate.key,
      sessionId: newSessionId,
    };
  }

  return null;
}

function buildAutoCandidates(
  models: ModelInfo[],
  chain: FallbackChain[],
  strategy: string
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  for (const link of chain) {
    const providerModels = models.filter(m => m.provider === link.provider);
    if (providerModels.length === 0) continue;

    // Pick the best model per provider based on strategy
    let bestModel: ModelInfo | null = null;
    switch (strategy) {
      case 'fast':
        bestModel = providerModels.sort((a, b) => b.speed_rank - a.speed_rank)[0];
        break;
      case 'smart':
        bestModel = providerModels.sort((a, b) => b.intelligence_rank - a.intelligence_rank)[0];
        break;
      case 'balanced':
      default:
        bestModel = providerModels.sort((a, b) => (b.intelligence_rank + b.speed_rank) - (a.intelligence_rank + a.speed_rank))[0];
        break;
    }

    if (bestModel) {
      candidates.push({
        provider: link.provider,
        model: bestModel,
        key: { id: 0, provider: link.provider } as ProviderKey, // placeholder
        priority: link.priority,
      });
    }
  }

  return candidates;
}

function buildFusionCandidates(
  models: ModelInfo[],
  chain: FallbackChain[]
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  for (const link of chain) {
    const providerModels = models.filter(m => m.provider === link.provider);
    if (providerModels.length === 0) continue;

    // Pick highest intelligence model per provider
    const best = providerModels.sort((a, b) => b.intelligence_rank - a.intelligence_rank)[0];
    if (best) {
      candidates.push({
        provider: link.provider,
        model: best,
        key: { id: 0, provider: link.provider } as ProviderKey,
        priority: link.priority,
      });
    }
  }

  return candidates;
}

function buildSpecificModelCandidates(
  models: ModelInfo[],
  chain: FallbackChain[],
  modelId: string
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  // Find matching models from any provider
  const matchingModels = models.filter(m => m.model_id === modelId);
  const chainProviders = new Set(chain.filter(l => l.is_enabled).map(l => l.provider));

  for (const model of matchingModels) {
    if (chainProviders.has(model.provider)) {
      const chainLink = chain.find(l => l.provider === model.provider);
      candidates.push({
        provider: model.provider,
        model,
        key: { id: 0, provider: model.provider } as ProviderKey,
        priority: chainLink?.priority || 99,
      });
    }
  }

  // If no exact match, try to find the model as a "model_id" without provider prefix
  if (candidates.length === 0) {
    for (const link of chain) {
      const providerModels = models.filter(m => m.provider === link.provider);
      const match = providerModels.find(m =>
        m.model_id === modelId || m.model_id.endsWith(modelId) || modelId.endsWith(m.model_id)
      );
      if (match) {
        candidates.push({
          provider: link.provider,
          model: match,
          key: { id: 0, provider: link.provider } as ProviderKey,
          priority: link.priority,
        });
      }
    }
  }

  return candidates.sort((a, b) => a.priority - b.priority);
}

export async function assignKeysToCandidates(
  candidates: RouteCandidate[],
  db: DB
): Promise<RouteCandidate[]> {
  const result: RouteCandidate[] = [];
  for (const candidate of candidates) {
    const keys = await db.getProviderKeysByProvider(candidate.provider);
    if (keys.length > 0) {
      result.push({ ...candidate, key: keys[0] });
    }
  }
  return result;
}

export function getRoutingStrategy(modelParam: string): string {
  if (modelParam === 'auto') return 'balanced';
  if (modelParam.startsWith('auto:')) return modelParam.split(':')[1];
  if (modelParam === 'fusion') return 'fusion';
  if (modelParam === 'manual') return 'manual';
  return 'specific';
}