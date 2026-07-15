/**
 * API 客户端
 */

// 构建时通过 VITE_API_BASE 注入 worker URL。
// 留空 = 同源(配合 dev proxy 或 Pages 配 Functions/_routes)
const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') || '';

const TOKEN_KEY = 'fl_token';
const SESSION_KEY = 'fl_session';

export function setAuthToken(t: string | null) {
  if (typeof window === 'undefined') return;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(s: string | null) {
  if (typeof window === 'undefined') return;
  if (s) localStorage.setItem(SESSION_KEY, s);
  else localStorage.removeItem(SESSION_KEY);
}

export function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(SESSION_KEY);
}

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

/** 单个模型的完整配置（对应 models 表，DB 里 0/1 整数） */
export interface SettingsModel {
  id: string; // 'groq:llama-3.3-70b'
  platform: string;
  model_name: string;
  display_name: string | null;
  family: string | null;
  context_window: number | null;
  supports_tools: number; // 0 | 1
  supports_vision: number; // 0 | 1
  supports_streaming: number; // 0 | 1
  free_tier_rpm: number | null;
  free_tier_rpd: number | null;
  free_tier_tpm: number | null;
  free_tier_tpd: number | null;
  enabled: number; // 0 | 1
  source: string;
  updated_at: number;
}

/** 某平台下 key 的统计信息 */
export interface PlatformKeyInfo {
  total: number;
  enabled: number;
}

/** 一个平台分组（GET /api/settings/providers 返回的元素） */
export interface PlatformGroup {
  platform: string;
  label: string;
  baseUrl?: string | null;
  enabled?: number;
  sortOrder?: number;
  keyInfo: PlatformKeyInfo;
  models: SettingsModel[];
}

/** PUT /api/settings/models/:id 可更新的字段 */
export interface ModelUpdateBody {
  display_name: string | null;
  family: string | null;
  context_window: number | null;
  supports_tools: number;
  supports_vision: number;
  supports_streaming: number;
  free_tier_rpm: number | null;
  free_tier_rpd: number | null;
  free_tier_tpm: number | null;
  free_tier_tpd: number | null;
  enabled: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const session = getSessionToken();
  const url = API_BASE + path;
  // /api/* 用 dashboard session, /v1/* 用 user token
  const isApi = path.startsWith('/api/');
  const bearer = isApi ? (session || token) : (token || session);
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: API_BASE ? 'include' : 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(init?.headers || {}),
      },
      ...init,
    });
  } catch (e: any) {
    // 把 fetch 阶段就挂掉的错误展开,常见: Failed to fetch / NetworkError / TypeError
    const detail = {
      message: e?.message || String(e),
      name: e?.name,
      url,
      apiBase: API_BASE || '(empty → same-origin)',
      origin: typeof window !== 'undefined' ? window.location.origin : '?',
      hint:
        '"Failed to fetch" 通常是浏览器连不上后端或 CORS 预检被拒。\n' +
        '请检查: 1) 后端 URL 在浏览器里直接能开\n' +
        '       2) F12 Network 里看那条失败请求的 Request URL/Origin 是不是配对\n' +
        '       3) 自定义域的 SSL / 反代是否吃掉了 OPTIONS 预检',
    };
    throw new Error(`[fetch] ${detail.message} | url=${detail.url} | origin=${detail.origin}\n\n${detail.hint}`);
  }
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
    req<{ ok: boolean; account: any; token: string }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ bootstrapCode, email, password }),
    }),
  login: (email: string, password: string) =>
    req<{ ok: boolean; account: any; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => req<{ account: { accountId: number; email: string } }>('/api/auth/me'),

  // Models
  listModels: (platform?: string) => {
    const q = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    return req<{ models: any[] }>(`/api/models${q}`);
  },
  // Settings — 模型配置 / 平台额度批量设置
  // id 为 string（如 'groq:llama-3.3-70b'），兼容旧 ModelsPage 传 number
  getProviders: () => req<{ platforms: PlatformGroup[] }>('/api/settings/providers'),
  updateModel: (id: string | number, data: Partial<ModelUpdateBody>) =>
    req<{ updated: boolean }>(`/api/settings/models/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  addModel: (data: { platform: string; model_name: string; display_name?: string; enabled?: number }) =>
    req<{ id: string; created: boolean }>('/api/settings/models', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteModel: (id: string | number) =>
    req<{ deleted: boolean }>(`/api/settings/models/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
  batchDeleteModels: (ids: string[]) =>
    req<{ deleted: number; total: number }>('/api/settings/models/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  updatePlatformLimits: (
    platform: string,
    data: { rpm?: number | null; rpd?: number | null; tpm?: number | null; tpd?: number | null }
  ) =>
    req<{ updated: number }>(`/api/settings/platform/${encodeURIComponent(platform)}/limits`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  addProvider: (data: { platform: string; label: string; base_url?: string; sort_order?: number }) =>
    req<{ platform: string; created: boolean }>('/api/settings/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProvider: (platform: string, data: { label?: string; base_url?: string; enabled?: number; sort_order?: number }) =>
    req<{ updated: boolean }>(`/api/settings/providers/${encodeURIComponent(platform)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteProvider: (platform: string) =>
    req<{ deleted: boolean }>(`/api/settings/providers/${encodeURIComponent(platform)}`, { method: 'DELETE' }),

  // API Keys
  listKeys: () => req<{ keys: ApiKey[] }>('/api/keys'),
  addKey: (platform: string, key: string, label?: string) =>
    req<ApiKey>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ platform, key, label }),
    }),
  createKey: (data: { platform: string; key: string; label?: string; customBaseUrl?: string; customModels?: string }) =>
    req<{ ok: boolean; keyPlain: string; keyHint: string; platform: string; count: number; customBaseUrl?: string | null; customModels?: string | null }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify(data),
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
  syncModels: (id: number) =>
    req<{ ok: boolean; platform: string; total: number; added: number; skipped: number }>(`/api/keys/${id}/sync-models`, {
      method: 'POST',
    }),
  // 试玩:用这个 key 真正调一次上游(不走 fallback,直接测这一把 key)
  tryKey: (
    id: number,
    payload: { model: string; messages: { role: string; content: string }[]; stream?: boolean; maxTokens?: number }
  ) =>
    req<any>(`/api/keys/${id}/chat`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // User tokens
  listTokens: () => req<{ tokens: UserToken[] }>('/api/tokens'),
  createToken: (label?: string) =>
    req<{ ok: boolean; tokenPlain: string; tokenHint: string; label: string | null }>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  deleteToken: (id: number) => req<{ deleted: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' }),
  getTokenPlain: (id: number) =>
    req<{ keyPlain: string; keyHint: string; label: string | null }>(`/api/tokens/${id}/plain`),
  regenerateToken: (id: number) =>
    req<{ tokenPlain: string; tokenHint: string; label: string | null; regenerated: boolean }>(
      `/api/tokens/${id}/regenerate`,
      { method: 'POST' }
    ),

  // Models
  listPlatforms: () => req<{ platforms: PlatformInfo[] }>('/api/meta/platforms'),

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

  // About (公开端点,无需鉴权)
  getAbout: () => req<any>('/api/about'),
};
