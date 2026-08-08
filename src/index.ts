// FreeLLMAPI Cloudflare Workers Entry Point
// Main request handler with routing, CORS, rate limiting, analytics, and error handling
// Scheduled handler for cron: health check, cache cleanup, catalog sync

import type { Env } from './types';
import { DB } from './lib/db';
import { Cache } from './lib/cache';
import { handleCORS, attachCORS } from './middleware/cors';
import { verifyAuth } from './middleware/auth';
import { runMiddleware, createContext } from './middleware/index';
import { handleChatCompletion } from './routes/v1/chat';
import { handleListModels } from './routes/v1/models';
import { handleImageGeneration } from './routes/v1/images';
import { handleTTSSpeech, handleSTTTranscription } from './routes/v1/audio';
import { handleEmbeddings } from './routes/v1/embeddings';
import { handleMessagesCreate, handleResponsesCreate } from './routes/v1/messages';
import { handleAdminRoute } from './routes/api/admin';
import { scheduledHealthCheck, getCachedHealthStatus } from './services/health-check';
import { recordRequest, getStats, AnalyticsHelpers } from './services/analytics';
import { getProvider, listProviders } from './providers/index';

// ============================================================
// Types
// ============================================================

interface AppServices {
  db: DB;
  cache: Cache;
}

interface ErrorResponseBody {
  error: {
    message: string;
    type: string;
    code: string;
    status: number;
  };
}

// ============================================================
// Cloudflare Workers Entry Point
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    // Initialize services
    const services: AppServices = {
      db: new DB(env.DB),
      cache: new Cache(env.CACHE),
    };

    try {
      return await handleRequest(request, env, ctx, services, requestId, startTime);
    } catch (err) {
      return handleUnhandledError(err, requestId);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const services: AppServices = {
      db: new DB(env.DB),
      cache: new Cache(env.CACHE),
    };

    await scheduledHandler(event, services, env);
  },
};

// ============================================================
// Main Request Handler
// ============================================================

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  services: AppServices,
  requestId: string,
  startTime: number,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Request-ID, X-Session-ID, X-Mode, X-Session-Id',
        'Access-Control-Expose-Headers': 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Provider, X-Model',
        'Access-Control-Max-Age': '86400',
        'X-Request-ID': requestId,
      },
    });
  }

  // Authenticate the request
  const auth = await verifyAuth(request, env, services.db);
  const userId = auth.user?.id?.toString() || auth.apiKey?.id?.toString() || undefined;

  // Route the request
  let response: Response;

  try {
    if (path === '/v1/chat/completions') {
      response = await handleChatCompletion({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
        userId,
      });
    } else if (path === '/v1/models') {
      // Handle both GET /v1/models and GET /v1/models/:model
      const modelId = url.searchParams.get('model') || undefined;
      if (modelId) {
        const { handleGetModel } = await import('./routes/v1/models');
        response = await handleGetModel(modelId, { db: services.db, env });
      } else {
        response = await handleListModels({ db: services.db, env });
      }
    } else if (path.startsWith('/v1/images/')) {
      response = await handleImageGeneration({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
        userId,
      });
    } else if (path.startsWith('/v1/audio/')) {
      if (path === '/v1/audio/speech') {
        response = await handleTTSSpeech({
          request,
          env,
          ctx,
          db: services.db,
          cache: services.cache,
          userId,
        });
      } else if (path === '/v1/audio/transcriptions') {
        response = await handleSTTTranscription({
          request,
          env,
          ctx,
          db: services.db,
          cache: services.cache,
          userId,
        });
      } else {
        response = jsonErrorResponse('Audio endpoint not found', 'not_found', 'route_not_found', 404, requestId);
      }
    } else if (path === '/v1/embeddings') {
      response = await handleEmbeddings({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
        userId,
      });
    } else if (path === '/v1/messages') {
      response = await handleMessagesCreate({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
        userId,
      });
    } else if (path === '/v1/responses') {
      response = await handleResponsesCreate({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
        userId,
      });
    } else if (path.startsWith('/api/admin/') || path.startsWith('/api/')) {
      response = await handleAdminRoute({
        request,
        env,
        ctx,
        db: services.db,
        cache: services.cache,
      });
    } else if (path === '/mcp') {
      response = await handleMCP(request, requestId);
    } else if (path === '/' || path === '/index.html') {
      response = await handleDashboard(request, env, services, requestId);
    } else {
      response = jsonErrorResponse('Not Found', 'not_found', 'route_not_found', 404, requestId);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Internal Server Error';
    console.error(`[Route Error] ${path}: ${errorMessage}`, err);
    response = jsonErrorResponse(errorMessage, 'internal_error', 'route_error', 500, requestId);
  }

  // Attach CORS headers
  response = attachCORSWithId(response, requestId);

  // Record analytics asynchronously for /v1/* routes
  if (path.startsWith('/v1/')) {
    ctx.waitUntil(
      recordAnalytics(services.db, services.cache, path, response.status, startTime, userId)
    );
  }

  return response;
}

// ============================================================
// Route Handlers (inlined for endpoints without dedicated handler files)
// ============================================================

/**
 * Handle /mcp - Model Context Protocol endpoint.
 * Provides JSON-RPC 2.0 based tool/resource/prompt discovery.
 */
async function handleMCP(request: Request, requestId: string): Promise<Response> {
  const method = request.method;

  if (method === 'GET') {
    // SSE endpoint for MCP streaming
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Send initial MCP endpoint info event
    const initEvent = {
      jsonrpc: '2.0',
      method: 'initialized',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: {
          name: 'FreeLLMAPI',
          version: '1.0.0',
        },
      },
    };
    writer.write(encoder.encode(`data: ${JSON.stringify(initEvent)}\n\n`));

    // Keep-alive and cleanup
    request.signal.addEventListener('abort', () => {
      writer.close().catch(() => {});
    });

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-ID': requestId,
      },
    });
  }

  if (method === 'POST') {
    try {
      const body = await request.json() as { method: string; params: unknown; id: string | number };
      const result = await handleMCPRequest(body);
      return jsonResponse(result, 200, { 'X-Request-ID': requestId });
    } catch (err) {
      return jsonErrorResponse(
        `MCP request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'mcp_error',
        'mcp_error',
        500,
        requestId,
      );
    }
  }

  return jsonErrorResponse('Method not allowed for MCP', 'method_error', 'method_not_allowed', 405, requestId);
}

/**
 * Handle MCP JSON-RPC requests.
 */
async function handleMCPRequest(body: { method: string; params: unknown; id: string | number }): Promise<unknown> {
  const { method, id } = body;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: {
            name: 'FreeLLMAPI',
            version: '1.0.0',
          },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'chat_completion',
              description: 'Send a chat completion request to any supported LLM provider',
              inputSchema: {
                type: 'object',
                properties: {
                  model: { type: 'string', description: 'Model ID to use' },
                  messages: { type: 'array', description: 'Chat messages in OpenAI format' },
                  stream: { type: 'boolean', description: 'Enable streaming response' },
                },
                required: ['model', 'messages'],
              },
            },
            {
              name: 'list_models',
              description: 'List all available models across providers',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        },
      };

    case 'resources/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { resources: [] },
      };

    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { prompts: [] },
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/**
 * Handle dashboard (/) - Return API information.
 */
async function handleDashboard(
  request: Request,
  env: Env,
  services: AppServices,
  requestId: string,
): Promise<Response> {
  const info = {
    name: 'FreeLLMAPI',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
      images: '/v1/images/*',
      audio: '/v1/audio/*',
      embeddings: '/v1/embeddings',
      messages: '/v1/messages',
      responses: '/v1/responses',
      admin: '/api/admin/*',
      mcp: '/mcp',
    },
    providers: listProviders(),
    requestId,
  };

  return jsonResponse(info, 200, { 'X-Request-ID': requestId });
}

// ============================================================
// Scheduled Handler (Cron Trigger)
// ============================================================

/**
 * Handle scheduled events (cron triggers).
 * Performs:
 *   1. Health check all providers
 *   2. Cleanup expired sessions
 *   3. Sync model catalog
 *   4. Clear expired cache entries
 */
async function scheduledHandler(
  event: ScheduledEvent,
  services: AppServices,
  env: Env,
): Promise<void> {
  const { db, cache } = services;
  const cron = event.cron || '';

  console.log(`[Scheduled] Triggered at ${new Date().toISOString()}, cron: ${cron}`);

  // === Task 1: Health check all providers ===
  try {
    const healthResult = await scheduledHealthCheck(db, cache);
    console.log(`[Scheduled] Health check complete:`, JSON.stringify(healthResult));
  } catch (err) {
    console.error(`[Scheduled] Health check failed:`, err);
  }

  // === Task 2: Cleanup expired sessions ===
  try {
    await db.cleanupExpiredSessions();
    console.log(`[Scheduled] Expired sessions cleaned up`);
  } catch (err) {
    console.error(`[Scheduled] Session cleanup failed:`, err);
  }

  // === Task 3: Sync model catalog ===
  try {
    await syncModelCatalog(env, db, cache);
  } catch (err) {
    console.error(`[Scheduled] Catalog sync failed:`, err);
  }

  // === Task 4: Cache cleanup ===
  try {
    await clearExpiredCacheKeys(cache);
  } catch (err) {
    console.error(`[Scheduled] Cache cleanup failed:`, err);
  }

  console.log(`[Scheduled] All tasks completed at ${new Date().toISOString()}`);
}

/**
 * Sync the model catalog from the configured CATALOG_URL.
 */
async function syncModelCatalog(
  env: Env,
  db: DB,
  cache: Cache,
): Promise<void> {
  // Check if catalog sync is needed
  const cached = await cache.getCachedCatalog<{ version: string }>();
  if (cached) {
    console.log(`[Catalog] Already cached (version: ${cached.version}), skipping sync`);
    return;
  }

  const catalogUrl = env.CATALOG_URL;
  if (!catalogUrl) {
    console.log(`[Catalog] No CATALOG_URL configured, skipping sync`);
    return;
  }

  console.log(`[Catalog] Fetching catalog from ${catalogUrl}`);
  const response = await fetch(catalogUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch catalog: ${response.status} ${response.statusText}`);
  }

  const catalog = await response.json() as {
    models: Array<{
      model_id: string;
      provider: string;
      display_name?: string;
      context_window: number;
      max_tokens: number;
      supports_vision: number;
      supports_tools: number;
      supports_streaming: number;
      is_enabled: number;
      intelligence_rank: number;
      speed_rank: number;
      reliability_score: number;
      price_hint?: string;
    }>;
    version?: string;
  };

  let syncedCount = 0;
  for (const model of catalog.models) {
    await db.upsertModel({
      ...model,
      display_name: model.display_name ?? null,
      price_hint: model.price_hint ?? null,
    });
    syncedCount++;
  }

  // Cache the catalog
  if (catalog.version) {
    await cache.setCachedCatalog({ version: catalog.version, syncedCount }, 43200);
    await db.setCatalogMeta(catalog.version, JSON.stringify(catalog));
  }

  console.log(`[Catalog] Synced ${syncedCount} models, version: ${catalog.version || 'unknown'}`);
}

/**
 * Clear expired cache entries.
 * Currently a placeholder - in production, this could iterate over KV keys.
 */
async function clearExpiredCacheKeys(cache: Cache): Promise<void> {
  // KV namespace automatically handles TTL-based expiration.
  // This method serves as a hook for any custom cleanup logic.
  console.log(`[Cache] Cleanup: KV TTL-based expiration is automatic`);
}

// ============================================================
// Analytics Recording
// ============================================================

/**
 * Record analytics for a completed request.
 */
async function recordAnalytics(
  db: DB,
  cache: Cache,
  endpoint: string,
  statusCode: number,
  startTime: number,
  userId?: string,
): Promise<void> {
  const latencyMs = Date.now() - startTime;

  try {
    await recordRequest(db, cache, {
      endpoint,
      provider: 'unknown',
      model: 'unknown',
      latencyMs,
      tokensPrompt: 0,
      tokensCompletion: 0,
      statusCode,
      userId,
    });
  } catch (err) {
    console.warn(`[Analytics] Failed to record:`, err);
  }
}

// ============================================================
// Error Handling
// ============================================================

/**
 * Handle an unhandled error and return a proper error response.
 */
function handleUnhandledError(err: unknown, requestId: string): Response {
  const errorMessage = err instanceof Error ? err.message : 'Internal Server Error';
  console.error(`[Unhandled Error] ${requestId}: ${errorMessage}`, err);

  return new Response(
    JSON.stringify({
      error: {
        message: 'Internal Server Error',
        type: 'internal_error',
        code: 'internal_server_error',
        status: 500,
      },
    } satisfies ErrorResponseBody),
    {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-ID': requestId,
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

// ============================================================
// Response Helpers
// ============================================================

/**
 * Create a JSON success response.
 */
function jsonResponse(data: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

/**
 * Create a JSON error response.
 */
function jsonErrorResponse(
  message: string,
  type: string,
  code: string,
  status: number,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: ErrorResponseBody = {
    error: {
      message,
      type,
      code,
      status,
    },
  };

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-ID': requestId,
      ...extraHeaders,
    },
  });
}

/**
 * Attach CORS headers and X-Request-ID to a response.
 */
function attachCORSWithId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);

  // Set CORS headers
  const corsHeadersMap: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Request-ID, X-Session-ID, X-Mode, X-Session-Id',
    'Access-Control-Expose-Headers': 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Provider, X-Model',
  };

  for (const [key, value] of Object.entries(corsHeadersMap)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  headers.set('X-Request-ID', requestId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}