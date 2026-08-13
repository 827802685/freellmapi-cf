/**
 * Ollama Cloud 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class OllamaProvider extends GroqProvider {
  readonly name = 'ollama';
  readonly baseUrl = 'https://ollama.com/v1';
}
