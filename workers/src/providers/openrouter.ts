/**
 * OpenRouter 适配器 (OpenAI 兼容,base_url 不同)
 */

import { GroqProvider } from './groq';

export class OpenrouterProvider extends GroqProvider {
  readonly name = 'openrouter';
  readonly baseUrl = 'https://openrouter.ai/api/v1';
}
