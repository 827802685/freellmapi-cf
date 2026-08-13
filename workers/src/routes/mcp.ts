/**
 * MCP (Model Context Protocol) 服务器端点
 *
 * 实现 Streamable HTTP 传输 (MCP 2025-06-18 规范)
 * 文档: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * 提供工具:
 * - list_models: 列出所有可用模型
 * - chat: 发送聊天补全请求
 * - list_providers: 列出所有提供商及状态
 * - get_analytics: 获取分析摘要
 * - health_check: 检查提供商健康状态
 * - get_version: 获取版本信息
 * - get_fallback_chain: 获取 fallback 链
 */

import { Hono } from 'hono';
import type { Env, ChatMessage, ChatCompletionRequest } from '../types';
import { authenticateUserToken, requireDashboardAuth } from '../lib/auth';
import { ALL_PLATFORMS, PLATFORM_LABELS } from '../providers';
import type { Platform } from '../types';
import { getSetting } from '../lib/response';

export const mcpRoute = new Hono<{ Bindings: Env }>();

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'freellmapi-cf',
  version: '1.0.0',
};

// ============= MCP 工具定义 =============

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'list_models',
    description: 'List all available LLM models, optionally filtered by platform. Returns model name, platform, context window, and capabilities (vision/tools support).',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Filter by platform (e.g. google, groq, openrouter). If omitted, lists all models.',
        },
        enabled_only: {
          type: 'boolean',
          description: 'Only return enabled models. Default: true',
        },
      },
    },
  },
  {
    name: 'chat',
    description: 'Send a chat completion request to the LLM router. The router automatically selects the best available model and falls back on failure. Returns the assistant response text.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The user message to send to the LLM.',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt to set the assistant behavior.',
        },
        model: {
          type: 'string',
          description: 'Specific model to use (e.g. "gemini-2.0-flash"). Use "auto" for automatic routing. Default: "auto".',
        },
        max_tokens: {
          type: 'number',
          description: 'Maximum output tokens. Default: 8192.',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature (0-2). Default: model default.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_providers',
    description: 'List all configured LLM providers with their key count, enabled status, and health information.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_analytics',
    description: 'Get analytics summary including total requests, success rate, average latency, token usage, and per-platform breakdown for the last 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look back. Default: 7.',
        },
      },
    },
  },
  {
    name: 'health_check',
    description: 'Check the health status of all API keys across all providers. Returns per-key health status (healthy, rate_limited, invalid, error).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_version',
    description: 'Get the current version and build info of the freellmapi-cf server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_fallback_chain',
    description: 'Get the configured fallback chain — the ordered list of models the router tries when the primary model fails.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============= MCP 协议处理 =============

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ============= 工具实现 =============

async function toolListModels(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const platform = args?.platform as string | undefined;
  const enabledOnly = (args?.enabled_only as boolean | undefined) !== false;

  let query = 'SELECT model_name, platform, display_name, family, context_window, supports_tools, supports_vision, enabled FROM models';
  const conditions: string[] = [];
  const bindings: string[] = [];

  if (platform) {
    conditions.push('platform = ?');
    bindings.push(platform);
  }
  if (enabledOnly) {
    conditions.push('enabled = 1');
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY platform, model_name';

  const result = await env.DB.prepare(query).bind(...bindings).all();
  const models = ((result.results || []) as Array<Record<string, unknown>>).map((m) => ({
    name: m.model_name,
    platform: m.platform,
    displayName: m.display_name || m.model_name,
    family: m.family,
    contextWindow: m.context_window,
    supportsTools: m.supports_tools === 1,
    supportsVision: m.supports_vision === 1,
    enabled: m.enabled === 1,
  }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ count: models.length, models }, null, 2),
      },
    ],
  };
}

async function toolChat(env: Env, userTokenId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = args?.message;
  if (!message) {
    return {
      content: [{ type: 'text', text: 'Error: message is required' }],
      isError: true,
    };
  }

  const messages: ChatMessage[] = [];
  if (args.system) {
    messages.push({ role: 'system', content: args.system as string });
  }
  messages.push({ role: 'user', content: message as string });

  const body: ChatCompletionRequest = {
    model: (args.model as string) || 'auto',
    messages,
    stream: false,
    max_tokens: (args.max_tokens as number) || 8192,
  };
  if (args.temperature !== undefined) {
    body.temperature = args.temperature as number;
  }

  const backendUrl = env.BACKEND_URL || 'https://api.zjkl0330.dpdns.org';
  const resp = await fetch(`${backendUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return {
      content: [{ type: 'text', text: `Error (${resp.status}): ${errText.slice(0, 500)}` }],
      isError: true,
    };
  }

  const data = await resp.json() as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content as string | undefined || '(empty response)';
  const usage = data.usage as Record<string, unknown> | undefined || {};
  const platform = resp.headers.get('X-Platform') || 'unknown';
  const model = resp.headers.get('X-Model') || (data.model as string) || 'unknown';
  const latency = resp.headers.get('X-Latency') || '?';

  return {
    content: [
      {
        type: 'text',
        text: content,
      },
      {
        type: 'text',
        text: `\n---\nPlatform: ${platform} | Model: ${model} | Latency: ${latency}ms | Tokens: ${(usage.total_tokens as string | number | undefined) || 'N/A'}`,
      },
    ],
  };
}

async function toolListProviders(env: Env): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(
    `SELECT platform, COUNT(*) as total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) as enabled,
     SUM(CASE WHEN health_status='healthy' THEN 1 ELSE 0 END) as healthy,
     SUM(CASE WHEN health_status='rate_limited' THEN 1 ELSE 0 END) as rate_limited,
     SUM(CASE WHEN health_status='invalid' THEN 1 ELSE 0 END) as invalid
     FROM api_keys GROUP BY platform ORDER BY platform`
  ).all();

  const providers: Array<Record<string, unknown>> = ((result.results || []) as Array<Record<string, unknown>>).map((p) => ({
    platform: p.platform,
    label: (PLATFORM_LABELS as Record<string, string>)[p.platform as string] || p.platform,
    totalKeys: p.total,
    enabledKeys: p.enabled,
    healthy: p.healthy,
    rateLimited: p.rate_limited,
    invalid: p.invalid,
  }));

  // Add platforms with no keys
  const existingPlatforms = new Set(providers.map((p) => p.platform as string));
  for (const p of ALL_PLATFORMS) {
    if (!existingPlatforms.has(p)) {
      providers.push({
        platform: p,
        label: (PLATFORM_LABELS as Record<string, string>)[p] || p,
        totalKeys: 0,
        enabledKeys: 0,
        healthy: 0,
        rateLimited: 0,
        invalid: 0,
      });
    }
  }

  return {
    content: [
      { type: 'text', text: JSON.stringify({ count: providers.length, providers }, null, 2) },
    ],
  };
}

async function toolGetAnalytics(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const days = (args?.days as number) || 7;
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const [total, successRate, platformBreakdown, tokenAgg, latencyAgg] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM request_logs WHERE created_at >= ?').bind(since).first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(CASE WHEN status_code < 400 THEN 1 END) as s, COUNT(*) as t FROM request_logs WHERE created_at >= ?').bind(since).first<{ s: number; t: number }>(),
    env.DB.prepare('SELECT platform, COUNT(*) as c, AVG(latency_ms) as avg_latency FROM request_logs WHERE created_at >= ? GROUP BY platform ORDER BY c DESC').bind(since).all(),
    env.DB.prepare('SELECT SUM(prompt_tokens) as pin, SUM(completion_tokens) as pout FROM request_logs WHERE created_at >= ?').bind(since).first<{ pin: number; pout: number }>(),
    env.DB.prepare('SELECT AVG(latency_ms) as a FROM request_logs WHERE created_at >= ? AND latency_ms > 0').bind(since).first<{ a: number }>(),
  ]);

  const summary = {
    period: `${days} days`,
    totalRequests: total?.c || 0,
    successRate: successRate?.t ? `${((successRate.s / successRate.t) * 100).toFixed(1)}%` : 'N/A',
    avgLatency: latencyAgg?.a ? `${Math.round(latencyAgg.a)}ms` : 'N/A',
    promptTokens: tokenAgg?.pin || 0,
    completionTokens: tokenAgg?.pout || 0,
    totalTokens: (tokenAgg?.pin || 0) + (tokenAgg?.pout || 0),
    platformBreakdown: ((platformBreakdown.results || []) as Array<Record<string, unknown>>).map((p) => ({
      platform: p.platform,
      requests: p.c,
      avgLatency: p.avg_latency ? `${Math.round(p.avg_latency as number)}ms` : 'N/A',
    })),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  };
}

async function toolHealthCheck(env: Env): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(
    `SELECT platform, key_hint, health_status, last_checked_at, enabled
     FROM api_keys ORDER BY platform, id`
  ).all();

  const keys = ((result.results || []) as Array<Record<string, unknown>>).map((k) => ({
    platform: k.platform,
    keyHint: k.key_hint,
    health: k.health_status,
    enabled: k.enabled === 1,
    lastChecked: k.last_checked_at ? new Date((k.last_checked_at as number) * 1000).toISOString() : null,
  }));

  const summary = {
    total: keys.length,
    healthy: keys.filter((k) => k.health === 'healthy').length,
    rateLimited: keys.filter((k) => k.health === 'rate_limited').length,
    invalid: keys.filter((k) => k.health === 'invalid').length,
    error: keys.filter((k) => k.health === 'error').length,
    keys,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  };
}

async function toolGetVersion(env: Env): Promise<Record<string, unknown>> {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        name: 'freellmapi-cf',
        version: env.APP_VERSION || 'dev',
        runtime: 'cloudflare-workers',
        mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      }, null, 2),
    }],
  };
}

async function toolGetFallbackChain(env: Env): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(
    'SELECT position, platform, model, enabled FROM fallback_chain ORDER BY position'
  ).all();

  const chain = ((result.results || []) as Array<Record<string, unknown>>).map((f) => ({
    position: f.position,
    platform: f.platform,
    model: f.model,
    enabled: f.enabled === 1,
  }));

  return {
    content: [{ type: 'text', text: JSON.stringify({ chain }, null, 2) }],
  };
}

// ============= MCP 请求处理器 =============

async function handleMcpRequest(
  env: Env,
  req: JsonRpcRequest,
  userTokenId: number | null,
  dashboardSession: { accountId: number; email: string } | null
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // 通知（无 id）不需要响应
  const hasId = id !== undefined;

  switch (method) {
    case 'initialize':
      return rpcResult(id!, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      // 客户端确认初始化完成 — 无需响应
      return null;

    case 'ping':
      return rpcResult(id!, {});

    case 'tools/list':
      return rpcResult(id!, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const toolName = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown> | undefined) || {};

      // 权限检查:chat 需要 user token，管理工具需要 dashboard auth
      const adminTools = ['list_providers', 'get_analytics', 'health_check', 'get_fallback_chain'];
      if (toolName && adminTools.includes(toolName) && !dashboardSession) {
        return rpcError(id!, -32603, `Tool "${toolName}" requires dashboard authentication`);
      }
      if (toolName === 'chat' && !userTokenId) {
        return rpcError(id!, -32603, 'Tool "chat" requires a valid API token');
      }

      try {
        let result: Record<string, unknown>;
        switch (toolName) {
          case 'list_models':
            result = await toolListModels(env, args);
            break;
          case 'chat':
            result = await toolChat(env, userTokenId!, args);
            break;
          case 'list_providers':
            result = await toolListProviders(env);
            break;
          case 'get_analytics':
            result = await toolGetAnalytics(env, args);
            break;
          case 'health_check':
            result = await toolHealthCheck(env);
            break;
          case 'get_version':
            result = await toolGetVersion(env);
            break;
          case 'get_fallback_chain':
            result = await toolGetFallbackChain(env);
            break;
          default:
            return rpcError(id!, -32602, `Unknown tool: ${toolName}`);
        }
        return rpcResult(id!, result);
      } catch (e: unknown) {
        return rpcError(id!, -32603, `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    case 'resources/list':
      return rpcResult(id!, {
        resources: [
          {
            uri: 'freellmapi://models',
            name: 'Available Models',
            description: 'All available LLM models',
            mimeType: 'application/json',
          },
          {
            uri: 'freellmapi://providers',
            name: 'Provider Status',
            description: 'All configured providers and their health',
            mimeType: 'application/json',
          },
        ],
      });

    case 'resources/read': {
      const uri = params?.uri as string | undefined;
      if (uri === 'freellmapi://models') {
        const result = await toolListModels(env, {});
        const content = (result.content as Array<Record<string, unknown>>)[0];
        return rpcResult(id!, { contents: [{ uri, mimeType: 'application/json', ...content }] });
      }
      if (uri === 'freellmapi://providers') {
        const result = await toolListProviders(env);
        const content = (result.content as Array<Record<string, unknown>>)[0];
        return rpcResult(id!, { contents: [{ uri, mimeType: 'application/json', ...content }] });
      }
      return rpcError(id!, -32602, `Unknown resource: ${uri}`);
    }

    case 'prompts/list':
      return rpcResult(id!, {
        prompts: [
          {
            name: 'summarize',
            description: 'Summarize a text using the LLM router',
            arguments: [{ name: 'text', description: 'Text to summarize', required: true }],
          },
          {
            name: 'translate',
            description: 'Translate text to a target language',
            arguments: [
              { name: 'text', description: 'Text to translate', required: true },
              { name: 'language', description: 'Target language', required: true },
            ],
          },
        ],
      });

    case 'prompts/get': {
      const promptName = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown> | undefined) || {};
      if (promptName === 'summarize') {
        return rpcResult(id!, {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Please summarize the following text concisely:\n\n${args.text || ''}` },
          }],
        });
      }
      if (promptName === 'translate') {
        return rpcResult(id!, {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Translate the following text to ${args.language || 'English'}:\n\n${args.text || ''}` },
          }],
        });
      }
      return rpcError(id!, -32602, `Unknown prompt: ${promptName}`);
    }

    default:
      return rpcError(id!, -32601, `Method not found: ${method}`);
  }
}

// ============= HTTP 端点 =============

/**
 * POST /mcp — MCP Streamable HTTP 端点
 *
 * 认证:支持两种方式(自动检测)
 * 1. 统一 API Token (Authorization: Bearer freellmapi-xxx) — 用于 chat 等代理工具
 * 2. Dashboard Session (Cookie 或 Bearer JWT) — 用于管理工具
 *
 * 客户端无需认证即可 initialize 和 tools/list
 * 调用具体工具时按需验证权限
 */
mcpRoute.post('/', async (c) => {
  const body = await c.req.json<JsonRpcRequest | JsonRpcRequest[]>().catch(() => null);
  if (!body) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // 尝试两种认证(都不要求,具体工具调用时检查)
  const userToken = await authenticateUserToken(c).catch(() => null);

  let dashboardSession: { accountId: number; email: string } | null = null;
  try {
    // 尝试 dashboard 认证 (cookie 或 Bearer JWT)
    const { verifyDashboardSession } = await import('../lib/auth');
    const token =
      c.req.header('Cookie')?.match(/fl_session=([^;]+)/)?.[1] ||
      c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token) {
      dashboardSession = await verifyDashboardSession(token, c.env.JWT_SECRET);
    }
  } catch { /* ignore */ }

  // 处理批量请求
  const requests = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];

  for (const req of requests) {
    if (!req.jsonrpc || req.jsonrpc !== '2.0') {
      responses.push(rpcError((req.id as number | string) || 0, -32600, 'Invalid Request'));
      continue;
    }
    const resp = await handleMcpRequest(
      c.env,
      req,
      userToken?.id || null,
      dashboardSession
    );
    if (resp) responses.push(resp);
  }

  // 通知（无 id 的请求）不需要返回响应体
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  // 批量请求返回数组，单个请求返回对象
  const responseBody = Array.isArray(body) ? responses : responses[0];
  return c.json(responseBody, 200, {
    'Content-Type': 'application/json',
    'Mcp-Session-Id': `freellmapi-${Date.now()}`,
  });
});

/**
 * GET /mcp — SSE 端点 (服务器推送，可选)
 * 用于服务器向客户端发送通知
 */
mcpRoute.get('/', async (c) => {
  // 简单的 keepalive SSE — 实际通知可以通过此通道推送
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => controller.enqueue(encoder.encode(data));

      // 发送初始 keepalive
      send(': keepalive\n\n');

      // 每 30 秒发一次 keepalive
      const interval = setInterval(() => {
        try {
          send(': keepalive\n\n');
        } catch {
          clearInterval(interval);
        }
      }, 30000);

      // 清理 (Cloudflare Workers 没有直接的 cleanup 事件,用 AbortSignal)
      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(interval);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

/**
 * DELETE /mcp — 结束会话
 */
mcpRoute.delete('/', async (c) => {
  return c.json({ ok: true, message: 'Session terminated' });
});
