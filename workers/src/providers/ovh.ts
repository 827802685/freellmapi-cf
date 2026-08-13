/**
 * OVH AI Endpoints 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class OvhProvider extends GroqProvider {
  readonly name = 'ovh';
  readonly baseUrl = 'https://endpoints.ai.cloud.ovh.net/v1';
}
