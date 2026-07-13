-- ============================================================
-- freellmapi-cf D1 Schema
-- Cloudflare D1 = SQLite 兼容
-- ============================================================

-- 管理员账号（单用户）
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,         -- scrypt 哈希
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER
);

-- 加密存储的 API Key
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,              -- 'groq' | 'google' | ...
  label TEXT,                          -- 用户自定义标签
  key_ciphertext TEXT NOT NULL,        -- AES-256-GCM 加密的密文 (base64)
  key_iv TEXT NOT NULL,                -- 初始化向量 (base64)
  key_tag TEXT NOT NULL,               -- GCM 认证标签 (base64)
  key_hint TEXT,                       -- 用于 UI 显示的脱敏提示，如 "gsk_***abcd"
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',  -- 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown'
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);

-- Fallback 链配置（用户自定义顺序）
CREATE TABLE IF NOT EXISTS fallback_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL,            -- 排序位置
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  key_id INTEGER,                       -- 关联到具体 key, NULL 表示用该平台任意可用 key
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fallback_position ON fallback_chain(position);

-- 模型目录（来自远程签名 catalog 或本地配置）
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,                  -- 'groq:llama-3.3-70b'
  platform TEXT NOT NULL,
  model_name TEXT NOT NULL,
  display_name TEXT,
  family TEXT,                          -- 用于 family-based routing
  context_window INTEGER,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_streaming INTEGER NOT NULL DEFAULT 1,
  free_tier_rpm INTEGER,                -- 每分钟请求限制
  free_tier_rpd INTEGER,                -- 每天请求限制
  free_tier_tpm INTEGER,                -- 每分钟 token
  free_tier_tpd INTEGER,                -- 每天 token
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'local', -- 'local' | 'remote'
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_models_platform ON models(platform);
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);

-- 自定义 OpenAI 兼容端点
CREATE TABLE IF NOT EXISTS custom_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 自定义模型的端点映射
CREATE TABLE IF NOT EXISTS custom_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  display_name TEXT,
  model_type TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'embedding' | 'image' | 'audio'
  supports_tools INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (provider_id) REFERENCES custom_providers(id) ON DELETE CASCADE
);

-- 用户统一 API key（客户端用来调 /v1）
CREATE TABLE IF NOT EXISTS user_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,      -- 存哈希,不存明文
  token_hint TEXT NOT NULL,             -- 'freellmapi-***abcd'
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0
);

-- 统一 key 会话（粘性）
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                   -- session_id
  user_token_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  platform TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_token_id) REFERENCES user_tokens(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Analytics 请求记录
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_token_id INTEGER,
  model TEXT NOT NULL,
  platform TEXT NOT NULL,
  key_id INTEGER,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  stream INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  client_ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_token_id) REFERENCES user_tokens(id) ON DELETE SET NULL,
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_platform ON request_logs(platform);
CREATE INDEX IF NOT EXISTS idx_logs_user_token ON request_logs(user_token_id);

-- Per-key 速率计数（实际用 Durable Object 存,这里做归档）
CREATE TABLE IF NOT EXISTS rate_counters (
  key_id INTEGER NOT NULL,
  window_start INTEGER NOT NULL,        -- 窗口开始时间戳(秒)
  window_type TEXT NOT NULL,            -- 'minute' | 'day'
  request_count INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start, window_type),
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_counters(window_start, window_type);

-- 系统设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('context_handoff_enabled', 'false'),
  ('catalog_url', 'https://freellmapi.co/catalog.json'),
  ('analytics_retention_days', '90'),
  ('analytics_max_rows', '100000'),
  ('first_run_completed', 'false');
