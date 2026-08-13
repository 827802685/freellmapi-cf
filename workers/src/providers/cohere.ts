/**
 * Cohere 适配器
 * 旧版 Cohere 有自己的格式,新版 v2 是 OpenAI 兼容
 * 用 v2
 */

import { GroqProvider } from './groq';

export class CohereProvider extends GroqProvider {
  readonly name = 'cohere';
  readonly baseUrl = 'https://api.cohere.com/v2';
}
