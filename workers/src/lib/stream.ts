/**
 * SSE 流式响应工具
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
 * 包装一个 ReadableStream,把上游的 SSE chunk 转换成标准 OpenAI ChatCompletionChunk
 * 很多上游返回的格式跟 OpenAI 不完全一致,这里做归一化
 */
export function normalizeSseStream(
  upstream: ReadableStream<Uint8Array>,
  platform: string,
  model: string,
  idGen: () => string
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  const id = idGen();
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          // 发最后的 [DONE] 标记
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            continue;
          }

          try {
            const upstreamData = JSON.parse(payload);
            const normalized = normalizeSseChunk(upstreamData, platform, model, id, created);
            if (normalized) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
            }
          } catch {
            // 跳过无法解析的 chunk
          }
        }
      } catch (err) {
        controller.error(err);
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
    const text = parts.map((p: any) => p.text || '').join('');
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: cand.finishReason === 'STOP' ? 'stop' : null,
        },
      ],
    };
  }

  // Anthropic 格式
  if (platform === 'anthropic' && (data.type === 'content_block_delta' || data.type === 'message_stop')) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: data.delta?.text || '' },
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
  const content =
    data.choices?.[0]?.delta?.content ||
    data.choices?.[0]?.text ||
    data.content ||
    data.delta?.content ||
    data.response ||
    '';
  return {
    id: data.id || id,
    object: 'chat.completion.chunk',
    created: data.created || created,
    model: data.model || model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: data.choices?.[0]?.finish_reason || null,
      },
    ],
  };
}
