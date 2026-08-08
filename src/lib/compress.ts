// Prompt compression utilities

import type { ChatMessage } from '../types';

interface CompressionResult {
  messages: ChatMessage[];
  tokensSaved: number;
}

export function compressMessages(messages: ChatMessage[]): CompressionResult {
  let originalLength = estimateTokens(messages);
  let compressed = [...messages];

  // 1. Deduplicate consecutive system messages
  compressed = deduplicateSystemMessages(compressed);

  // 2. Filter out redundant tool output
  compressed = compactToolOutput(compressed);

  // 3. Trim stale context (keep last N messages)
  compressed = trimStaleContext(compressed, 50);

  // 4. Compact repeated JSON in tool calls
  compressed = compactJsonInTools(compressed);

  let compressedLength = estimateTokens(compressed);
  return {
    messages: compressed,
    tokensSaved: originalLength - compressedLength,
  };
}

function deduplicateSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.filter(msg => {
    if (msg.role === 'system') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (seen.has(content)) return false;
      seen.add(content);
    }
    return true;
  });
}

function compactToolOutput(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 500) {
      // Truncate very long tool output
      return { ...msg, content: msg.content.slice(0, 500) + '\n... [truncated]' };
    }
    return msg;
  });
}

function trimStaleContext(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  // Always keep system messages, trim oldest user/assistant messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const trimmed = nonSystem.slice(-(maxMessages - systemMessages.length));
  return [...systemMessages, ...trimmed];
}

function compactJsonInTools(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      return {
        ...msg,
        tool_calls: msg.tool_calls.map(tc => {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            // Compact JSON by removing whitespace
            return { ...tc, function: { ...tc.function, arguments: JSON.stringify(parsed) } };
          } catch {
            return tc;
          }
        }),
      };
    }
    return msg;
  });
}

function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          total += Math.ceil(part.text.length / 4);
        } else if (part.type === 'image_url') {
          total += 100; // estimate for image tokens
        }
      }
    }
    if (msg.tool_calls) {
      total += msg.tool_calls.length * 20;
    }
  }
  return total;
}