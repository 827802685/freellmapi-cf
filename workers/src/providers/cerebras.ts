/**
 * Cerebras 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class CerebrasProvider extends GroqProvider {
  readonly name = 'cerebras';
  readonly baseUrl = 'https://api.cerebras.ai/v1';
}
