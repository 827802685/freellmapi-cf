// D1 Database access layer

import type { User, ApiKey, ProviderKey, ModelInfo, FallbackChain, Session, Analytics } from '../types';

export class DB {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ---- Users ----
  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
    return result || null;
  }

  async getUserById(id: number): Promise<User | null> {
    const result = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
    return result || null;
  }

  async createUser(email: string, passwordHash: string): Promise<User> {
    const result = await this.db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING *').bind(email, passwordHash).first<User>();
    return result!;
  }

  async updateUserPassword(id: number, passwordHash: string): Promise<void> {
    await this.db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(passwordHash, id).run();
  }

  // ---- API Keys ----
  async getApiKeys(): Promise<ApiKey[]> {
    const result = await this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all<ApiKey>();
    return result.results || [];
  }

  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    const result = await this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1').bind(hash).first<ApiKey>();
    return result || null;
  }

  async createApiKey(keyPrefix: string, keyHash: string, label?: string): Promise<ApiKey> {
    const result = await this.db.prepare('INSERT INTO api_keys (key_prefix, key_hash, label) VALUES (?, ?, ?) RETURNING *').bind(keyPrefix, keyHash, label || null).first<ApiKey>();
    return result!;
  }

  async deleteApiKey(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  }

  async updateApiKeyLastUsed(id: number): Promise<void> {
    await this.db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').bind(id).run();
  }

  // ---- Provider Keys ----
  async getProviderKeys(): Promise<ProviderKey[]> {
    const result = await this.db.prepare('SELECT * FROM provider_keys ORDER BY provider, created_at DESC').all<ProviderKey>();
    return result.results || [];
  }

  async getProviderKeysByProvider(provider: string): Promise<ProviderKey[]> {
    const result = await this.db.prepare('SELECT * FROM provider_keys WHERE provider = ? AND status = \'active\' ORDER BY created_at DESC').bind(provider).all<ProviderKey>();
    return result.results || [];
  }

  async getProviderKeyById(id: number): Promise<ProviderKey | null> {
    const result = await this.db.prepare('SELECT * FROM provider_keys WHERE id = ?').bind(id).first<ProviderKey>();
    return result || null;
  }

  async createProviderKey(provider: string, keyData: string, keyIv: string, keyTag: string, label?: string, baseUrl?: string): Promise<ProviderKey> {
    const result = await this.db.prepare(
      'INSERT INTO provider_keys (provider, label, base_url, key_data, key_iv, key_tag) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(provider, label || null, baseUrl || null, keyData, keyIv, keyTag).first<ProviderKey>();
    return result!;
  }

  async deleteProviderKey(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM provider_keys WHERE id = ?').bind(id).run();
  }

  async updateProviderKeyStatus(id: number, status: string, errorCount?: number, cooldownUntil?: string): Promise<void> {
    const query = errorCount !== undefined
      ? 'UPDATE provider_keys SET status = ?, error_count = ?, cooldown_until = ?, updated_at = datetime(\'now\') WHERE id = ?'
      : 'UPDATE provider_keys SET status = ?, cooldown_until = ?, updated_at = datetime(\'now\') WHERE id = ?';
    const params = errorCount !== undefined
      ? [status, errorCount, cooldownUntil || null, id]
      : [status, cooldownUntil || null, id];
    await this.db.prepare(query).bind(...params).run();
  }

  async updateProviderKeyChecked(id: number): Promise<void> {
    await this.db.prepare('UPDATE provider_keys SET last_checked = datetime(\'now\'), error_count = 0, status = \'active\' WHERE id = ?').bind(id).run();
  }

  // ---- Models ----
  async getModels(provider?: string): Promise<ModelInfo[]> {
    let query = 'SELECT * FROM models WHERE is_enabled = 1';
    const params: unknown[] = [];
    if (provider) {
      query += ' AND provider = ?';
      params.push(provider);
    }
    query += ' ORDER BY intelligence_rank DESC, speed_rank DESC';
    const result = await this.db.prepare(query).bind(...params).all<ModelInfo>();
    return result.results || [];
  }

  async getModelByModelId(modelId: string): Promise<ModelInfo | null> {
    const result = await this.db.prepare('SELECT * FROM models WHERE model_id = ?').bind(modelId).first<ModelInfo>();
    return result || null;
  }

  async upsertModel(model: Omit<ModelInfo, 'id' | 'created_at'>): Promise<void> {
    await this.db.prepare(
      `INSERT INTO models (model_id, provider, display_name, context_window, max_tokens, supports_vision, supports_tools, supports_streaming, is_enabled, intelligence_rank, speed_rank, reliability_score, price_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id, provider) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, display_name),
       context_window = EXCLUDED.context_window,
       max_tokens = EXCLUDED.max_tokens,
       supports_vision = EXCLUDED.supports_vision,
       supports_tools = EXCLUDED.supports_tools,
       intelligence_rank = EXCLUDED.intelligence_rank,
       speed_rank = EXCLUDED.speed_rank,
       reliability_score = EXCLUDED.reliability_score,
       price_hint = EXCLUDED.price_hint`
    ).bind(
      model.model_id, model.provider, model.display_name || null,
      model.context_window, model.max_tokens, model.supports_vision,
      model.supports_tools, model.supports_streaming, model.is_enabled,
      model.intelligence_rank, model.speed_rank, model.reliability_score,
      model.price_hint || null
    ).run();
  }

  // ---- Fallback Chain ----
  async getFallbackChain(profileName: string = 'default'): Promise<FallbackChain[]> {
    const result = await this.db.prepare(
      'SELECT * FROM fallback_chain WHERE profile_name = ? AND is_enabled = 1 ORDER BY priority ASC'
    ).bind(profileName).all<FallbackChain>();
    return result.results || [];
  }

  async setFallbackChain(profileName: string, providers: string[]): Promise<void> {
    await this.db.prepare('DELETE FROM fallback_chain WHERE profile_name = ?').bind(profileName).run();
    for (let i = 0; i < providers.length; i++) {
      await this.db.prepare(
        'INSERT INTO fallback_chain (profile_name, provider, priority) VALUES (?, ?, ?)'
      ).bind(profileName, providers[i], i + 1).run();
    }
  }

  // ---- Sessions ----
  async getSession(sessionId: string): Promise<Session | null> {
    const result = await this.db.prepare(
      'SELECT * FROM sessions WHERE session_id = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\'))'
    ).bind(sessionId).first<Session>();
    return result || null;
  }

  async upsertSession(sessionId: string, modelId: string, provider: string, messages: string, ttlMinutes: number = 30): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    await this.db.prepare(
      `INSERT INTO sessions (session_id, model_id, provider, messages, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET model_id = EXCLUDED.model_id, provider = EXCLUDED.provider, messages = EXCLUDED.messages, expires_at = EXCLUDED.expires_at`
    ).bind(sessionId, modelId, provider, messages, expiresAt).run();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE session_id = ?').bind(sessionId).run();
  }

  async cleanupExpiredSessions(): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  }

  // ---- Analytics ----
  async recordAnalytics(entry: Omit<Analytics, 'id' | 'timestamp'>): Promise<void> {
    await this.db.prepare(
      'INSERT INTO analytics (endpoint, provider, model, latency_ms, tokens_prompt, tokens_completion, status_code, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      entry.endpoint || null, entry.provider || null, entry.model || null,
      entry.latency_ms || null, entry.tokens_prompt, entry.tokens_completion,
      entry.status_code || null, entry.user_id || null
    ).run();
  }

  async getAnalyticsStats(hours: number = 24): Promise<{
    totalRequests: number;
    totalTokens: number;
    averageLatency: number;
    providerStats: { provider: string; count: number; percentage: number }[];
    endpointStats: { endpoint: string; method: string; count: number }[];
  }> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const totalResult = await this.db.prepare(
      "SELECT COUNT(*) as count, COALESCE(SUM(tokens_prompt + tokens_completion), 0) as tokens, COALESCE(AVG(latency_ms), 0) as avg_latency FROM analytics WHERE timestamp > ?"
    ).bind(since).first<{ count: number; tokens: number; avg_latency: number }>();

    const providerResult = await this.db.prepare(
      "SELECT provider, COUNT(*) as count FROM analytics WHERE timestamp > ? AND provider IS NOT NULL GROUP BY provider ORDER BY count DESC"
    ).bind(since).all<{ provider: string; count: number }>();

    const endpointResult = await this.db.prepare(
      "SELECT endpoint, COUNT(*) as count FROM analytics WHERE timestamp > ? AND endpoint IS NOT NULL GROUP BY endpoint ORDER BY count DESC LIMIT 10"
    ).bind(since).all<{ endpoint: string; count: number }>();

    const totalCount = totalResult?.count || 0;
    const providerStats = (providerResult.results || []).map(p => ({
      provider: p.provider,
      count: p.count,
      percentage: totalCount > 0 ? Math.round((p.count / totalCount) * 100) : 0,
    }));

    const endpointStats = (endpointResult.results || []).map(e => ({
      endpoint: e.endpoint,
      method: 'POST',
      count: e.count,
    }));

    return {
      totalRequests: totalCount,
      totalTokens: totalResult?.tokens || 0,
      averageLatency: Math.round(totalResult?.avg_latency || 0),
      providerStats,
      endpointStats,
    };
  }

  async getUserCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();
    return result?.count || 0;
  }

  async getModelCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM models WHERE is_enabled = 1').first<{ count: number }>();
    return result?.count || 0;
  }

  async getProviderKeyCount(): Promise<number> {
    const result = await this.db.prepare('SELECT COUNT(*) as count FROM provider_keys').first<{ count: number }>();
    return result?.count || 0;
  }

  // ---- Catalog Meta ----
  async getCatalogMeta(): Promise<{ version: string; data: string } | null> {
    const result = await this.db.prepare('SELECT * FROM catalog_meta ORDER BY id DESC LIMIT 1').first<{ version: string; data: string }>();
    return result || null;
  }

  async setCatalogMeta(version: string, data: string, signature?: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO catalog_meta (version, signature, data, updated_at) VALUES (?, ?, ?, datetime('now'))"
    ).bind(version, signature || '', data).run();
  }
}