// MCP (Model Context Protocol) endpoint
// POST /mcp - MCP protocol handler
// GET /mcp - MCP protocol info

import { DB } from '../../lib/db';
import { Cache } from '../../lib/cache';
import { selectRoute } from '../../lib/router';
import { generateChatId, getTimestamp, decryptAESGCM } from '../../lib/crypto';
import type { Env, ChatMessage, ChatRequest } from '../../types';

interface MCPParams {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
}

// MCP Protocol version
const MCP_VERSION = '2025-03-26';
const SERVER_INFO = {
  name: 'freellmapi-mcp',
  version: '1.0.0',
  description: 'FreeLLMAPI MCP server - Unified access to multiple LLM providers',
};

// Available MCP tools
const AVAILABLE_TOOLS = [
  {
    name: 'chat',
    description: 'Send a chat completion request to any supported model',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID to use (e.g. gpt-4, claude-3-opus, auto)' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
          description: 'Array of conversation messages',
        },
        stream: { type: 'boolean', description: 'Whether to stream the response', default: false },
        temperature: { type: 'number', description: 'Sampling temperature (0-2)', default: 1.0 },
        max_tokens: { type: 'number', description: 'Maximum tokens to generate' },
      },
      required: ['model', 'messages'],
    },
  },
  {
    name: 'models',
    description: 'List available models',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional provider filter' },
      },
    },
  },
  {
    name: 'embed',
    description: 'Generate embeddings for text input',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Embedding model ID' },
        input: {
          oneOf: [
            { type: 'string', description: 'Single text input' },
            { type: 'array', items: { type: 'string' }, description: 'Multiple text inputs' },
          ],
        },
      },
      required: ['model', 'input'],
    },
  },
  {
    name: 'route_info',
    description: 'Get routing information for a model',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID to check routing for' },
      },
      required: ['model'],
    },
  },
];

// ============================================================
// MCP Protocol Handlers
// ============================================================

/**
 * Handle GET /mcp - Return MCP server info
 */
export async function handleMCPInfo(params: MCPParams): Promise<Response> {
  const response = {
    protocol_version: MCP_VERSION,
    server_info: SERVER_INFO,
    capabilities: {
      tools: {
        list: true,
        call: true,
        available: AVAILABLE_TOOLS.length,
      },
      resources: {},
      prompts: {},
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'MCP-Version': MCP_VERSION,
    },
  });
}

/**
 * Handle POST /mcp - Process MCP protocol requests
 */
export async function handleMCPRequest(params: MCPParams): Promise<Response> {
  const { request, env, ctx, db, cache } = params;

  let mcpRequest: MCPMessage;
  try {
    mcpRequest = await request.json<MCPMessage>();
  } catch {
    return mcpError('ParseError', 'Invalid JSON in request body');
  }

  // Validate protocol version
  if (mcpRequest.protocol_version && mcpRequest.protocol_version !== MCP_VERSION) {
    return mcpError(
      'ProtocolVersionError',
      `Unsupported protocol version: ${mcpRequest.protocol_version}. Supported: ${MCP_VERSION}`
    );
  }

  switch (mcpRequest.method) {
    case 'initialize':
      return handleInitialize(mcpRequest);

    case 'ping':
      return mcpResult(mcpRequest.id, { status: 'ok', timestamp: new Date().toISOString() });

    case 'tools/list':
      return handleToolsList(mcpRequest);

    case 'tools/call':
      return handleToolsCall(mcpRequest, params);

    case 'resources/list':
      return mcpResult(mcpRequest.id, { resources: [] });

    default:
      return mcpError(
        'MethodNotFound',
        `Unknown method: ${mcpRequest.method}`
      );
  }
}

// ============================================================
// MCP Method Handlers
// ============================================================

/**
 * Handle initialize request.
 */
function handleInitialize(request: MCPMessage): Response {
  const clientInfo = request.params?.client_info || {};
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocol_version: MCP_VERSION,
        server_info: SERVER_INFO,
        capabilities: {
          tools: {
            list: true,
            call: true,
            available: AVAILABLE_TOOLS.length,
          },
        },
        client_info: clientInfo,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'MCP-Version': MCP_VERSION },
    }
  );
}

/**
 * Handle tools/list request.
 */
function handleToolsList(request: MCPMessage): Response {
  return mcpResult(request.id, { tools: AVAILABLE_TOOLS });
}

/**
 * Handle tools/call request.
 */
async function handleToolsCall(request: MCPMessage, params: MCPParams): Promise<Response> {
  const { env, ctx, db, cache } = params;
  const toolName = request.params?.name;
  const toolArgs = (request.params?.arguments || {}) as Record<string, unknown>;

  if (!toolName) {
    return mcpError('InvalidParams', 'Missing tool name');
  }

  try {
    switch (toolName) {
      case 'chat':
        return await handleToolChat(request.id ?? 0, toolArgs, params);
      case 'models':
        return await handleToolModels(request.id ?? 0, toolArgs, params);
      case 'embed':
        return await handleToolEmbed(request.id ?? 0, toolArgs, params);
      case 'route_info':
        return await handleToolRouteInfo(request.id ?? 0, toolArgs, params);
      default:
        return mcpError('ToolNotFound', `Unknown tool: ${toolName}`);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return mcpError('InternalError', errorMessage, request.id);
  }
}

/**
 * Execute the 'chat' tool.
 */
async function handleToolChat(
  id: string | number,
  args: Record<string, unknown>,
  params: MCPParams
): Promise<Response> {
  const { env, ctx, db, cache } = params;

  const model = args.model as string;
  const messages = args.messages as Array<{ role: string; content: string }>;
  const stream = args.stream as boolean | undefined;
  const temperature = args.temperature as number | undefined;
  const maxTokens = args.max_tokens as number | undefined;

  if (!model || !messages) {
    return mcpError('InvalidParams', 'Missing required parameters: model, messages', id);
  }

  const route = await selectRoute(db, cache, model);
  if (!route) {
    return mcpError('RouteNotFound', `No available route for model: ${model}`, id);
  }

  const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

  const chatParams: Record<string, unknown> = {
    model: route.model.model_id,
    messages: messages as ChatMessage[],
    stream: stream ?? false,
    temperature: temperature ?? 1.0,
    max_tokens: maxTokens,
  };

  const providerResponse = await fetch(
    `${route.key.base_url || `https://api.${route.provider}.com/v1`}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyValue}`,
      },
      body: JSON.stringify(chatParams),
    }
  );

  if (!providerResponse.ok) {
    return mcpError('ProviderError', `Provider returned ${providerResponse.status}: ${await providerResponse.text()}`, id);
  }

  const providerData = await providerResponse.json() as Record<string, unknown>;

  // Record analytics (fire-and-forget)
  const usage = (providerData.usage as { prompt_tokens?: number; completion_tokens?: number }) || {};
  ctx.waitUntil(
    db.recordAnalytics({
      endpoint: '/mcp/chat',
      provider: route.provider,
      model: route.model.model_id,
      latency_ms: 0,
      tokens_prompt: usage.prompt_tokens || 0,
      tokens_completion: usage.completion_tokens || 0,
      status_code: 200,
      user_id: null,
    })
  );

  const choices = providerData.choices as Array<Record<string, unknown>> | undefined;
  const content = choices?.[0]?.message
    ? (choices[0].message as Record<string, unknown>).content as string
    : '';

  return mcpResult(id, {
    content: [
      {
        type: 'text',
        text: content || '',
      },
    ],
    model: route.model.model_id,
    provider: route.provider,
    usage: providerData.usage,
  });
}

/**
 * Execute the 'models' tool.
 */
async function handleToolModels(
  id: string | number,
  args: Record<string, unknown>,
  params: MCPParams
): Promise<Response> {
  const { db } = params;
  const provider = args.provider as string | undefined;
  const models = await db.getModels(provider);

  return mcpResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(models.map(m => ({
          id: m.model_id,
          provider: m.provider,
          display_name: m.display_name,
          context_window: m.context_window,
          supports_vision: !!m.supports_vision,
          supports_tools: !!m.supports_tools,
          supports_streaming: !!m.supports_streaming,
          intelligence_rank: m.intelligence_rank,
          speed_rank: m.speed_rank,
        })), null, 2),
      },
    ],
    count: models.length,
  });
}

/**
 * Execute the 'embed' tool.
 */
async function handleToolEmbed(
  id: string | number,
  args: Record<string, unknown>,
  params: MCPParams
): Promise<Response> {
  const { env, db, cache } = params;
  const model = args.model as string;
  const input = args.input as string | string[];

  if (!model || !input) {
    return mcpError('InvalidParams', 'Missing required parameters: model, input', id);
  }

  const route = await selectRoute(db, cache, model);
  if (!route) {
    return mcpError('RouteNotFound', `No available route for model: ${model}`, id);
  }

  const apiKeyValue = await decryptAESGCM(route.key.key_data, route.key.key_iv, route.key.key_tag, env.ENCRYPTION_KEY);

  const providerResponse = await fetch(
    `${route.key.base_url || `https://api.${route.provider}.com/v1`}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyValue}`,
      },
      body: JSON.stringify({
        model: route.model.model_id,
        input,
      }),
    }
  );

  if (!providerResponse.ok) {
    return mcpError('ProviderError', `Provider returned ${providerResponse.status}`, id);
  }

  const providerData = await providerResponse.json() as Record<string, unknown>;

  return mcpResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          object: 'list',
          data: (providerData.data as Array<Record<string, unknown>> || []).map((d, i) => ({
            index: i,
            vector: `[${(d.embedding as number[]).length} dimensions]`,
          })),
          model: route.model.model_id,
        }, null, 2),
      },
    ],
    dimensions: ((providerData.data as Array<Record<string, unknown>>)?.[0]?.embedding as number[])?.length || 0,
    model: route.model.model_id,
  });
}

/**
 * Execute the 'route_info' tool.
 */
async function handleToolRouteInfo(
  id: string | number,
  args: Record<string, unknown>,
  params: MCPParams
): Promise<Response> {
  const { db, cache } = params;
  const model = args.model as string;

  if (!model) {
    return mcpError('InvalidParams', 'Missing required parameter: model', id);
  }

  const route = await selectRoute(db, cache, model);
  if (!route) {
    return mcpResult(id, {
      content: [{ type: 'text', text: `No route available for model: ${model}` }],
      available: false,
    });
  }

  return mcpResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          provider: route.provider,
          model_id: route.model.model_id,
          display_name: route.model.display_name,
          context_window: route.model.context_window,
          supports_vision: !!route.model.supports_vision,
          supports_tools: !!route.model.supports_tools,
          supports_streaming: !!route.model.supports_streaming,
          intelligence_rank: route.model.intelligence_rank,
          speed_rank: route.model.speed_rank,
        }, null, 2),
      },
    ],
    available: true,
    provider: route.provider,
  });
}

// ============================================================
// MCP Response Helpers
// ============================================================

interface MCPMessage {
  jsonrpc?: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
  protocol_version?: string;
}

/**
 * Create a successful MCP result response.
 */
function mcpResult(id: string | number | undefined, data: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      result: data,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'MCP-Version': MCP_VERSION },
    }
  );
}

/**
 * Create an MCP error response.
 */
function mcpError(code: string, message: string, id?: string | number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: getErrorCode(code),
        message,
        data: { type: code },
      },
    }),
    {
      status: 200, // MCP errors are returned as 200 with error payload
      headers: { 'Content-Type': 'application/json', 'MCP-Version': MCP_VERSION },
    }
  );
}

/**
 * Map MCP error codes to numeric values.
 */
function getErrorCode(type: string): number {
  const codes: Record<string, number> = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    ProtocolVersionError: -32000,
    ToolNotFound: -32001,
    RouteNotFound: -32002,
    ProviderError: -32003,
  };
  return codes[type] || -32603;
}