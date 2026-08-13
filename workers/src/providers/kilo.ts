/**
 * Kilo Gateway 适配器 (OpenAI 兼容)
 * 文档: https://kilo.ai/
 */

import { GroqProvider } from './groq';

export class KiloProvider extends GroqProvider {
  readonly name = 'kilo';
  readonly baseUrl = 'https://api.kilo.ai/v1';
}
