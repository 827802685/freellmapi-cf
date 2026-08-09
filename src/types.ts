// ============================================================
// FreeLLM API - Cloudflare Worker - Type Definitions
// ============================================================

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD_HASH: string;
  ENCRYPTION_KEY: string;
  SESSION_EXPIRY_HOURS?: number;
  RATE_LIMIT_PER_MINUTE?: number;
  ALLOWED_ORIGINS?: string;
}

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: number;
  key_prefix: string;
  key_hash: string;
  key_encrypted: string;
  name: string;
  user_id: number;
  is_active: number;
  rate_limit: number;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface ProviderKey {
  id: number;
  provider: string;
  key_encrypted: string;
  key_prefix: string;
  base_url: string | null;
  is_active: number;
  priority: number;
  usage_count: number;
  created_at: string;
  last_used_at: string | null;
}

export interface ModelInfo {
  id: number;
  model_id: string;
  provider: string;
  display_name: string;
  context_length: number;
  is_active: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
  created_at: string;
}

export interface AnalyticsRecord {
  id: number;
  timestamp: string;
  model_id: string;
  provider: string;
  request_duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  status: string;
  ip_address: string | null;
  user_id: number | null;
  api_key_id: number | null;
  cost: number;
}

export interface Session {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface Settings {
  id: number;
  key: string;
  value: string;
  updated_at: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
}

export interface AdminStats {
  total_requests_24h: number;
  total_tokens_24h: number;
  active_keys: number;
  active_providers: number;
  total_models: number;
  requests_by_model: { model: string; count: number }[];
  requests_by_hour: { hour: string; count: number }[];
  recent_errors: { id: number; model: string; status: string; timestamp: string }[];
}

export interface AdminLoginRequest {
  email: string;
  password: string;
}

export interface AdminLoginResponse {
  success: boolean;
  token?: string;
  error?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  pagination?: {
    page: number;
    page_size: number;
    total: number;
  };
}

export interface ProviderConfig {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel?: string;
}

export interface HealthCheckResult {
  provider: string;
  status: 'healthy' | 'unhealthy' | 'untested';
  latency_ms: number | null;
  last_checked: string | null;
  error?: string;
}