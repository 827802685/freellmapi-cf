/**
 * Mistral 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class MistralProvider extends GroqProvider {
  readonly name = 'mistral';
  readonly baseUrl = 'https://api.mistral.ai/v1';
}
