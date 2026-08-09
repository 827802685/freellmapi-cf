// ============================================================
// FreeLLM API - Provider Configuration
// ============================================================

import type { ProviderConfig } from '../types';

export const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1',
      'o1-mini',
      'o3-mini',
    ],
    defaultModel: 'gpt-4o-mini',
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ],
    defaultModel: 'claude-3-5-sonnet-20241022',
  },
  google: {
    name: 'google',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_API_KEY',
    models: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
    ],
    defaultModel: 'gemini-2.0-flash',
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    defaultModel: 'deepseek-chat',
  },
  groq: {
    name: 'groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  togetherai: {
    name: 'togetherai',
    displayName: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHERAI_API_KEY',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
    ],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [], // OpenRouter supports all models dynamically
    defaultModel: 'openai/gpt-4o-mini',
  },
};

export function getProviderForModel(modelId: string): string | null {
  for (const [provider, config] of Object.entries(PROVIDERS)) {
    if (config.models.includes(modelId)) {
      return provider;
    }
    // Check for prefix matching (e.g., "openai/gpt-4o" -> openai)
    if (modelId.startsWith(`${provider}/`)) {
      return provider;
    }
  }
  // Check for provider/model format
  for (const provider of Object.keys(PROVIDERS)) {
    if (modelId.startsWith(`${provider}/`)) {
      return provider;
    }
  }
  // Try OpenRouter as fallback for unknown models
  return 'openrouter';
}

export function getProviderConfig(provider: string): ProviderConfig | undefined {
  return PROVIDERS[provider];
}

export function getAllProviders(): ProviderConfig[] {
  return Object.values(PROVIDERS);
}

export function getModelProviderMapping(): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [provider, config] of Object.entries(PROVIDERS)) {
    for (const model of config.models) {
      mapping[model] = provider;
    }
  }
  return mapping;
}