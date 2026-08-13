/**
 * 提示压缩
 *
 * 在发送给上游之前,对 Chat 请求的消息进行压缩,减少 token 消耗。
 * 这适用于 free-tier API 有 token 限制的场景。
 *
 * 压缩模式:
 * 1. lossless: 仅移除冗余空白、重复消息、系统提示中的非必要内容
 * 2. standard: 中等压缩 — 缩短消息前缀、合并连续短消息
 * 3. aggressive: 激进压缩 — 截断长消息、移除低价值内容
 *
 * 通过 X-Compression 请求头控制: "lossless" | "standard" | "aggressive"
 * 默认不压缩。
 */

import type { ChatMessage, ChatContentPart, ChatCompletionRequest } from '../types';

export type CompressionMode = 'lossless' | 'standard' | 'aggressive';

// 可压缩的系统提示关键词(匹配到这些关键词的消息可以压缩)
const COMPRESSIBLE_SYSTEM_KEYWORDS = [
  'you are', 'you\'re', 'you are a', 'act as', 'role',
  'please', 'thank you', 'you should', 'you must',
  'respond', 'answer', 'reply', 'always',
];

// 低价值内容模式(aggressive 模式会移除)
const LOW_VALUE_PATTERNS = [
  /\b(?:ok|okay|sure|alright|got it|understood|i understand|i see)\b/gi,
  /\b(?:let me know|feel free to|don\'t hesitate|please feel free)\b/gi,
  /\b(?:as an AI|as a language model|as an AI assistant)\b/gi,
  /\b(?:I\'m sorry, but|I\'m sorry, I cannot|I apologize, but)\b/gi,
  /\b(?:in conclusion|to summarize|in summary|overall,|generally,)\b/gi,
];

// 过长的思考/推理前缀(aggressive 模式会移除)
const THINKING_PREFIXES = [
  /^<thinking>[\s\S]*?<\/thinking>/g,
  /^\[thinking\][\s\S]*?\[\/thinking\]/g,
  /^---[\s\S]*?---\n/g,
];

/**
 * 检测请求头中的压缩模式
 */
export function getCompressionMode(headers: Headers): CompressionMode | null {
  const mode = headers.get('X-Compression');
  if (mode === 'lossless' || mode === 'standard' || mode === 'aggressive') {
    return mode;
  }
  return null;
}

/**
 * 压缩请求消息
 */
export function compressRequest(req: ChatCompletionRequest, mode: CompressionMode): ChatCompletionRequest {
  const messages = req.messages.map(msg => compressMessage(msg, mode));

  // standard/aggressive 模式下:合并连续同角色的短消息
  let merged = mergeConsecutiveMessages(messages, mode);

  return { ...req, messages: merged };
}

/**
 * 压缩单条消息
 */
function compressMessage(msg: ChatMessage, mode: CompressionMode): ChatMessage {
  if (msg.content === null || msg.content === undefined) return msg;

  if (typeof msg.content === 'string') {
    let content = msg.content;

    // 所有模式都做的基础压缩
    content = content.trim();
    // 压缩连续空白
    content = content.replace(/\s+/g, ' ');
    // 删除多余的空行
    content = content.replace(/\n{3,}/g, '\n\n');

    if (mode === 'lossless') {
      // lossless: 只做基础压缩
      return { ...msg, content };
    }

    // system 消息:移除冗余的引导语
    if (msg.role === 'system') {
      content = compressSystemPrompt(content, mode);
    }

    if (mode === 'standard') {
      // standard: 缩短过长的前缀/后缀
      content = compressStandard(content);
      return { ...msg, content };
    }

    if (mode === 'aggressive') {
      // aggressive: 激进压缩
      content = compressAggressive(content);
      return { ...msg, content };
    }

    return { ...msg, content };
  }

  // 数组内容(含图片)
  if (Array.isArray(msg.content)) {
    const parts = msg.content.map(part => {
      if (part.type === 'text' && part.text) {
        let text = part.text.trim();
        text = text.replace(/\s+/g, ' ');
        if (mode === 'aggressive') {
          text = compressAggressive(text);
        } else if (mode === 'standard') {
          text = compressStandard(text);
        }
        return { ...part, text };
      }
      return part;
    });
    return { ...msg, content: parts };
  }

  return msg;
}

/**
 * 压缩系统提示
 */
function compressSystemPrompt(content: string, mode: CompressionMode): string {
  if (mode === 'aggressive') {
    // 激进:移除所有礼貌性语句和冗余指令
    for (const pattern of LOW_VALUE_PATTERNS) {
      content = content.replace(pattern, '');
    }
    // 移除 thinking 块
    for (const pattern of THINKING_PREFIXES) {
      content = content.replace(pattern, '');
    }
    // 压缩连续空白
    content = content.replace(/\s+/g, ' ').trim();
  }

  if (mode === 'standard') {
    // 标准:只移除明显的冗余
    content = content.replace(/^you are an? /i, '');
    content = content.replace(/^you're an? /i, '');
    content = content.trim();
  }

  return content;
}

/**
 * 标准模式压缩
 */
function compressStandard(content: string): string {
  // 移除过长的水平线
  content = content.replace(/-{30,}/g, '---');
  content = content.replace(/={30,}/g, '===');

  // 缩短过长的代码块(超过 200 行)
  content = content.replace(/```[\s\S]*?```/g, (match) => {
    const lines = match.split('\n');
    if (lines.length > 50) {
      const lang = lines[0].replace('```', '').trim();
      return `\`\`\`${lang}\n[code block truncated: ${lines.length - 2} lines]\n\`\`\``;
    }
    return match;
  });

  return content;
}

/**
 * 激进模式压缩
 */
function compressAggressive(content: string): string {
  // 先做标准压缩
  content = compressStandard(content);

  // 移除低价值内容
  for (const pattern of LOW_VALUE_PATTERNS) {
    content = content.replace(pattern, '');
  }

  // 移除 thinking 块
  for (const pattern of THINKING_PREFIXES) {
    content = content.replace(pattern, '');
  }

  // 缩短过长的段落(超过 500 字符)
  const paragraphs = content.split('\n');
  content = paragraphs.map(p => {
    if (p.length > 500) {
      return p.slice(0, 250) + '\n[...truncated...]\n' + p.slice(-250);
    }
    return p;
  }).join('\n');

  // 移除连续重复的行
  const lines = content.split('\n');
  const deduped: string[] = [];
  let prevLine = '';
  for (const line of lines) {
    if (line.trim() !== prevLine.trim()) {
      deduped.push(line);
      prevLine = line;
    }
  }
  content = deduped.join('\n');

  // 压缩连续空白
  content = content.replace(/\s+/g, ' ').trim();

  return content;
}

/**
 * 合并连续同角色的短消息
 */
function mergeConsecutiveMessages(messages: ChatMessage[], mode: CompressionMode): ChatMessage[] {
  if (mode === 'lossless') return messages; // lossless 不合并

  const merged: ChatMessage[] = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];

    // 如果是 tool 消息,不合并
    if (msg.role === 'tool') {
      merged.push(msg);
      continue;
    }

    // 如果上一条消息角色相同且都是纯文本,合并
    if (last && last.role === msg.role &&
        typeof last.content === 'string' && typeof msg.content === 'string') {

      // 只合并短消息(各不超过 200 字符)
      if (last.content.length < 200 && msg.content.length < 200) {
        last.content = last.content + '\n' + msg.content;
        continue;
      }

      // aggressive 模式:合并所有同角色消息
      if (mode === 'aggressive') {
        last.content = last.content + '\n' + msg.content;
        continue;
      }
    }

    merged.push(msg);
  }

  return merged;
}