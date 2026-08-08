// Models listing endpoint (OpenAI-compatible)
// GET /v1/models

import { DB } from '../../lib/db';
import { getTimestamp } from '../../lib/crypto';
import type { Env, ModelInfo, ModelListResponse, ModelEntry } from '../../types';

interface ModelListParams {
  db: DB;
  env: Env;
}

/**
 * Handle GET /v1/models
 * Returns available models in OpenAI-compatible format.
 */
export async function handleListModels(params: ModelListParams): Promise<Response> {
  const { db } = params;

  try {
    const models = await db.getModels();

    const entries: ModelEntry[] = models.map((model: ModelInfo) => ({
      id: model.model_id,
      object: 'model',
      created: getTimestamp(),
      owned_by: model.provider,
      permission: [
        {
          id: `modelperm-${model.id}`,
          object: 'model_permission',
          created: getTimestamp(),
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: !!(model.supports_vision || model.supports_tools),
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: '*',
          group: null,
          is_blocking: false,
        },
      ],
    }));

    const response: ModelListResponse = {
      object: 'list',
      data: entries,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle GET /v1/models/:model
 * Returns details for a specific model.
 */
export async function handleGetModel(
  modelId: string,
  params: ModelListParams
): Promise<Response> {
  const { db } = params;

  try {
    const model = await db.getModelByModelId(modelId);

    if (!model) {
      return new Response(
        JSON.stringify({ error: { message: `Model '${modelId}' not found`, type: 'model_not_found', code: 404 } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const entry: ModelEntry = {
      id: model.model_id,
      object: 'model',
      created: getTimestamp(),
      owned_by: model.provider,
      permission: [
        {
          id: `modelperm-${model.id}`,
          object: 'model_permission',
          created: getTimestamp(),
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: !!(model.supports_vision || model.supports_tools),
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: '*',
          group: null,
          is_blocking: false,
        },
      ],
    };

    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: { message: errorMessage, type: 'server_error', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}