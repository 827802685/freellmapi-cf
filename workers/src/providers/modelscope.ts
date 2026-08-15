/**
 * ModelScope (魔搭) 适配器 (OpenAI 兼容)
 * 端点: https://api-inference.modelscope.cn/v1
 */

import { GroqProvider } from './groq';

export class ModelscopeProvider extends GroqProvider {
  readonly name = 'modelscope';
  readonly baseUrl = 'https://api-inference.modelscope.cn/v1';
}
