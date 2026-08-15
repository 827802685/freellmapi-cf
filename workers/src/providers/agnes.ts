/**
 * AGNES 适配器 (OpenAI 兼容)
 * 端点: https://apihub.agnes-ai.com/v1
 */

import { GroqProvider } from './groq';

export class AgnesProvider extends GroqProvider {
  readonly name = 'agnes';
  readonly baseUrl = 'https://apihub.agnes-ai.com/v1';
}
