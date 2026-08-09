// ============================================================
// FreeLLM API - D1 Database Access Layer
// ============================================================

import type {
  User,
  ApiKey,
  ProviderKey,
  ModelInfo,
  AnalyticsRecord,
  Session,
  Settings,
  AdminStats,
} from '../types';

export class Db {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ==================== Users ====================

  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(email)
      .first<User>();
    return result || null;
  }

  async getUserById(id: number): Promise<User | null> {
    const result = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first<User>();
    return result || null;
  }

  async createUser(email: string, passwordHash: string, role: 'admin' | 'user'): Promise<User> {
    const result = await this.db
      .prepare(
        'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?) RETURNING *'
      )
      .bind(email, passwordHash, role)
      .first<User>();
    if (!result) throw new Error('Failed to create user');
    return result;
  }

  // ==================== Sessions ====================

  async createSession(userId: number, tokenHash: string, expiresAt: string): Promise<Session> {
    const result = await this.db
      .prepare(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?) RETURNING *'
      )
      .bind(userId, tokenHash, expiresAt)
      .first<Session>();
    if (!result) throw new Error('Failed to create session');
    return result;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const result = await this.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime(\'now\')')
      .bind(tokenHash)
      .first<Session>();
    return result || null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')')
      .run();
  }

  // ==================== API Keys ====================

  async getApiKeys(page = 1, pageSize = 20): Promise<{ keys: ApiKey[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as total FROM api_keys')
      .first<{ total: number }>();
    const total = countResult?.total || 0;

    const keys = await this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(pageSize, offset)
      .all<ApiKey>();

    return { keys: keys.results, total };
  }

  async getApiKeyById(id: number): Promise<ApiKey | null> {
    const result = await this.db
      .prepare('SELECT * FROM api_keys WHERE id = ?')
      .bind(id)
      .first<ApiKey>();
    return result || null;
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const result = await this.db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
      .bind(keyHash)
      .first<ApiKey>();
    return result || null;
  }

  async createApiKey(
    keyPrefix: string,
    keyHash: string,
    keyEncrypted: string,
    name: string,
    userId: number,
    rateLimit: number,
    expiresAt: string | null
  ): Promise<ApiKey> {
    const result = await this.db
      .prepare(
        `INSERT INTO api_keys (key_prefix, key_hash, key_encrypted, name, user_id, rate_limit, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .bind(keyPrefix, keyHash, keyEncrypted, name, userId, rateLimit, expiresAt)
      .first<ApiKey>();
    if (!result) throw new Error('Failed to create API key');
    return result;
  }

  async updateApiKeyStatus(id: number, isActive: number): Promise<void> {
    await this.db
      .prepare('UPDATE api_keys SET is_active = ? WHERE id = ?')
      .bind(isActive, id)
      .run();
  }

  async deleteApiKey(id: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM api_keys WHERE id = ?')
      .bind(id)
      .run();
  }

  async updateApiKeyLastUsed(id: number): Promise<void> {
    await this.db
      .prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?')
      .bind(id)
      .run();
  }

  // ==================== Provider Keys ====================

  async getProviderKeys(): Promise<ProviderKey[]> {
    const result = await this.db
      .prepare('SELECT * FROM provider_keys ORDER BY provider, priority ASC')
      .all<ProviderKey>();
    return result.results;
  }

  async getActiveProviderKeys(provider: string): Promise<ProviderKey[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM provider_keys
         WHERE provider = ? AND is_active = 1
         ORDER BY priority ASC`
      )
      .bind(provider)
      .all<ProviderKey>();
    return result.results;
  }

  async getProviderKeyById(id: number): Promise<ProviderKey | null> {
    const result = await this.db
      .prepare('SELECT * FROM provider_keys WHERE id = ?')
      .bind(id)
      .first<ProviderKey>();
    return result || null;
  }

  async createProviderKey(
    provider: string,
    keyEncrypted: string,
    keyPrefix: string,
    baseUrl: string | null,
    priority: number
  ): Promise<ProviderKey> {
    const result = await this.db
      .prepare(
        `INSERT INTO provider_keys (provider, key_encrypted, key_prefix, base_url, priority)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .bind(provider, keyEncrypted, keyPrefix, baseUrl, priority)
      .first<ProviderKey>();
    if (!result) throw new Error('Failed to create provider key');
    return result;
  }

  async updateProviderKey(
    id: number,
    data: Partial<{ key_encrypted: string; base_url: string; is_active: number; priority: number }>
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.key_encrypted !== undefined) {
      sets.push('key_encrypted = ?');
      values.push(data.key_encrypted);
    }
    if (data.base_url !== undefined) {
      sets.push('base_url = ?');
      values.push(data.base_url);
    }
    if (data.is_active !== undefined) {
      sets.push('is_active = ?');
      values.push(data.is_active);
    }
    if (data.priority !== undefined) {
      sets.push('priority = ?');
      values.push(data.priority);
    }

    if (sets.length === 0) return;

    values.push(id);
    await this.db
      .prepare(`UPDATE provider_keys SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  async deleteProviderKey(id: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM provider_keys WHERE id = ?')
      .bind(id)
      .run();
  }

  async incrementProviderKeyUsage(id: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE provider_keys
         SET usage_count = usage_count + 1, last_used_at = datetime('now')
         WHERE id = ?`
      )
      .bind(id)
      .run();
  }

  // ==================== Models ====================

  async getModels(activeOnly = false): Promise<ModelInfo[]> {
    let query = 'SELECT * FROM models';
    if (activeOnly) query += ' WHERE is_active = 1';
    query += ' ORDER BY provider, model_id';

    const result = await this.db.prepare(query).all<ModelInfo>();
    return result.results;
  }

  async getModelById(modelId: string): Promise<ModelInfo | null> {
    const result = await this.db
      .prepare('SELECT * FROM models WHERE model_id = ?')
      .bind(modelId)
      .first<ModelInfo>();
    return result || null;
  }

  async updateModel(modelId: string, data: Partial<{ is_active: number; display_name: string }>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.is_active !== undefined) {
      sets.push('is_active = ?');
      values.push(data.is_active);
    }
    if (data.display_name !== undefined) {
      sets.push('display_name = ?');
      values.push(data.display_name);
    }

    if (sets.length === 0) return;

    values.push(modelId);
    await this.db
      .prepare(`UPDATE models SET ${sets.join(', ')} WHERE model_id = ?`)
      .bind(...values)
      .run();
  }

  // ==================== Analytics ====================

  async recordAnalytics(record: Omit<AnalyticsRecord, 'id'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO analytics
         (timestamp, model_id, provider, request_duration_ms, prompt_tokens,
          completion_tokens, total_tokens, status, ip_address, user_id, api_key_id, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.timestamp,
        record.model_id,
        record.provider,
        record.request_duration_ms,
        record.prompt_tokens,
        record.completion_tokens,
        record.total_tokens,
        record.status,
        record.ip_address,
        record.user_id,
        record.api_key_id,
        record.cost
      )
      .run();
  }

  async getAnalytics(
    page = 1,
    pageSize = 50,
    filters?: { model?: string; status?: string; from?: string; to?: string }
  ): Promise<{ records: AnalyticsRecord[]; total: number }> {
    let where = 'WHERE 1=1';
    const values: unknown[] = [];

    if (filters?.model) {
      where += ' AND model_id = ?';
      values.push(filters.model);
    }
    if (filters?.status) {
      where += ' AND status = ?';
      values.push(filters.status);
    }
    if (filters?.from) {
      where += ' AND timestamp >= ?';
      values.push(filters.from);
    }
    if (filters?.to) {
      where += ' AND timestamp <= ?';
      values.push(filters.to);
    }

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM analytics ${where}`)
      .bind(...values)
      .first<{ total: number }>();
    const total = countResult?.total || 0;

    const offset = (page - 1) * pageSize;
    const records = await this.db
      .prepare(
        `SELECT * FROM analytics ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      )
      .bind(...values, pageSize, offset)
      .all<AnalyticsRecord>();

    return { records: records.results, total };
  }

  // ==================== Stats ====================

  async getAdminStats(): Promise<AdminStats> {
    const now = new Date().toISOString();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Total requests in 24h
    const totalRequests = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM analytics
         WHERE timestamp >= ? AND timestamp <= ?`
      )
      .bind(twentyFourHoursAgo, now)
      .first<{ count: number }>();

    // Total tokens in 24h
    const totalTokens = await this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) as total FROM analytics
         WHERE timestamp >= ? AND timestamp <= ?`
      )
      .bind(twentyFourHoursAgo, now)
      .first<{ total: number }>();

    // Active keys
    const activeKeys = await this.db
      .prepare('SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1')
      .first<{ count: number }>();

    // Active providers
    const activeProviders = await this.db
      .prepare(
        'SELECT COUNT(DISTINCT provider) as count FROM provider_keys WHERE is_active = 1'
      )
      .first<{ count: number }>();

    // Total models
    const totalModels = await this.db
      .prepare('SELECT COUNT(*) as count FROM models WHERE is_active = 1')
      .first<{ count: number }>();

    // Requests by model (24h)
    const requestsByModel = await this.db
      .prepare(
        `SELECT model_id as model, COUNT(*) as count FROM analytics
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY model_id ORDER BY count DESC LIMIT 10`
      )
      .bind(twentyFourHoursAgo, now)
      .all<{ model: string; count: number }>();

    // Requests by hour (24h)
    const requestsByHour = await this.db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) as hour, COUNT(*) as count
         FROM analytics
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY hour ORDER BY hour ASC`
      )
      .bind(twentyFourHoursAgo, now)
      .all<{ hour: string; count: number }>();

    // Recent errors (last 50)
    const recentErrors = await this.db
      .prepare(
        `SELECT id, model_id as model, status, timestamp
         FROM analytics
         WHERE status != 'success' AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT 20`
      )
      .bind(twentyFourHoursAgo)
      .all<{ id: number; model: string; status: string; timestamp: string }>();

    return {
      total_requests_24h: totalRequests?.count || 0,
      total_tokens_24h: totalTokens?.total || 0,
      active_keys: activeKeys?.count || 0,
      active_providers: activeProviders?.count || 0,
      total_models: totalModels?.count || 0,
      requests_by_model: requestsByModel.results,
      requests_by_hour: requestsByHour.results,
      recent_errors: recentErrors.results,
    };
  }

  // ==================== Settings ====================

  async getSetting(key: string): Promise<string | null> {
    const result = await this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return result?.value || null;
  }

  async getAllSettings(): Promise<Settings[]> {
    const result = await this.db
      .prepare('SELECT * FROM settings ORDER BY key')
      .all<Settings>();
    return result.results;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(key, value)
      .run();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM settings WHERE key = ?')
      .bind(key)
      .run();
  }
}