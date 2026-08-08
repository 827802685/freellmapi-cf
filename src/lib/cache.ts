// KV Cache wrapper for FreeLLMAPI

export class Cache {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  // Rate limiting counters
  private rateLimitKey(platform: string, model: string, keyId: string, window: string): string {
    return `ratelimit:${platform}:${model}:${keyId}:${window}`;
  }

  async incrementRateLimit(platform: string, model: string, keyId: string, window: string, ttl: number): Promise<number> {
    const key = this.rateLimitKey(platform, model, keyId, window);
    const value = await this.kv.get(key, 'text');
    const count = (value ? parseInt(value, 10) : 0) + 1;
    await this.kv.put(key, count.toString(), { expirationTtl: ttl });
    return count;
  }

  async getRateLimit(platform: string, model: string, keyId: string, window: string): Promise<number> {
    const key = this.rateLimitKey(platform, model, keyId, window);
    const value = await this.kv.get(key, 'text');
    return value ? parseInt(value, 10) : 0;
  }

  // Model catalog cache
  private catalogKey = 'catalog:models';

  async getCachedCatalog<T>(): Promise<T | null> {
    const data = await this.kv.get(this.catalogKey, 'text');
    return data ? JSON.parse(data) : null;
  }

  async setCachedCatalog<T>(data: T, ttl: number = 43200): Promise<void> {
    await this.kv.put(this.catalogKey, JSON.stringify(data), { expirationTtl: ttl });
  }

  // Session cache
  private sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  async getSession<T>(sessionId: string): Promise<T | null> {
    const data = await this.kv.get(this.sessionKey(sessionId), 'text');
    return data ? JSON.parse(data) : null;
  }

  async setSession<T>(sessionId: string, data: T, ttl: number = 1800): Promise<void> {
    await this.kv.put(this.sessionKey(sessionId), JSON.stringify(data), { expirationTtl: ttl });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.kv.delete(this.sessionKey(sessionId));
  }

  // Provider health cache
  private healthKey(provider: string): string {
    return `health:${provider}`;
  }

  async getProviderHealth(provider: string): Promise<{ ok: boolean; latency_ms: number; timestamp: number } | null> {
    const data = await this.kv.get(this.healthKey(provider), 'text');
    return data ? JSON.parse(data) : null;
  }

  async setProviderHealth(provider: string, status: { ok: boolean; latency_ms: number }, ttl: number = 300): Promise<void> {
    await this.kv.put(
      this.healthKey(provider),
      JSON.stringify({ ...status, timestamp: Date.now() }),
      { expirationTtl: ttl }
    );
  }

  // In-progress tracking (for sticky sessions)
  private inProgressKey(provider: string, model: string, keyId: string): string {
    return `inprogress:${provider}:${model}:${keyId}`;
  }

  async getInProgressCount(provider: string, model: string, keyId: string): Promise<number> {
    const key = this.inProgressKey(provider, model, keyId);
    const value = await this.kv.get(key, 'text');
    return value ? parseInt(value, 10) : 0;
  }

  async incrementInProgress(provider: string, model: string, keyId: string): Promise<void> {
    const key = this.inProgressKey(provider, model, keyId);
    const value = await this.kv.get(key, 'text');
    const count = (value ? parseInt(value, 10) : 0) + 1;
    await this.kv.put(key, count.toString(), { expirationTtl: 120 });
  }

  async decrementInProgress(provider: string, model: string, keyId: string): Promise<void> {
    const key = this.inProgressKey(provider, model, keyId);
    const value = await this.kv.get(key, 'text');
    if (value) {
      const count = parseInt(value, 10) - 1;
      if (count <= 0) {
        await this.kv.delete(key);
      } else {
        await this.kv.put(key, count.toString(), { expirationTtl: 120 });
      }
    }
  }

  // Generic KV operations
  async get<T>(key: string): Promise<T | null> {
    const data = await this.kv.get(key, 'text');
    return data ? JSON.parse(data) : null;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (ttl) {
      await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
    } else {
      await this.kv.put(key, JSON.stringify(value));
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}