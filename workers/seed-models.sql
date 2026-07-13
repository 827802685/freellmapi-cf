-- 默认模型目录(本地 fallback,远程同步失败时用)
-- 简化:通过 wrangler d1 execute 批量执行 seed
-- 实际部署时,首次运行会自动从 freellmapi.co/catalog.json 同步
-- 这里是一些常用模型的本地初始数据

INSERT OR IGNORE INTO models (id, platform, model_name, display_name, family, context_window, supports_tools, supports_vision, free_tier_rpm, free_tier_rpd, source) VALUES
  -- Groq
  ('groq:llama-3.3-70b-versatile', 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'llama', 128000, 1, 0, 30, 14400, 'local'),
  ('groq:llama-3.1-8b-instant', 'groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 'llama', 128000, 0, 0, 30, 14400, 'local'),
  ('groq:openai/gpt-oss-120b', 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B', 'gpt-oss', 128000, 1, 0, 30, 14400, 'local'),
  -- Google
  ('google:gemini-2.5-flash', 'google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'gemini-flash', 1000000, 1, 1, 15, 1500, 'local'),
  ('google:gemini-2.5-pro', 'google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'gemini-pro', 1000000, 1, 1, 5, 100, 'local'),
  -- Cerebras
  ('cerebras:qwen-3-235b-a07b-instruct', 'cerebras', 'qwen-3-235b-a07b-instruct', 'Qwen3 235B Instruct', 'qwen', 128000, 1, 0, 30, 14400, 'local'),
  -- Mistral
  ('mistral:mistral-large-2407', 'mistral', 'mistral-large-2407', 'Mistral Large 3', 'mistral-large', 128000, 1, 0, 30, 14400, 'local'),
  ('mistral:codestral-2405', 'mistral', 'codestral-2405', 'Codestral', 'mistral-code', 32000, 0, 0, 30, 14400, 'local'),
  -- OpenRouter
  ('openrouter:qwen/qwen-2.5-72b-instruct:free', 'openrouter', 'qwen/qwen-2.5-72b-instruct:free', 'Qwen 2.5 72B (free)', 'qwen', 32000, 1, 0, 20, 200, 'local'),
  -- Cloudflare
  ('cloudflare:@cf/meta/llama-3.1-8b-instruct', 'cloudflare', '@cf/meta/llama-3.1-8b-instruct', 'Llama 3.1 8B (CF)', 'llama', 128000, 0, 0, 100, 10000, 'local'),
  -- Pollinations (匿名)
  ('pollinations:openai-fast', 'pollinations', 'openai-fast', 'OpenAI Fast', 'openai', 16000, 0, 0, NULL, NULL, 'local');
