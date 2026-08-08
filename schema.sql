-- FreeLLMAPI D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  label TEXT,
  is_active INTEGER DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  label TEXT,
  base_url TEXT,
  key_data TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_tag TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  last_checked TEXT,
  error_count INTEGER DEFAULT 0,
  cooldown_until TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER DEFAULT 4096,
  max_tokens INTEGER DEFAULT 2048,
  supports_vision INTEGER DEFAULT 0,
  supports_tools INTEGER DEFAULT 0,
  supports_streaming INTEGER DEFAULT 1,
  is_enabled INTEGER DEFAULT 1,
  intelligence_rank INTEGER DEFAULT 5,
  speed_rank INTEGER DEFAULT 5,
  reliability_score REAL DEFAULT 1.0,
  price_hint TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fallback_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_name TEXT DEFAULT 'default',
  provider TEXT NOT NULL,
  priority INTEGER NOT NULL,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  model_id TEXT,
  provider TEXT,
  messages TEXT,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT DEFAULT (datetime('now')),
  endpoint TEXT,
  provider TEXT,
  model TEXT,
  latency_ms INTEGER,
  tokens_prompt INTEGER DEFAULT 0,
  tokens_completion INTEGER DEFAULT 0,
  status_code INTEGER,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS catalog_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT,
  signature TEXT,
  data TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
CREATE INDEX IF NOT EXISTS idx_fallback_chain_profile ON fallback_chain(profile_name, priority);
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_provider ON analytics(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Default admin user (password: admin123, should be changed on first login)
INSERT OR IGNORE INTO users (email, password_hash, role)
VALUES ('admin@freellmapi.local', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'admin');

-- Default fallback chain
INSERT OR IGNORE INTO fallback_chain (profile_name, provider, priority, is_enabled) VALUES
  ('default', 'google', 1, 1),
  ('default', 'groq', 2, 1),
  ('default', 'cloudflare', 3, 1),
  ('default', 'nvidia', 4, 1),
  ('default', 'mistral', 5, 1),
  ('default', 'openrouter', 6, 1),
  ('default', 'cerebras', 7, 1),
  ('default', 'cohere', 8, 1);