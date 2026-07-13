/**
 * Z.ai (智谱) 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class ZaiProvider extends GroqProvider {
  readonly name = 'zai';
  readonly baseUrl = 'https://api.z.ai/api/paas/v4';
}
