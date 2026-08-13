/**
 * SSE 流式响应工具
 *
 * v3 稳定性增强:
 * 1. 首 chunk 探测:peekFirstChunk 读取第一个有效 chunk,空流时返回 null
 * 2. 流式超时:pull 中加入 AbortController,上游 stall 超时自动关闭
 * 3. onError 回调:流异常中断时通知调用方
 * 4. 保留 v2 所有修复(buffer 残留/decoder flush/去重 DONE/NDJSON/delta.text/anthropic type 检测)
 */

export function sseEvent(data: unknown, event?: string): string {
  let s = '';
  if (event) s += `event: ${event}\n`;
  s += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  return s;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * 探测上游流的首个有效 chunk
 *
 * 用于流式 fallback 决策:
 * - 上游 200 但流为空 / 首个 chunk 无内容 → 返回 null → 触发 fallback
 * - 正常有内容 → 返回 { firstChunks, stream } → 用 stream 继续后续读取
 *
 * 最多等待 timeoutMs,超时也返回 null
 */
export async function peekFirstChunk(
  upstream: ReadableStream<Uint8Array>,
  timeoutMs = 15000
): Promise<{ firstChunks: Uint8Array[]; stream: ReadableStream<Uint8Array> } | null> {
  const reader = upstream.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let textBuffer = '';

  // 修复:track timeoutId 以便在返回时清理,避免资源泄漏
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  /** 检测一个已解析的 SSE payload 是否包含有效内容(跨所有 provider 格式) */
  function hasValidContent(data: any): boolean {
    // 1. 标准 OpenAI 格式: choices[0].delta.content / finish_reason
    const choice = data.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      if (delta?.content || delta?.reasoning_content || delta?.text) return true;
      if (choice.finish_reason) return true;
    }
    if (data.finish_reason) return true;

    // 2. Gemini 格式: candidates[0].content.parts[*].text / finishReason
    //    修复: 之前完全没检测 Gemini 格式,导致 peekFirstChunk 吞掉整个流或超时
    if (data.candidates?.[0]) {
      const cand = data.candidates[0];
      const parts = cand.content?.parts || [];
      if (parts.some((p: any) => p.text)) return true;
      if (cand.finishReason) return true;
    }

    // 3. Anthropic 格式: data.type === 'content_block_delta' / 'message_delta' / 'message_stop'
    if (data.type === 'content_block_delta' || data.type === 'message_delta' || data.type === 'message_stop') {
      return true;
    }
    if (data.delta?.text) return true;  // Anthropic content_block_delta

    // 4. Cloudflare AI: data.response
    if (data.response !== undefined && data.response !== '') return true;

    // 5. Ollama: data.message?.content
    if (data.message?.content) return true;

    // 6. Google Interactions API: step.delta 事件包含文本增量
    //    格式: {"index":0, "delta":{"type":"text", "text":"Hello"}}
    if (data.delta?.type === 'text' && data.delta?.text) return true;

    // 7. Google Interactions API: step.start 表示流正常推进中,避免因 thinking 阶段过长而超时
    if (data.step?.type) return true;

    // 8. 通用兜底
    if (data.content || data.text) return true;

    return false;
  }

  try {
    while (true) {
      const readPromise = reader.read();
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result === null) {
        // 超时 — 清理 timer 并返回 null
        if (timeoutId) clearTimeout(timeoutId);
        reader.releaseLock();
        return null;
      }

      const { value, done } = result as ReadableStreamReadResult<Uint8Array>;
      if (done) {
        // 流提前结束 — 如果已收到有效内容则正常,否则空流
        if (textBuffer.trim()) {
          // 有残留但未换行的内容
          break;
        }
        if (timeoutId) clearTimeout(timeoutId);
        reader.releaseLock();
        return chunks.length > 0 ? { firstChunks: chunks, stream: createStreamFromChunks(chunks, upstream) } : null;
      }

      chunks.push(value);
      textBuffer += decoder.decode(value, { stream: true });

      // 检查是否已收到第一个有效 SSE 事件
      const lines = textBuffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let payload: string | null = null;
        if (trimmed.startsWith('data:')) {
          payload = trimmed.slice(5).trim();
        } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          payload = trimmed;
        }
        if (!payload || payload === '[DONE]') continue;

        try {
          const data = JSON.parse(payload);
          if (hasValidContent(data)) {
            // 首个有效 chunk 确认 — 清理 timer,释放 reader 并返回
            if (timeoutId) clearTimeout(timeoutId);
            reader.releaseLock();
            return { firstChunks: chunks, stream: createStreamFromChunks(chunks, upstream) };
          }
        } catch {
          // JSON 解析失败,继续等下一个 chunk
        }
      }

      // 保留最后不完整的一行
      textBuffer = lines[lines.length - 1] || '';
    }

    if (timeoutId) clearTimeout(timeoutId);
    reader.releaseLock();
    return chunks.length > 0 ? { firstChunks: chunks, stream: createStreamFromChunks(chunks, upstream) } : null;
  } catch {
    if (timeoutId) clearTimeout(timeoutId);
    try { reader.releaseLock(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * 把已读的 chunks 和剩余的 upstream 流合并成一个新流
 */
function createStreamFromChunks(chunks: Uint8Array[], upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  // 克隆 chunks 作为流的开头,然后接上 upstream 的剩余部分
  const encoder = new TextEncoder();
  const combined = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 先发送已读的 chunks
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      // 然后从 upstream 继续读取
      const reader = upstream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
  return combined;
}

/**
 * 处理 buffer 中残留的完整行,返回剩余的不完整行
 */
function processBufferLines(
  buffer: string,
  platform: string,
  model: string,
  id: string,
  created: number,
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController<Uint8Array>,
  doneSent: { value: boolean }
): string {
  const lines = buffer.split('\n');
  const remaining = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let payload: string | null = null;

    // 标准 SSE: data: {...}
    if (trimmed.startsWith('data:')) {
      payload = trimmed.slice(5).trim();
    } else if (trimmed.startsWith('data: ')) {
      payload = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // NDJSON: 纯 JSON 行(无 data: 前缀)
      payload = trimmed;
    }

    if (!payload) continue;

    if (payload === '[DONE]') {
      if (!doneSent.value) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        doneSent.value = true;
      }
      continue;
    }

    try {
      const upstreamData = JSON.parse(payload);
      const normalized = normalizeSseChunk(upstreamData, platform, model, id, created);
      if (normalized) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
      }
    } catch (e) {
      console.warn('[normalizeSseStream] JSON parse failed:', payload.slice(0, 200), e);
    }
  }

  return remaining;
}

/**
 * 包装一个 ReadableStream,把上游的 SSE chunk 转换成标准 OpenAI ChatCompletionChunk
 * 很多上游返回的格式跟 OpenAI 不完全一致,这里做归一化
 *
 * @param includeUsage 当 stream_options.include_usage=true 时,在末尾 chunk 携带 usage (TRAE/OpenAI 兼容)
 * @param onError 流异常中断时的回调(用于通知调用方记录失败)
 */
export function normalizeSseStream(
  upstream: ReadableStream<Uint8Array>,
  platform: string,
  model: string,
  idGen: () => string,
  onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void,
  includeUsage?: boolean,
  onError?: (error: Error) => void
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  const id = idGen();
  const created = Math.floor(Date.now() / 1000);
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
  const doneSent = { value: false };
  let finishReasonSent = false;
  let anyContentReceived = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const stallTimeout = 90000; // 90s — 上游 stall 检测
      const keepaliveInterval = 15000; // 每 15s 发一次 keepalive
      let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
      let lastDataTime = Date.now();
      let closed = false;

      function safeEnqueue(data: Uint8Array): boolean {
        if (closed) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          return false;
        }
      }

      function safeClose() {
        if (closed) return;
        closed = true;
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        try { controller.close(); } catch { /* already closed */ }
      }

      // keepalive 定时器 — 在上游慢时向客户端发送 SSE 注释,防止中间代理断连
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        const idle = Date.now() - lastDataTime;
        if (idle >= keepaliveInterval) {
          safeEnqueue(encoder.encode(': keepalive\n\n'));
        }
      }, keepaliveInterval);

      try {
        while (true) {
          const readPromise = reader.read();
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Stream stall timeout')), stallTimeout);
          });

          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await Promise.race([readPromise, timeoutPromise]);
          } catch (err: any) {
            // stall 超时或读取异常
            console.warn(`[normalizeSseStream] Stream error from ${platform}/${model}: ${err.message}`);
            if (onError) {
              try { onError(err); } catch { /* ignore */ }
            }
            if (anyContentReceived) {
              if (!doneSent.value) {
                safeEnqueue(encoder.encode('data: [DONE]\n\n'));
                doneSent.value = true;
              }
              safeClose();
            } else {
              if (keepaliveTimer) clearTimeout(keepaliveTimer);
              try { controller.error(err); } catch { /* ignore */ }
              closed = true;
            }
            return;
          }

          const { value, done } = result;

          if (done) {
            // flush TextDecoder
            const flushed = decoder.decode();
            if (flushed) buffer += flushed;

            // 处理 buffer 中残留的最后一条 SSE 事件
            if (buffer.trim()) {
              buffer = processBufferLines(buffer, platform, model, id, created, encoder, controller, doneSent);
              const lastLine = buffer.trim();
              if (lastLine) {
                let payload: string | null = null;
                if (lastLine.startsWith('data:')) {
                  payload = lastLine.slice(5).trim();
                } else if (lastLine.startsWith('data: ')) {
                  payload = lastLine.slice(6).trim();
                } else if (lastLine.startsWith('{') || lastLine.startsWith('[')) {
                  payload = lastLine;
                }
                if (payload && payload !== '[DONE]') {
                  try {
                    const upstreamData = JSON.parse(payload);
                    if (upstreamData.usage) {
                      lastUsage = {
                        prompt_tokens: upstreamData.usage.prompt_tokens,
                        completion_tokens: upstreamData.usage.completion_tokens,
                        total_tokens: upstreamData.usage.total_tokens,
                      };
                    }
                    // Google Interactions API: usage 在 interaction 对象内
                    if (upstreamData.interaction?.usage) {
                      const u = upstreamData.interaction.usage;
                      lastUsage = {
                        prompt_tokens: u.total_input_tokens || 0,
                        completion_tokens: u.total_output_tokens || 0,
                        total_tokens: u.total_tokens || 0,
                      };
                    }
                    const normalized = normalizeSseChunk(upstreamData, platform, model, id, created);
                    if (normalized) {
                      anyContentReceived = true;
                      if (includeUsage && lastUsage && normalized.choices?.[0]?.finish_reason) {
                        (normalized as any).usage = lastUsage;
                        finishReasonSent = true;
                      }
                      safeEnqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
                    }
                  } catch (e) {
                    console.warn('[normalizeSseStream] trailing buffer parse failed:', payload.slice(0, 200), e);
                  }
                }
              }
            }

            // 空流检测
            if (!anyContentReceived && !doneSent.value) {
              console.warn(`[normalizeSseStream] Stream ended with no content from ${platform}/${model}`);
              if (onError) {
                try { onError(new Error('Empty stream — no content received')); } catch { /* ignore */ }
              }
            }

            // 补发 usage chunk
            if (includeUsage && lastUsage && !finishReasonSent) {
              safeEnqueue(encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [],
                  usage: lastUsage,
                })}\n\n`
              ));
            }

            if (lastUsage && onUsage) {
              try { onUsage(lastUsage); } catch { /* ignore */ }
            }
            if (!doneSent.value) {
              safeEnqueue(encoder.encode('data: [DONE]\n\n'));
              doneSent.value = true;
            }
            safeClose();
            return;
          }

          lastDataTime = Date.now();
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let payload: string | null = null;

            if (trimmed.startsWith('data:')) {
              payload = trimmed.slice(5).trim();
            } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              payload = trimmed;
            }

            if (!payload) continue;

            if (payload === '[DONE]') {
              if (!doneSent.value) {
                safeEnqueue(encoder.encode('data: [DONE]\n\n'));
                doneSent.value = true;
              }
              continue;
            }

            try {
              const upstreamData = JSON.parse(payload);
              if (upstreamData.usage) {
                lastUsage = {
                  prompt_tokens: upstreamData.usage.prompt_tokens,
                  completion_tokens: upstreamData.usage.completion_tokens,
                  total_tokens: upstreamData.usage.total_tokens,
                };
              }
              // Google Interactions API: usage 在 interaction 对象内
              if (upstreamData.interaction?.usage) {
                const u = upstreamData.interaction.usage;
                lastUsage = {
                  prompt_tokens: u.total_input_tokens || 0,
                  completion_tokens: u.total_output_tokens || 0,
                  total_tokens: u.total_tokens || 0,
                };
              }
              const normalized = normalizeSseChunk(upstreamData, platform, model, id, created);
              if (normalized) {
                anyContentReceived = true;
                if (includeUsage && lastUsage && normalized.choices?.[0]?.finish_reason) {
                  (normalized as any).usage = lastUsage;
                  finishReasonSent = true;
                }
                safeEnqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
              }
            } catch (e) {
              console.warn('[normalizeSseStream] JSON parse failed:', payload.slice(0, 200), e);
            }
          }
        }
      } catch (err: any) {
        if (!closed) {
          console.warn(`[normalizeSseStream] Unexpected error from ${platform}/${model}: ${err.message}`);
          if (onError) {
            try { onError(err); } catch { /* ignore */ }
          }
          if (anyContentReceived) {
            if (!doneSent.value) {
              safeEnqueue(encoder.encode('data: [DONE]\n\n'));
              doneSent.value = true;
            }
            safeClose();
          } else {
            if (keepaliveTimer) clearTimeout(keepaliveTimer);
            try { controller.error(err); } catch { /* ignore */ }
            closed = true;
          }
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

/**
 * 把单个上游 chunk 归一化为 OpenAI ChatCompletionChunk 格式
 * 大部分上游(OpenAI 兼容)已经返回正确格式,只做兜底
 * 支持推理内容(DeepSeek R1 的 reasoning_content、Gemini 的 thought parts)
 */
function normalizeSseChunk(
  data: any,
  platform: string,
  model: string,
  id: string,
  created: number
): any {
  // 如果上游已经是标准格式
  if (data.id && data.object === 'chat.completion.chunk' && Array.isArray(data.choices)) {
    return data;
  }

  // Gemini 格式 -> OpenAI
  if (platform === 'google' && data.candidates) {
    const cand = data.candidates[0];
    if (!cand) return null;
    const parts = cand.content?.parts || [];
    // 分离 text parts 和 thought parts
    let text = '';
    let reasoning = '';
    for (const p of parts) {
      if (p.thought) {
        reasoning += p.text || '';
      } else {
        text += p.text || '';
      }
    }
    const delta: any = {};
    if (text) delta.content = text;
    if (reasoning) delta.reasoning_content = reasoning;
    if (!text && !reasoning) return null;
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: cand.finishReason === 'STOP' ? 'stop' : null,
        },
      ],
    };
  }

  // Google Interactions API: step.delta 事件
  // 格式: event: step.delta / data: {"index":0, "delta":{"type":"text", "text":"Hello"}}
  if (platform === 'google' && data.delta?.type === 'text') {
    const text = data.delta.text || '';
    if (!text) return null;
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
  }

  // Google Interactions API: interaction.completed 事件
  // 格式: event: interaction.completed / data: {"interaction":{"id":"...", "status":"completed", "usage":{...}}}
  if (platform === 'google' && data.interaction) {
    const status = data.interaction.status;
    if (status === 'completed' || status === 'cancelled' || status === 'failed') {
      return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: status === 'completed' ? 'stop' : 'length' }],
      };
    }
    return null;
  }

  // Anthropic 原生格式(按 data.type 检测,不依赖 platform 名)
  // 修复:之前用 platform === 'anthropic' 是死代码(anthropic 不在 Platform 类型中)
  if (data.type === 'content_block_delta' || data.type === 'message_delta' || data.type === 'message_stop') {
    const text = data.delta?.text || '';
    // 只在有内容时返回 chunk(跳过 keepalive 和空 delta)
    if (!text && data.type !== 'message_stop') return null;
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: data.type === 'message_stop' ? 'stop' : null,
        },
      ],
    };
  }

  // Cloudflare AI
  if (platform === 'cloudflare' && data.response !== undefined) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: data.response || '' },
          finish_reason: data.done ? 'stop' : null,
        },
      ],
    };
  }

  // Ollama
  if (platform === 'ollama' && data.message) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: data.message.content || '' },
          finish_reason: data.done ? 'stop' : null,
        },
      ],
    };
  }

  // 通用兜底:尽量取 content
  // 修复:增加 delta.text 路径(Anthropic 的 content_block_delta 用 delta.text)
  // 同时透传 reasoning_content(DeepSeek R1 等)
  const content =
    data.choices?.[0]?.delta?.content ||
    data.choices?.[0]?.delta?.text ||
    data.choices?.[0]?.text ||
    data.choices?.[0]?.message?.content ||
    data.content ||
    data.delta?.content ||
    data.delta?.text ||
    data.text ||
    data.response ||
    '';

  const reasoningContent =
    data.choices?.[0]?.delta?.reasoning_content ||
    data.choices?.[0]?.message?.reasoning_content ||
    data.choices?.[0]?.delta?.reasoning ||
    data.reasoning_content ||
    '';

  // 如果完全没有内容且没有 finish_reason 且没有 reasoning,跳过这个 chunk(减少噪音)
  if (!content && !reasoningContent && !data.choices?.[0]?.finish_reason && data.finish_reason === undefined) {
    return null;
  }

  const delta: any = {};
  if (content) delta.content = content;
  if (reasoningContent) delta.reasoning_content = reasoningContent;

  return {
    id: data.id || id,
    object: 'chat.completion.chunk',
    created: data.created || created,
    model: data.model || model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: data.choices?.[0]?.finish_reason || data.finish_reason || null,
      },
    ],
  };
}
