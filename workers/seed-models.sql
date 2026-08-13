-- 默认模型目录(本地 fallback,远程同步失败时用)
-- 简化:通过 wrangler d1 execute 批量执行 seed
-- 实际部署时,首次运行会自动从 freellmapi.co/catalog.json 同步
-- 这里是一些常用模型的本地初始数据

INSERT OR IGNORE INTO models (id, platform, model_name, display_name, family, context_window, supports_tools, supports_vision, free_tier_rpm, free_tier_rpd, source) VALUES
  -- Groq
  ('groq:llama-3.3-70b-versatile', 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', 'llama', 128000, 1, 0, 30, 14400, 'local'),
  ('groq:llama-3.1-8b-instant', 'groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 'llama', 128000, 0, 0, 30, 14400, 'local'),
  ('groq:openai/gpt-oss-120b', 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B', 'gpt-oss', 128000, 1, 0, 30, 14400, 'local'),
  -- Google Gemini (2026-07 更新)
  ('google:gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 'gemini-flash', 1000000, 1, 1, 15, 1500, 'local'),
  ('google:gemini-3.5-flash', 'google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 'gemini-flash', 1000000, 1, 1, 15, 1500, 'local'),
  ('google:gemini-3.5-flash-lite', 'google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'gemini-flash', 1000000, 1, 0, 15, 1500, 'local'),
  ('google:gemini-3.1-flash-lite', 'google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'gemini-flash', 1000000, 1, 0, 15, 1500, 'local'),
  ('google:gemini-2.5-flash', 'google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'gemini-flash', 1000000, 1, 1, 15, 1500, 'local'),
  ('google:gemini-2.5-flash-lite', 'google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'gemini-flash', 1000000, 1, 0, 15, 1500, 'local'),
  ('google:gemini-2.5-pro', 'google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'gemini-pro', 1000000, 1, 1, 5, 100, 'local'),
  ('google:gemini-3.1-pro-preview', 'google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro (Preview)', 'gemini-pro', 1000000, 1, 1, 5, 100, 'local'),
  ('google:gemini-3-flash-preview', 'google', 'gemini-3-flash-preview', 'Gemini 3 Flash (Preview)', 'gemini-flash', 1000000, 1, 1, 15, 1500, 'local'),
  -- Cerebras
  ('cerebras:qwen-3-235b-a07b-instruct', 'cerebras', 'qwen-3-235b-a07b-instruct', 'Qwen3 235B Instruct', 'qwen', 128000, 1, 0, 30, 14400, 'local'),
  -- Mistral
  ('mistral:mistral-large-2407', 'mistral', 'mistral-large-2407', 'Mistral Large 3', 'mistral-large', 128000, 1, 0, 30, 14400, 'local'),
  ('mistral:codestral-2405', 'mistral', 'codestral-2405', 'Codestral', 'mistral-code', 32000, 0, 0, 30, 14400, 'local'),
  -- OpenRouter
  ('openrouter:qwen/qwen-2.5-72b-instruct:free', 'openrouter', 'qwen/qwen-2.5-72b-instruct:free', 'Qwen 2.5 72B (free)', 'qwen', 32000, 1, 0, 20, 200, 'local'),
  -- Cloudflare Workers AI (2026-07 更新)
  ('cloudflare:@cf/moonshotai/kimi-k2.6', 'cloudflare', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6 (CF)', 'kimi', 262144, 1, 1, 100, 10000, 'local'),
  ('cloudflare:@cf/zai/glm-4.7-flash', 'cloudflare', '@cf/zai/glm-4.7-flash', 'GLM-4.7 Flash (CF)', 'glm', 131072, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/openai/gpt-oss-120b', 'cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 'gpt-oss', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/openai/gpt-oss-20b', 'cloudflare', '@cf/openai/gpt-oss-20b', 'GPT-OSS 20B (CF)', 'gpt-oss', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/meta/llama-4-scout-17b-16e-instruct', 'cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)', 'llama', 128000, 1, 1, 100, 10000, 'local'),
  ('cloudflare:@cf/google/gemma-4-26b-a4b-it', 'cloudflare', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B (CF)', 'gemma', 128000, 1, 1, 100, 10000, 'local'),
  ('cloudflare:@cf/nvidia/nemotron-3-120b-a12b', 'cloudflare', '@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 Super 120B (CF)', 'nemotron', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B Fast (CF)', 'llama', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/qwen/qwen3-30b-a3b-fp8', 'cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B MoE (CF)', 'qwen', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/qwen/qwq-32b', 'cloudflare', '@cf/qwen/qwq-32b', 'QwQ 32B (CF)', 'qwen', 128000, 0, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/qwen/qwen2.5-coder-32b-instruct', 'cloudflare', '@cf/qwen/qwen2.5-coder-32b-instruct', 'Qwen 2.5 Coder 32B (CF)', 'qwen', 128000, 0, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/mistralai/mistral-small-3.1-24b-instruct', 'cloudflare', '@cf/mistralai/mistral-small-3.1-24b-instruct', 'Mistral Small 3.1 (CF)', 'mistral', 128000, 1, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill 32B (CF)', 'deepseek', 128000, 0, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/meta/llama-3.2-11b-vision-instruct', 'cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision (CF)', 'llama', 128000, 0, 1, 100, 10000, 'local'),
  ('cloudflare:@cf/meta/llama-3.2-3b-instruct', 'cloudflare', '@cf/meta/llama-3.2-3b-instruct', 'Llama 3.2 3B (CF)', 'llama', 128000, 0, 0, 100, 10000, 'local'),
  ('cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8', 'cloudflare', '@cf/meta/llama-3.1-8b-instruct-fp8', 'Llama 3.1 8B FP8 (CF)', 'llama', 128000, 0, 0, 100, 10000, 'local'),
  -- Pollinations (gen.pollinations.ai - 2026 新版)
  ('pollinations:openai', 'pollinations', 'openai', 'OpenAI GPT-4o', 'openai', 128000, 1, 1, NULL, NULL, 'local'),
  ('pollinations:openai-fast', 'pollinations', 'openai-fast', 'OpenAI Fast', 'openai', 16000, 0, 0, NULL, NULL, 'local'),
  ('pollinations:deepseek', 'pollinations', 'deepseek', 'DeepSeek', 'deepseek', 128000, 1, 0, NULL, NULL, 'local'),
  ('pollinations:deepseek-r1', 'pollinations', 'deepseek-r1', 'DeepSeek R1', 'deepseek', 128000, 0, 0, NULL, NULL, 'local'),
  ('pollinations:claude', 'pollinations', 'claude', 'Claude', 'claude', 200000, 1, 1, NULL, NULL, 'local'),
  ('pollinations:mistral', 'pollinations', 'mistral', 'Mistral', 'mistral', 128000, 1, 0, NULL, NULL, 'local'),
  ('pollinations:gemini', 'pollinations', 'gemini', 'Gemini', 'gemini', 128000, 1, 1, NULL, NULL, 'local'),
  ('pollinations:qwen-coder', 'pollinations', 'qwen-coder', 'Qwen Coder', 'qwen', 128000, 0, 0, NULL, NULL, 'local'),
  -- Z.AI / 智普 GLM
  ('zai:glm-4.6', 'zai', 'glm-4.6', 'GLM-4.6', 'glm', 200000, 1, 0, 30, 14400, 'local'),
  ('zai:glm-4.5', 'zai', 'glm-4.5', 'GLM-4.5', 'glm', 128000, 1, 0, 30, 14400, 'local'),
  ('zai:glm-4.5-air', 'zai', 'glm-4.5-air', 'GLM-4.5 Air', 'glm', 128000, 1, 0, 30, 14400, 'local'),
  -- GitHub Models (已停用 - 2026-07-30 全面退役)
  -- ('github:gpt-4o', 'github', 'gpt-4o', 'GPT-4o', 'gpt-4o', 128000, 1, 1, 10, 500, 'local'),
  -- ('github:gpt-4o-mini', 'github', 'gpt-4o-mini', 'GPT-4o mini', 'gpt-4o', 128000, 1, 1, 10, 500, 'local'),
  -- ('github:o1-preview', 'github', 'o1-preview', 'o1 preview', 'o1', 128000, 1, 0, 5, 200, 'local'),
  -- ('github:o1-mini', 'github', 'o1-mini', 'o1 mini', 'o1', 128000, 1, 0, 5, 200, 'local'),
  -- ('github:Phi-3.5-mini-instruct', 'github', 'Phi-3.5-mini-instruct', 'Phi-3.5 mini', 'phi', 128000, 0, 0, 10, 500, 'local'),
  -- NVIDIA NIM (2026-07 更新)
  ('nvidia:nvidia/nemotron-3-ultra-550b-a55b', 'nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra 550B', 'nemotron', 1000000, 1, 0, 40, 5000, 'local'),
  ('nvidia:nvidia/nemotron-3-120b-a12b', 'nvidia', 'nvidia/nemotron-3-120b-a12b', 'Nemotron 3 Super 120B', 'nemotron', 128000, 1, 0, 40, 5000, 'local'),
  ('nvidia:nvidia/nemotron-3-nano-30b-a3b', 'nvidia', 'nvidia/nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B', 'nemotron', 1000000, 1, 0, 40, 5000, 'local'),
  ('nvidia:deepseek-ai/deepseek-v4-flash', 'nvidia', 'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', 1000000, 1, 0, 40, 5000, 'local'),
  ('nvidia:deepseek-ai/deepseek-v4-pro', 'nvidia', 'deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek', 1000000, 1, 0, 40, 5000, 'local'),
  ('nvidia:moonshotai/kimi-k2.6', 'nvidia', 'moonshotai/kimi-k2.6', 'Kimi K2.6', 'kimi', 256000, 1, 1, 40, 5000, 'local'),
  ('nvidia:z-ai/glm-5.2', 'nvidia', 'z-ai/glm-5.2', 'GLM-5.2', 'glm', 128000, 1, 0, 40, 5000, 'local'),
  ('nvidia:mistralai/mistral-medium-3.5-128b', 'nvidia', 'mistralai/mistral-medium-3.5-128b', 'Mistral Medium 3.5 128B', 'mistral', 128000, 1, 0, 40, 5000, 'local'),
  ('nvidia:qwen/qwen3-next-80b-a3b-instruct', 'nvidia', 'qwen/qwen3-next-80b-a3b-instruct', 'Qwen3 Next 80B', 'qwen', 128000, 1, 0, 40, 5000, 'local');
