/**
 * Z.ai (智谱) 适配器 (OpenAI 兼容)
 * 官方:https://open.bigmodel.cn/  端点:https://open.bigmodel.cn/api/paas/v4
 * 国际版:https://api.z.ai/        端点:https://api.z.ai/api/paas/v4
 * 默认走中国大陆端点(open.bigmodel.cn)
 */

import { GroqProvider } from './groq';

export class ZaiProvider extends GroqProvider {
  readonly name = 'zai';
  readonly baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
}
