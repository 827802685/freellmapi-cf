-- FreeLLMAPI D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    label TEXT,
    base_url TEXT,
    key_data TEXT NOT NULL,
    key_iv TEXT NOT NULL,
    key_tag TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    error_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until TEXT,
    last_checked TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    display_name TEXT,
    context_window INTEGER,
    max_tokens INTEGER,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    supports_tools INTEGER NOT NULL DEFAULT 0,
    supports_streaming INTEGER NOT NULL DEFAULT 1,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    intelligence_rank INTEGER DEFAULT 0,
    speed_rank INTEGER DEFAULT 0,
    reliability_score REAL DEFAULT 0.0,
    price_hint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(model_id, provider)
);

CREATE TABLE IF NOT EXISTS fallback_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT NOT NULL DEFAULT 'default',
    provider TEXT NOT NULL,
    priority INTEGER NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(profile_name, priority)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    messages TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    provider TEXT,
    model TEXT,
    latency_ms INTEGER,
    tokens_prompt INTEGER DEFAULT 0,
    tokens_completion INTEGER DEFAULT 0,
    status_code INTEGER,
    user_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS catalog_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    signature TEXT,
    data TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_provider ON analytics(provider);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);