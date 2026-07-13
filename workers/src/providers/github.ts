/**
 * GitHub Models 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class GithubProvider extends GroqProvider {
  readonly name = 'github';
  readonly baseUrl = 'https://models.inference.ai.azure.com';
}
