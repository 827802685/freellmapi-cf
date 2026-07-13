/**
 * HuggingFace Inference Router 适配器
 * 文档: https://huggingface.co/docs/inference-providers
 * 实际是 OpenAI 兼容
 */

import { GroqProvider } from './groq';

export class HuggingfaceProvider extends GroqProvider {
  readonly name = 'huggingface';
  readonly baseUrl = 'https://router.huggingface.co/v1';
}
