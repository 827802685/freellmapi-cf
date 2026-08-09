// ============================================================
// FreeLLM API - Chat Completions Route
// Forwards requests to the appropriate provider.
// ============================================================

import type { Env, ChatCompletionRequest, ChatCompletionResponse, StreamChunk, ApiResponse } from '../../types';
import { getProviderForModel, getProviderConfig } from '../../providers/index';
import { decryptAesGcm } from '../../lib/crypto';
import { Db } from '../../lib/db';
import { AnalyticsService } from '../../services/analytics';

export async function handleChatCompletion(
  request: Request,
  env: Env,
  db: Db,
  auth: { userId?: number; apiKeyId?: number }
): Promise<Response> {
  const analyticsService = new AnalyticsService(db);
  const startTime = Date.now();

  try {
    const body: ChatCompletionRequest = await request.json();

    if (!body.model || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(
        JSON.stringify({ error: '缺少必要参数: model 和 messages' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Determine the provider for this model
    const provider = getProviderForModel(body.model);
    const providerConfig = getProviderConfig(provider);

    if (!providerConfig) {
      return new Response(
        JSON.stringify({ error: `不支持的模型: ${body.model}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get provider API key from D1 database (encrypted)
    const providerKeys = await db.getActiveProviderKeys(provider);
    if (providerKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: `提供商 ${providerConfig.displayName} 未配置可用密钥` }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Use the first available key (prioritized by DB query)
    const providerKey = providerKeys[0];
    const encryptionKey = env.ENCRYPTION_KEY;
    let apiKey: string;

    try {
      apiKey = await decryptAesGcm(providerKey.key_encrypted, encryptionKey);
    } catch {
      return new Response(
        JSON.stringify({ error: '解密提供商密钥失败' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const baseUrl = providerKey.base_url || providerConfig.baseUrl;
    const isStream = body.stream === true;

    // Build the request to the provider
    const providerRequestBody: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens ?? 4096,
      top_p: body.top_p ?? 1,
      frequency_penalty: body.frequency_penalty ?? 0,
      presence_penalty: body.presence_penalty ?? 0,
      stream: isStream,
    };

    const ipAddress = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;

    try {
      const providerResponse = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(providerRequestBody),
      });

      // Increment usage count
      db.incrementProviderKeyUsage(providerKey.id).catch(() => {});

      if (!providerResponse.ok) {
        const errorBody = await providerResponse.text();
        const durationMs = Date.now() - startTime;

        // Record error analytics
        analyticsService.recordRequest({
          modelId: body.model,
          provider,
          durationMs,
          promptTokens: 0,
          completionTokens: 0,
          status: `error_${providerResponse.status}`,
          ipAddress,
          userId: auth.userId ?? null,
          apiKeyId: auth.apiKeyId ?? null,
          cost: 0,
        }).catch(() => {});

        return new Response(
          JSON.stringify({
            error: `提供商 API 错误`,
            provider_status: providerResponse.status,
            provider_error: errorBody,
          }),
          { status: providerResponse.status, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Handle streaming response
      if (isStream) {
        const durationMs = Date.now() - startTime;
        // Record analytics for stream start (will be updated on completion)
        analyticsService.recordRequest({
          modelId: body.model,
          provider,
          durationMs,
          promptTokens: 0,
          completionTokens: 0,
          status: 'streaming',
          ipAddress,
          userId: auth.userId ?? null,
          apiKeyId: auth.apiKeyId ?? null,
          cost: 0,
        }).catch(() => {});

        // Pass through the streaming response
        const transformedStream = providerResponse.body
          ? new ReadableStream({
              start(controller) {
                const reader = providerResponse.body!.getReader();
                const pump = () => {
                  reader.read().then(({ done, value }) => {
                    if (done) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(value);
                    pump();
                  }).catch((err) => {
                    controller.error(err);
                  });
                };
                pump();
              },
            })
          : null;

        return new Response(transformedStream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Non-streaming response
      const responseData: ChatCompletionResponse = await providerResponse.json();
      const durationMs = Date.now() - startTime;

      const promptTokens = responseData.usage?.prompt_tokens || 0;
      const completionTokens = responseData.usage?.completion_tokens || 0;
      const cost = analyticsService.calculateCost(body.model, promptTokens, completionTokens);

      // Record analytics
      analyticsService.recordRequest({
        modelId: body.model,
        provider,
        durationMs,
        promptTokens,
        completionTokens,
        status: 'success',
        ipAddress,
        userId: auth.userId ?? null,
        apiKeyId: auth.apiKeyId ?? null,
        cost,
      }).catch(() => {});

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (fetchError) {
      const durationMs = Date.now() - startTime;
      analyticsService.recordRequest({
        modelId: body.model,
        provider,
        durationMs,
        promptTokens: 0,
        completionTokens: 0,
        status: 'network_error',
        ipAddress,
        userId: auth.userId ?? null,
        apiKeyId: auth.apiKeyId ?? null,
        cost: 0,
      }).catch(() => {});

      return new Response(
        JSON.stringify({
          error: '请求提供商 API 失败',
          detail: fetchError instanceof Error ? fetchError.message : '网络错误',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: '请求处理失败',
        detail: error instanceof Error ? error.message : '未知错误',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
}