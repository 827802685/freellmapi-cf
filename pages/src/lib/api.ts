/**
 * API 客户端
 */

const API_BASE = '';

export interface ApiKey {
  id: number;
  platform: string;
  label: string | null;
  keyHint: string | null;
  keyPlain?: string;  // ⭐ 只在添加/查看时出现
  enabled: number;
  healthStatus: string;
  lastCheckedAt: number | null;
  createdAt: number;
}

export interface UserToken {
  id: number;
  tokenHint: string;
  tokenPlain?: string;
  label: string | null;
  enabled: number;
  createdAt: number;
  lastUsedAt: number | null;
  requestCount: number;
}

export interface PlatformInfo {
  id: string;
  label: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(err.error?.message || res.statusText);
  }
  return res.json();
}

export const api = {
  // 认证
  setupStatus: () => req<{ firstRunCompleted: boolean }>('/api/auth/setup-status'),
  setup: (bootstrapCode: string, email: string, password: string) =>
    req<{ ok: boolean; account: any }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ bootstrapCode, email, password }),
    }),
  login: (email: string, password: string) =>
    req<{ ok: boolean; account: any }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => req<{ account: { accountId: number; email: string } }>('/api/auth/me'),

  // API Keys
  listKeys: () => req<{ keys: ApiKey[] }>('/api/keys'),
  addKey: (platform: string, key: string, label?: string) =>
    req<ApiKey>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ platform, key, label }),
    }),
  getKeyPlain: (id: number) => req<{ keyPlain: string; keyHint: string }>(`/api/keys/${id}/plain`),
  updateKey: (id: number, patch: Partial<{ label: string; enabled: number }>) =>
    req<{ updated: boolean }>(`/api/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteKey: (id: number) => req<{ deleted: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),
  checkKey: (id: number) =>
    req<{ ok: boolean; status: number; healthStatus: string }>(`/api/keys/${id}/check`, {
      method: 'POST',
    }),

  // User tokens
  listTokens: () => req<{ tokens: UserToken[] }>('/api/tokens'),
  createToken: (label?: string) =>
    req<UserToken>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  deleteToken: (id: number) => req<{ deleted: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' }),

  // Models
  listPlatforms: () => req<{ platforms: PlatformInfo[] }>('/api/meta/platforms'),
  listModels: (platform?: string) =>
    req<{ models: any[] }>(`/api/models${platform ? `?platform=${platform}` : ''}`),

  // Fallback chain
  getFallback: () => req<{ chain: any[] }>('/api/fallback'),
  setFallback: (entries: any[]) =>
    req<{ ok: boolean }>('/api/fallback', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),

  // Analytics
  getSummary: () => req<any>('/api/analytics/summary'),
  getRecent: (limit = 50) => req<{ logs: any[] }>(`/api/analytics/recent?limit=${limit}`),
};
