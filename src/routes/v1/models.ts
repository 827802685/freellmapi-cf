// ============================================================
// FreeLLM API - Models List Route
// Returns available models (OpenAI-compatible format).
// ============================================================

import type { Env, ApiResponse, ModelInfo } from '../../types';
import { Db } from '../../lib/db';

export async function handleListModels(
  request: Request,
  env: Env,
  db: Db
): Promise<Response> {
  try {
    const models = await db.getModels(true);

    // Format as OpenAI-compatible response
    const openaiModels = models.map((m: ModelInfo) => ({
      id: m.model_id,
      object: 'model',
      created: Math.floor(new Date(m.created_at).getTime() / 1000),
      owned_by: m.provider,
      permission: [],
      root: m.model_id,
      parent: null,
    }));

    // If no models in DB, return from provider config
    if (models.length === 0) {
      const { getAllProviders } = await import('../../providers/index');
      const providers = getAllProviders();
      const fallbackModels: { id: string; object: string; created: number; owned_by: string }[] = [];

      for (const config of providers) {
        for (const modelId of config.models) {
          fallbackModels.push({
            id: modelId,
            object: 'model',
            created: Date.now(),
            owned_by: config.name,
          });
        }
      }

      return new Response(
        JSON.stringify({
          object: 'list',
          data: fallbackModels,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        object: 'list',
        data: openaiModels,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [],
        error: '获取模型列表失败',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}