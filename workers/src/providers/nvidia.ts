/**
 * NVIDIA NIM 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class NvidiaProvider extends GroqProvider {
  readonly name = 'nvidia';
  readonly baseUrl = 'https://integrate.api.nvidia.com/v1';
}
