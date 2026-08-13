/**
 * 模型元数据启发式检测
 * 基于模型名判断 supports_vision / supports_tools
 * 用于自动发现的模型(catalog 没覆盖的)
 */

/**
 * 基于模型名启发式检测是否支持 vision(图片输入)
 */
export function detectVisionSupport(modelName: string): number {
  const n = modelName.toLowerCase();
  // 明确包含 vision 关键词
  if (n.includes('vision') || n.includes('vl') || n.includes('-vl') || n.includes('multimodal')) return 1;
  // GPT-4o 系列(含 mini)
  if (n.includes('gpt-4o') || n.includes('gpt-4.1')) return 1;
  // GPT-5 系列
  if (n.includes('gpt-5')) return 1;
  // Claude 3/4/5 系列(opus/sonnet/haiku 都支持 vision)
  if (n.match(/claude-[345]/)) return 1;
  // Gemini 系列(flash/pro/flash-lite 都支持 vision)
  if (n.includes('gemini')) return 1;
  // Llama 4 系列(scout/maverick)
  if (n.includes('llama-4') || n.includes('llama4')) return 1;
  // Llama 3.2 Vision
  if (n.includes('llama-3.2') && n.includes('vision')) return 1;
  // Qwen-VL / Qwen2-VL / Qwen2.5-VL
  if (n.match(/qwen.*-vl/) || n.includes('qwen-vl') || n.includes('qwq')) return 1;
  // Kimi (moonshot)
  if (n.includes('kimi') || n.includes('moonshot')) return 1;
  // GLM-4V / GLM-5
  if (n.includes('glm-4v') || n.includes('glm-5')) return 1;
  // Pixtral
  if (n.includes('pixtral')) return 1;
  return 0;
}

/**
 * 基于模型名启发式检测是否支持 tools(function calling)
 */
export function detectToolSupport(modelName: string): number {
  const n = modelName.toLowerCase();
  // 大多数现代模型支持 tools
  if (n.includes('gpt-4') || n.includes('gpt-5') || n.includes('o1') || n.includes('o3')) return 1;
  if (n.includes('claude-')) return 1;
  if (n.includes('gemini')) return 1;
  if (n.includes('llama-3.3') || n.includes('llama-4')) return 1;
  if (n.includes('qwen') && (n.includes('72b') || n.includes('max') || n.includes('turbo'))) return 1;
  if (n.includes('mistral-large') || n.includes('mixtral')) return 1;
  if (n.includes('command-r')) return 1;
  if (n.includes('glm-4') || n.includes('glm-5')) return 1;
  if (n.includes('kimi') || n.includes('moonshot')) return 1;
  return 0;
}
