/**
 * OpenCode Zen 适配器 (OpenAI 兼容)
 */

import { GroqProvider } from './groq';

export class OpencodeProvider extends GroqProvider {
  readonly name = 'opencode';
  readonly baseUrl = 'https://opencode.ai/zen/v1';
}
