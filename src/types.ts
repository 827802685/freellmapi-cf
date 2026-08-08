// FreeLLMAPI TypeScript Type Definitions

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  MEDIA: R2Bucket;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  CATALOG_URL: string;
  SITE_TITLE: string;
}

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: number;
  key_prefix: string;
  key_hash: string;
  label: string | null;
  is_active: number;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface ProviderKey {
  id: number;
  provider: string;
  label: string | null;
  base_url: string | null;
  key_data: string;
  key_iv: string;
  key_tag: string;
  status: string;
  last_checked: string | null;
  error_count: number;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelInfo {
  id: number;
  model_id: string;
  provider: string;
  display_name: string | null;
  context_window: number;
  max_tokens: number;
  supports_vision: number;
  supports_tools: number;
  supports_streaming: number;
  is_enabled: number;
  intelligence_rank: number;
  speed_rank: number;
  reliability_score: number;
  price_hint: string | null;
}

export interface FallbackChain {
  id: number;
  profile_name: string;
  provider: string;
  priority: number;
  is_enabled: number;
}

export interface Session {
  id: number;
  session_id: string;
  model_id: string | null;
  provider: string | null;
  messages: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface Analytics {
  id: number;
  timestamp: string;
  endpoint: string | null;
  provider: string | null;
  model: string | null;
  latency_ms: number | null;
  tokens_prompt: number;
  tokens_completion: number;
  status_code: number | null;
  user_id: string | null;
}

// Request/Response types
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: ToolDef[];
  tool_choice?: string | ToolChoice;
  response_format?: ResponseFormat;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  stop?: string | string[];
  user?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolChoice {
  type: 'function';
  function: { name: string };
}

export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: Usage;
  provider?: string;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
  usage?: Usage;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ModelListResponse {
  object: string;
  data: ModelEntry[];
}

export interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  permission?: unknown[];
}

export interface ProviderAdapter {
  name: string;
  chat(params: ChatParams): Promise<Response>;
  chatStream(params: ChatParams): Promise<ReadableStream<Uint8Array>>;
  models(): Promise<ModelInfo[]>;
  health(): Promise<HealthStatus>;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: ToolDef[];
  tool_choice?: string | ToolChoice;
  response_format?: ResponseFormat;
  seed?: number;
  stop?: string | string[];
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface HealthStatus {
  provider: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  user?: User;
  apiKey?: ApiKey;
}

export interface AdminStats {
  requests: number;
  models: number;
  tokens: number;
  users: number;
  providers: number;
  uptime: string;
  version: string;
  deployment: string;
}

export interface ProviderUsageStat {
  provider: string;
  count: number;
  percentage: number;
}

export interface DashboardData {
  stats: AdminStats;
  providerUsage: ProviderUsageStat[];
  recentEndpoints: { endpoint: string; method: string; count: number }[];
  version: string;
}