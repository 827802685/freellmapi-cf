/**
 * LLM7 适配器
 * 匿名可用
 */

import { PollinationsProvider } from './pollinations';

export class Llm7Provider extends PollinationsProvider {
  readonly name = 'llm7';
  readonly baseUrl = 'https://api.llm7.io/v1';
}
