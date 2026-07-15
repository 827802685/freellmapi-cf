/**
 * Cloudflare Workers 环境类型定义
 */

export interface Env {
  // 绑定
  DB: D1Database;
  CONFIG: KVNamespace;
  KEY_STATE: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;

  // 环境变量
  ENVIRONMENT: string;
  SESSION_TTL_MINUTES: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT_MAX_REQUESTS: string;

  // Secrets
  ENCRYPTION_KEY: string;       // 64 字符 hex (32 字节)
  JWT_SECRET: string;
  ADMIN_BOOTSTRAP_CODE: string;
  CATALOG_SIGNING_KEY?: string;
}

// ---------------- 业务类型 ----------------

export type Platform =
  | 'groq' | 'google' | 'cerebras' | 'opencode'
  | 'mistral' | 'openrouter' | 'github' | 'cloudflare'
  | 'cohere' | 'zai' | 'nvidia' | 'huggingface'
  | 'ollama' | 'kilo' | 'pollinations' | 'llm7'
  | 'ovh' | 'aihorde' | 'custom';

export type HealthStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string | null;
  key_ciphertext: string;
  key_iv: string;
  key_tag: string;
  key_hint: string | null;
  enabled: number;
  health_status: HealthStatus;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
  custom_base_url?: string | null;
}

export interface Model {
  id: string;
  platform: Platform;
  model_name: string;
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
  source: 'local' | 'remote';
  updated_at: number;
}

export interface FallbackEntry {
  id: number;
  position: number;
  platform: Platform;
  model: string;
  key_id: number | null;
  enabled: number;
}

export interface CustomProvider {
  id: number;
  label: string;
  base_url: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  enabled: number;
  created_at: number;
}

// OpenAI 兼容请求
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: Tool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };
  seed?: number;
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// 路由选择结果
export interface RouteCandidate {
  platform: Platform;
  model: string;
  keyId: number;
  keyPlaintext: string;
  customBaseUrl?: string | null;  // custom 平台需要
}

// Durable Object 状态
export interface KeyStateDO {
  rateCount: { minute: number; day: number };
  tokenCount: { minute: number; day: number };
  windowStart: { minute: number; day: number };
  healthStatus: HealthStatus;
  lastUsedAt: number;
  cooldownUntil: number;
}
