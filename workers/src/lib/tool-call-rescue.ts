/**
 * Tool-call rescue
 *
 * 某些模型(如 Gemini、DeepSeek 等)在 tool-calling 场景下可能返回
 * 纯文本格式的工具调用(如 JSON 块),而非标准 OpenAI 格式的 tool_calls。
 *
 * 本模块检测非结构化文本中的工具调用模式,将其转换为结构化 tool_calls,
 * 使得依赖 OpenAI 格式的客户端(如 TRAE IDE、Continue.dev) 能正常工作。
 *
 * 支持的格式:
 * 1. ```json { "name": "xxx", "arguments": {...} } ```
 * 2. {"function": "xxx", "params": {...}}
 * 3. {"name": "xxx", "parameters": {...}}
 * 4. 含 "function" 或 "tool_call" 关键词的 JSON 块
 */

import type { ToolCall } from '../types';

const TOOL_CALL_PATTERNS = [
  // 1. 标准 JSON 格式: {"name":"xxx","arguments":{...}}
  /```(?:json)?\s*(\{[\s\S]*?"(?:name|function)"[\s\S]*?\})\s*```/g,
  // 2. 内联 JSON: {"function":"xxx","params":{...}}
  /\{[\s\S]*?"(?:function|name|tool_call)"[\s\S]*?"(?:arguments|params|parameters|arguments)"[\s\S]*?\}/g,
  // 3. XML 风格: <tool_call><name>xxx</name><arguments>...</arguments></tool_call>
  /<tool_call>[\s\S]*?<\/tool_call>/g,
];

const JSON_TOOL_PATTERN = /\{[\s\S]*?"(?:name|function|tool_call)"[\s\S]*?(?:arguments|params|parameters|arguments)"[\s\S]*?\}/;

/**
 * 检测文本中是否包含工具调用模式
 */
export function containsToolCall(text: string): boolean {
  if (!text) return false;
  for (const pattern of TOOL_CALL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  // 快速关键词检测
  const lower = text.toLowerCase();
  if (lower.includes('tool_call') || lower.includes('function_call')) return true;
  return false;
}

/**
 * 从文本中提取工具调用,返回结构化 ToolCall 数组
 */
export function extractToolCalls(text: string): ToolCall[] {
  if (!text) return [];

  const calls: ToolCall[] = [];

  // 尝试所有正则模式
  for (const pattern of TOOL_CALL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // 如果是 XML 风格,需要特殊处理
      if (match[0].startsWith('<tool_call>')) {
        const xmlCall = parseXmlToolCall(match[0]);
        if (xmlCall) calls.push(xmlCall);
        continue;
      }
      // JSON 风格
      try {
        const parsed = JSON.parse(match[1] || match[0]);
        const call = normalizeToolCallJson(parsed);
        if (call) calls.push(call);
      } catch {
        // JSON 解析失败,尝试修复
        try {
          const fixed = fixJson(match[1] || match[0]);
          if (fixed) {
            const parsed = JSON.parse(fixed);
            const call = normalizeToolCallJson(parsed);
            if (call) calls.push(call);
          }
        } catch {
          // 跳过无法解析的
        }
      }
    }
  }

  // 如果没有匹配到正则,尝试直接解析整段文本中的 JSON
  if (calls.length === 0) {
    const jsonCall = extractInlineJsonToolCall(text);
    if (jsonCall) calls.push(jsonCall);
  }

  return calls;
}

/**
 * 在文本中查找内联 JSON 工具调用
 */
function extractInlineJsonToolCall(text: string): ToolCall | null {
  JSON_TOOL_PATTERN.lastIndex = 0;
  const match = JSON_TOOL_PATTERN.exec(text);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    return normalizeToolCallJson(parsed);
  } catch {
    try {
      const fixed = fixJson(match[0]);
      if (fixed) {
        const parsed = JSON.parse(fixed);
        return normalizeToolCallJson(parsed);
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 归一化 JSON 工具调用为标准 ToolCall 格式
 */
function normalizeToolCallJson(json: Record<string, unknown>): ToolCall | null {
  if (!json) return null;

  let name = '';
  let args = '';

  // 多种字段名兼容
  if (typeof json.name === 'string') {
    name = json.name;
  } else if (typeof json.function === 'string') {
    name = json.function;
  } else if (typeof json.function_name === 'string') {
    name = json.function_name;
  } else if (typeof json.tool_name === 'string') {
    name = json.tool_name;
  } else if (typeof json.tool_call === 'string') {
    name = json.tool_call;
  } else if (json.function && typeof json.function === 'object') {
    const fn = json.function as Record<string, unknown>;
    name = typeof fn.name === 'string' ? fn.name : '';
    args = typeof fn.arguments === 'string' ? fn.arguments :
           fn.arguments ? JSON.stringify(fn.arguments) : '';
  }

  if (typeof json.arguments === 'string') {
    args = json.arguments;
  } else if (json.arguments && typeof json.arguments === 'object') {
    args = JSON.stringify(json.arguments);
  } else if (typeof json.params === 'string') {
    args = json.params;
  } else if (json.params && typeof json.params === 'object') {
    args = JSON.stringify(json.params);
  } else if (typeof json.parameters === 'string') {
    args = json.parameters;
  } else if (json.parameters && typeof json.parameters === 'object') {
    args = JSON.stringify(json.parameters);
  } else if (typeof json.arguments === 'string') {
    args = json.arguments;
  }

  // 如果没有明确的名字,尝试从 tools 配置推断
  if (!name || !args) {
    // 如果函数名是"search"这种,但 json 里可能用"query"字段
    if (json.query && typeof json.query === 'string') {
      name = 'search';
      args = JSON.stringify({ query: json.query });
    }
  }

  if (!name) return null;

  return {
    id: `call_rescued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

/**
 * 解析 XML 风格的工具调用
 * <tool_call><name>xxx</name><arguments>...</arguments></tool_call>
 */
function parseXmlToolCall(xml: string): ToolCall | null {
  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(xml);
  const argsMatch = /<arguments>([\s\S]*?)<\/arguments>/.exec(xml) ||
                    /<params>([\s\S]*?)<\/params>/.exec(xml) ||
                    /<parameters>([\s\S]*?)<\/parameters>/.exec(xml);

  const name = nameMatch?.[1]?.trim();
  let args = argsMatch?.[1]?.trim() || '{}';

  // 如果 arguments 本身是 JSON,尝试格式化为字符串
  try {
    const parsed = JSON.parse(args);
    args = JSON.stringify(parsed);
  } catch {
    // 保留原样
  }

  if (!name) return null;

  return {
    id: `call_rescued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

/**
 * 尝试修复不完整的 JSON(修复单引号、无引号 key、多余逗号等)
 */
function fixJson(str: string): string | null {
  if (!str) return null;
  let s = str.trim();

  // 移除 markdown 代码块标记(如果正则没匹配到)
  s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');

  // 替换单引号为双引号
  s = s.replace(/'/g, '"');

  // 修复无引号的 key (如 {name: "xxx"} → {"name": "xxx"})
  s = s.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

  // 移除多余逗号
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // 验证是否为有效 JSON
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/**
 * 在响应返回给客户端之前,检查是否需要对消息进行 tool-call rescue
 *
 * 如果模型返回了文本形式的工具调用(而非结构化 tool_calls),
 * 此函数会从文本中提取并转换为结构化 tool_calls,同时清空文本内容。
 *
 * @param message 原始消息对象
 * @param tools 请求中的 tools 定义(用于验证和推断)
 * @returns 处理后的消息对象
 */
export function rescueToolCalls(
  message: { content?: string | null; tool_calls?: ToolCall[] },
  tools?: Array<{ type: string; function: { name: string } }>
): { content?: string | null; tool_calls?: ToolCall[] } {
  // 如果已有结构化 tool_calls,不需要 rescue
  if (message.tool_calls && message.tool_calls.length > 0) {
    return message;
  }

  const content = message.content || '';
  if (!content) return message;

  // 检查是否包含工具调用模式
  if (!containsToolCall(content)) {
    return message;
  }

  // 提取工具调用
  const extracted = extractToolCalls(content);

  if (extracted.length === 0) {
    return message;
  }

  // 如果有工具定义,验证提取的调用是否匹配
  if (tools && tools.length > 0) {
    const validNames = new Set(tools.map(t => t.function.name));
    const validCalls = extracted.filter(c => validNames.has(c.function.name));

    // 如果没有匹配的工具,但提取的调用看起来像工具调用,仍然保留
    // 可能是客户端需要的工具调用
    if (validCalls.length > 0) {
      return {
        tool_calls: validCalls,
        content: null,  // 清空文本,因为工具调用已提取
      };
    }

    // 提取的调用都不匹配已知工具,但看起来像工具调用
    // 保留所有提取的调用
    return {
      tool_calls: extracted,
      content: null,
    };
  }

  // 没有工具定义,但仍然提取到了工具调用
  return {
    tool_calls: extracted,
    content: null,
  };
}