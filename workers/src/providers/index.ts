/**
 * 供应商注册表
 */

import type { Platform } from '../types';
import { BaseProvider } from './base';
import { GroqProvider } from './groq';
import { GoogleProvider } from './google';
import { CerebrasProvider } from './cerebras';
import { MistralProvider } from './mistral';
import { CohereProvider } from './cohere';
import { OpenrouterProvider } from './openrouter';
import { GithubProvider } from './github';
import { CloudflareProvider } from './cloudflare';
import { ZaiProvider } from './zai';
import { NvidiaProvider } from './nvidia';
import { HuggingfaceProvider } from './huggingface';
import { OllamaProvider } from './ollama';
import { PollinationsProvider } from './pollinations';
import { Llm7Provider } from './llm7';
import { OvhProvider } from './ovh';
import { AihordeProvider } from './aihorde';
import { OpencodeProvider } from './opencode';
import { KiloProvider } from './kilo';

export function getProvider(platform: Platform, customBaseUrl?: string): BaseProvider {
  switch (platform) {
    case 'groq': return new GroqProvider();
    case 'google': return new GoogleProvider();
    case 'cerebras': return new CerebrasProvider();
    case 'mistral': return new MistralProvider();
    case 'cohere': return new CohereProvider();
    case 'openrouter': return new OpenrouterProvider();
    case 'github': return new GithubProvider();
    case 'cloudflare': return new CloudflareProvider();
    case 'zai': return new ZaiProvider();
    case 'nvidia': return new NvidiaProvider();
    case 'huggingface': return new HuggingfaceProvider();
    case 'ollama': return new OllamaProvider();
    case 'pollinations': return new PollinationsProvider();
    case 'llm7': return new Llm7Provider();
    case 'ovh': return new OvhProvider();
    case 'aihorde': return new AihordeProvider();
    case 'opencode': return new OpencodeProvider();
    case 'kilo': return new KiloProvider();
    case 'custom':
      if (!customBaseUrl) throw new Error('Custom provider requires baseUrl');
      return new (require('./custom').CustomProvider)(customBaseUrl);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export const ALL_PLATFORMS: Platform[] = [
  'groq', 'google', 'cerebras', 'opencode',
  'mistral', 'openrouter', 'github', 'cloudflare',
  'cohere', 'zai', 'nvidia', 'huggingface',
  'ollama', 'kilo', 'pollinations', 'llm7',
  'ovh', 'aihorde', 'custom',
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  groq: 'Groq',
  google: 'Google Gemini',
  cerebras: 'Cerebras',
  opencode: 'OpenCode Zen',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  github: 'GitHub Models',
  cloudflare: 'Cloudflare Workers AI',
  cohere: 'Cohere',
  zai: 'Z.ai (智谱)',
  nvidia: 'NVIDIA NIM',
  huggingface: 'HuggingFace',
  ollama: 'Ollama Cloud',
  kilo: 'Kilo Gateway',
  pollinations: 'Pollinations',
  llm7: 'LLM7',
  ovh: 'OVH AI Endpoints',
  aihorde: 'AI Horde',
  custom: 'Custom',
};
