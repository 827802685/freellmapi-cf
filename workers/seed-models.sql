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
  ('pollinations:openai-fast', 'pollinations', 'openai-fast', 'OpenAI Fast', 'openai', 16000, 0, 0, NULL, NULL, 'local'),
  -- Z.AI / 智普 GLM
  ('zai:glm-4.6', 'zai', 'glm-4.6', 'GLM-4.6', 'glm', 200000, 1, 0, 30, 14400, 'local'),
  ('zai:glm-4.5', 'zai', 'glm-4.5', 'GLM-4.5', 'glm', 128000, 1, 0, 30, 14400, 'local'),
  ('zai:glm-4.5-air', 'zai', 'glm-4.5-air', 'GLM-4.5 Air', 'glm', 128000, 1, 0, 30, 14400, 'local'),
  -- GitHub Models
  ('github:gpt-4o', 'github', 'gpt-4o', 'GPT-4o', 'gpt-4o', 128000, 1, 1, 10, 500, 'local'),
  ('github:gpt-4o-mini', 'github', 'gpt-4o-mini', 'GPT-4o mini', 'gpt-4o', 128000, 1, 1, 10, 500, 'local'),
  ('github:o1-preview', 'github', 'o1-preview', 'o1 preview', 'o1', 128000, 1, 0, 5, 200, 'local'),
  ('github:o1-mini', 'github', 'o1-mini', 'o1 mini', 'o1', 128000, 1, 0, 5, 200, 'local'),
  ('github:Phi-3.5-mini-instruct', 'github', 'Phi-3.5-mini-instruct', 'Phi-3.5 mini', 'phi', 128000, 0, 0, 10, 500, 'local'),
  -- NVIDIA NIM
  ('nvidia:meta/llama-3.1-70b-instruct', 'nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NVIDIA)', 'llama', 128000, 1, 0, 30, 14400, 'local'),
  ('nvidia:meta/llama-3.1-8b-instruct', 'nvidia', 'meta/llama-3.1-8b-instruct', 'Llama 3.1 8B (NVIDIA)', 'llama', 128000, 1, 0, 30, 14400, 'local'),
  ('nvidia:nvidia/llama-3.3-nemotron-super-49b-v1', 'nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'Nemotron Super 49B', 'nemotron', 128000, 1, 0, 30, 14400, 'local'),
  ('nvidia:mistralai/mistral-large-2-instruct', 'nvidia', 'mistralai/mistral-large-2-instruct', 'Mistral Large 2', 'mistral', 128000, 1, 0, 30, 14400, 'local');
