// ============================================================
// mcp-admin — Cloudflare Worker (TypeScript)
// MCP server for managing LLM API keys, tokens, fallback chain,
// and system settings via the backend API.
// ============================================================

// ---- Environment & Globals ----

export interface Env {
  API_BASE: string;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = {
  name: "mcp-admin",
  version: "1.0.0",
};

const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---- Types ----

interface RPCRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
  jsonrpc?: string;
}

interface RPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolInputSchemaProperty {
  type: string;
  description: string;
}

interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolInputSchemaProperty>;
  required?: string[];
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface FallbackEntry {
  platform: string;
  model: string;
  key_id?: number;
  enabled?: number;
}

interface BackendFetchOptions {
  method: string;
  body?: unknown;
  timeout?: number;
}

interface BackendResponse {
  status: number;
  data: unknown;
}

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

interface ReadResourceResult {
  contents: ResourceContents[];
  error?: never;
}

interface ReadResourceError {
  error: string;
  contents?: never;
}

// ---- Error Classes ----

class BackendError extends Error {
  public status: number;
  public data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.data = data;
  }
}

// ---- Helpers ----

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function backendFetch(
  apiBase: string,
  authToken: string,
  path: string,
  options: BackendFetchOptions,
): Promise<BackendResponse> {
  const url = `${apiBase}${path}`;
  const timeout = options.timeout ?? 10_000;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    Accept: "application/json",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await resp.text();
    let data: unknown;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      data = text;
    }

    return { status: resp.status, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new BackendError(`Request timed out after ${timeout}ms`, 504);
    }
    console.error("[backendFetch] Error:", err);
    throw new BackendError(`Backend request failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

function textResult(text: string, isError: boolean = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function backendResult(status: number, data: unknown): ToolResult {
  const isError = status < 200 || status >= 400;
  const text = JSON.stringify(
    isError
      ? { success: false, httpStatus: status, error: data }
      : { success: true, httpStatus: status, data },
    null,
    2,
  );
  return textResult(text, isError);
}

// ---- Tool Handlers ----

async function toolAddKey(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const platform = String(args.platform ?? "");
  const key = String(args.key ?? "");
  const label = args.label !== undefined ? String(args.label) : undefined;
  const customBaseUrl = args.customBaseUrl !== undefined ? String(args.customBaseUrl) : undefined;
  const customModels = args.customModels !== undefined ? String(args.customModels) : undefined;

  if (!platform || !key) {
    return textResult('Error: "platform" and "key" are required parameters.', true);
  }

  const body: Record<string, unknown> = { platform, key };
  if (label !== undefined) body.label = label;
  if (customBaseUrl !== undefined) body.customBaseUrl = customBaseUrl;
  if (customModels !== undefined) body.customModels = customModels;

  const { status, data } = await backendFetch(apiBase, token, "/api/keys", {
    method: "POST",
    body,
  });
  return backendResult(status, data);
}

async function toolRemoveKey(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/keys/${id}`, {
    method: "DELETE",
  });
  return backendResult(status, data);
}

async function toolEnableKey(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/keys/${id}`, {
    method: "PATCH",
    body: { enabled: 1 },
  });
  return backendResult(status, data);
}

async function toolDisableKey(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/keys/${id}`, {
    method: "PATCH",
    body: { enabled: 0 },
  });
  return backendResult(status, data);
}

async function toolCheckKeyHealth(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/keys/${id}/check`, {
    method: "POST",
  });
  return backendResult(status, data);
}

async function toolUpdateFallback(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const entries = args.entries;
  if (!Array.isArray(entries)) {
    return textResult('Error: "entries" must be an array of { platform, model } objects.', true);
  }

  const normalized: FallbackEntry[] = entries.map(
    (entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Entry at index ${index} is not an object.`);
      }
      const e = entry as Record<string, unknown>;
      const platform = String(e.platform ?? "");
      const model = String(e.model ?? "");
      if (!platform || !model) {
        throw new Error(`Entry at index ${index} is missing required "platform" or "model".`);
      }
      const result: FallbackEntry = { platform, model };
      if (e.key_id !== undefined && e.key_id !== null) {
        result.key_id = Number(e.key_id);
      }
      if (e.enabled !== undefined && e.enabled !== null) {
        result.enabled = Number(e.enabled);
      }
      return result;
    },
  );

  const { status, data } = await backendFetch(apiBase, token, "/api/fallback", {
    method: "PUT",
    body: { entries: normalized },
  });
  return backendResult(status, data);
}

async function toolListTokens(
  apiBase: string,
  token: string,
): Promise<ToolResult> {
  const { status, data } = await backendFetch(apiBase, token, "/api/tokens", {
    method: "GET",
  });
  return backendResult(status, data);
}

async function toolRegenerateToken(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/tokens/${id}/regenerate`, {
    method: "POST",
  });
  return backendResult(status, data);
}

async function toolGetSettings(
  apiBase: string,
  token: string,
): Promise<ToolResult> {
  const { status, data } = await backendFetch(apiBase, token, "/api/settings/providers", {
    method: "GET",
  });
  return backendResult(status, data);
}

async function toolSyncModels(
  apiBase: string,
  token: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    return textResult('Error: "id" must be a positive number.', true);
  }

  const { status, data } = await backendFetch(apiBase, token, `/api/keys/${id}/sync-models`, {
    method: "POST",
  });
  return backendResult(status, data);
}

// ---- Resources ----

async function readResource(
  apiBase: string,
  token: string,
  uri: string,
): Promise<ReadResourceResult | ReadResourceError> {
  let path: string;
  switch (uri) {
    case "mcp-admin://keys":
      path = "/api/keys";
      break;
    case "mcp-admin://tokens":
      path = "/api/tokens";
      break;
    case "mcp-admin://settings":
      path = "/api/settings/providers";
      break;
    case "mcp-admin://fallback-chain":
      path = "/api/fallback";
      break;
    default:
      return { error: `Unknown resource URI: ${uri}` };
  }

  const { status, data } = await backendFetch(apiBase, token, path, { method: "GET" });
  const text = JSON.stringify(
    status >= 200 && status < 400 ? data : { error: data, httpStatus: status },
    null,
    2,
  );

  return {
    contents: [{ uri, mimeType: "application/json", text }],
  };
}

// ---- Tool / Resource Definitions ----

const TOOLS: ToolDefinition[] = [
  {
    name: "add_key",
    description:
      'Add a new API key for a specific LLM provider platform. The key is encrypted at rest by the backend. A health check and model sync are triggered automatically in the background after insertion. The full plaintext key is returned only once in the response \u2014 store it securely if needed.',
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description:
            'The provider platform identifier. Supported values: groq, google, cerebras, opencode, mistral, openrouter, github, cloudflare, cohere, zai, nvidia, huggingface, ollama, kilo, pollinations, llm7, ovh, aihorde, bailian, custom.',
        },
        key: {
          type: "string",
          description: 'The API key string from the provider. Must be at least 8 characters.',
        },
        label: {
          type: "string",
          description: 'Optional human-readable label for this key (e.g. "Production Groq key").',
        },
        customBaseUrl: {
          type: "string",
          description:
            'Required when platform is "custom". The base URL of the custom OpenAI-compatible endpoint.',
        },
        customModels: {
          type: "string",
          description:
            'Comma-separated list of model names for custom providers (e.g. "gpt-4o,claude-3-sonnet"). Only used when platform is "custom".',
        },
      },
      required: ["platform", "key"],
    },
  },
  {
    name: "remove_key",
    description: "Permanently delete an API key by its numeric ID. This action cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the API key to delete.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "enable_key",
    description:
      "Enable a previously disabled API key. The key will become eligible for routing again.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the API key to enable.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "disable_key",
    description:
      "Disable an API key without deleting it. Disabled keys are excluded from routing but retain their data.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the API key to disable.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "check_key_health",
    description:
      "Trigger an asynchronous health check for a specific API key. The backend pings the provider and updates the health status (healthy, rate_limited, invalid, or error). The check runs in the background; query the key again after a few seconds to see the updated status.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the API key to health-check.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_fallback",
    description:
      "Update the fallback chain \u2014 the ordered list of (platform, model) pairs the router tries when the primary model fails or is unavailable. This replaces the entire chain. Each entry has a position determined by its index in the array (0 = highest priority).",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          description: "Ordered array of fallback entries. Position is determined by array index.",
          items: {
            type: "object",
            properties: {
              platform: {
                type: "string",
                description: "The provider platform (e.g. groq, google).",
              },
              model: {
                type: "string",
                description: 'The model name to fall back to (e.g. "llama-3.3-70b").',
              },
              key_id: {
                type: "number",
                description: "Optional: pin this entry to a specific API key ID.",
              },
              enabled: {
                type: "number",
                description:
                  "Whether this entry is active. 1 = enabled (default), 0 = disabled.",
              },
            },
            required: ["platform", "model"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "list_tokens",
    description:
      "List all user API tokens (client-facing keys used to call /v1/* endpoints). Returns token hints, labels, enabled status, creation time, last used time, and request count. Plaintext tokens are never returned in the list.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "regenerate_token",
    description:
      "Regenerate a user API token by its ID. The old token becomes invalid immediately. The new plaintext token is returned once \u2014 store it securely. Useful when a token is compromised.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the user token to regenerate.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_settings",
    description:
      "Retrieve the full system settings: all configured provider platforms with their models, key counts, enabled status, and sort order. This is the master view of the LLM catalog.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sync_models",
    description:
      "Trigger a model sync for a specific API key. The backend fetches the latest model list from the provider and adds any new models to the catalog. Returns the total models found, newly added count, and skipped (already existing) count.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the API key whose models should be synced.",
        },
      },
      required: ["id"],
    },
  },
];

const RESOURCES: ResourceDefinition[] = [
  {
    uri: "mcp-admin://keys",
    name: "API Keys",
    description:
      "All registered API keys with health status and enabled state (hints only, no plaintext).",
    mimeType: "application/json",
  },
  {
    uri: "mcp-admin://tokens",
    name: "User Tokens",
    description:
      "All user-facing API tokens with usage statistics (hints only, no plaintext).",
    mimeType: "application/json",
  },
  {
    uri: "mcp-admin://settings",
    name: "System Settings",
    description: "Full provider and model catalog configuration.",
    mimeType: "application/json",
  },
  {
    uri: "mcp-admin://fallback-chain",
    name: "Fallback Chain",
    description: "The ordered fallback model chain used when primary routing fails.",
    mimeType: "application/json",
  },
];

// ---- JSON-RPC Helpers ----

function rpcResult(id: number | string, result: unknown): RPCResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string, code: number, message: string): RPCResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---- MCP Request Handler ----

async function handleMcpRequest(
  env: Env,
  req: RPCRequest,
  authToken: string | null,
): Promise<RPCResponse | null> {
  const apiBase = env.API_BASE || "https://api.zjkl0330.dpdns.org";
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const toolName = String(params?.name ?? "");
      const args = (params?.arguments as Record<string, unknown>) || {};

      if (!authToken) {
        return rpcError(
          id,
          RPC_ERROR_CODES.INVALID_PARAMS,
          "Authentication required: pass a dashboard JWT via the Authorization: Bearer header to call tools.",
        );
      }

      try {
        let result: ToolResult;
        switch (toolName) {
          case "add_key":
            result = await toolAddKey(apiBase, authToken, args);
            break;
          case "remove_key":
            result = await toolRemoveKey(apiBase, authToken, args);
            break;
          case "enable_key":
            result = await toolEnableKey(apiBase, authToken, args);
            break;
          case "disable_key":
            result = await toolDisableKey(apiBase, authToken, args);
            break;
          case "check_key_health":
            result = await toolCheckKeyHealth(apiBase, authToken, args);
            break;
          case "update_fallback":
            result = await toolUpdateFallback(apiBase, authToken, args);
            break;
          case "list_tokens":
            result = await toolListTokens(apiBase, authToken);
            break;
          case "regenerate_token":
            result = await toolRegenerateToken(apiBase, authToken, args);
            break;
          case "get_settings":
            result = await toolGetSettings(apiBase, authToken);
            break;
          case "sync_models":
            result = await toolSyncModels(apiBase, authToken, args);
            break;
          default:
            return rpcError(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown tool: "${toolName}"`);
        }
        return rpcResult(id, result);
      } catch (e) {
        console.error("[handleMcpRequest] Tool execution error:", e);
        const message = e instanceof Error ? e.message : String(e);
        return rpcError(id, RPC_ERROR_CODES.INTERNAL_ERROR, `Tool execution failed: ${message}`);
      }
    }

    case "resources/list":
      return rpcResult(id, {
        resources: RESOURCES.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      });

    case "resources/read": {
      const uri = String(params?.uri ?? "");

      if (!authToken) {
        return rpcError(
          id,
          RPC_ERROR_CODES.INVALID_PARAMS,
          "Authentication required: pass a dashboard JWT via the Authorization: Bearer header to read resources.",
        );
      }

      const result = await readResource(apiBase, authToken, uri);
      if ("error" in result) {
        return rpcError(id, RPC_ERROR_CODES.INVALID_PARAMS, result.error);
      }
      return rpcResult(id, result);
    }

    default:
      return rpcError(id, RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---- CORS ----

function applyCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin || origin === "null" || origin === "*") {
    return response;
  }

  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", origin);
  newResponse.headers.set("Vary", "Origin");
  newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  newResponse.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, Mcp-Session-Id",
  );
  newResponse.headers.set("Access-Control-Max-Age", "86400");
  return newResponse;
}

function corsPreflight(request: Request): Response {
  const response = new Response(null, { status: 204 });
  return applyCors(response, request);
}

// ---- Session ID ----

function generateSessionId(): string {
  return `mcp-admin-${crypto.randomUUID()}`;
}

// ---- HTTP Handlers ----

async function handlePost(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      error: {
        code: RPC_ERROR_CODES.INVALID_REQUEST,
        message: "Content-Type must be application/json",
      },
    });
    return applyCors(
      new Response(body, { status: 400, headers: { "Content-Type": "application/json" } }),
      request,
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: "Invalid JSON in request body" },
    });
    return applyCors(
      new Response(body, { status: 400, headers: { "Content-Type": "application/json" } }),
      request,
    );
  }

  const authToken = extractBearerToken(request.headers.get("Authorization"));
  const isBatch = Array.isArray(parsed);
  const requests: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
  const responses: RPCResponse[] = [];

  for (const reqUntyped of requests) {
    const req = reqUntyped as RPCRequest | null;
    if (
      !req ||
      typeof req !== "object" ||
      req.jsonrpc !== "2.0" ||
      typeof req.method !== "string"
    ) {
      responses.push(
        rpcError(
          req?.id ?? 0,
          RPC_ERROR_CODES.INVALID_REQUEST,
          "Invalid JSON-RPC 2.0 request: missing jsonrpc or method",
        ),
      );
      continue;
    }

    const resp = await handleMcpRequest(env, req, authToken);
    if (resp) {
      responses.push(resp);
    }
  }

  if (responses.length === 0) {
    return applyCors(new Response(null, { status: 202 }), request);
  }

  const responseBody = isBatch ? responses : responses[0];
  const body = JSON.stringify(responseBody);
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Mcp-Session-Id": generateSessionId(),
    },
  });
  return applyCors(response, request);
}

function handleGet(request: Request): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string): void => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          clearInterval(intervalId);
        }
      };

      send(": keepalive\n\n");

      const intervalId = setInterval(() => {
        send(": keepalive\n\n");
      }, 30_000);

      request.signal?.addEventListener("abort", () => {
        clearInterval(intervalId);
        try {
          controller.close();
        } catch {
          // ignore close errors when stream is already cancelled
        }
      });
    },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Mcp-Session-Id": generateSessionId(),
    },
  });
  return applyCors(response, request);
}

function handleDelete(request: Request): Response {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    result: { ok: true, message: "Session terminated" },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  return applyCors(response, request);
}

// ---- Worker Entry Point ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === "/" || url.pathname === "/mcp") {
      switch (request.method) {
        case "POST":
          return handlePost(request, env);
        case "GET":
          return handleGet(request);
        case "DELETE":
          return handleDelete(request);
        default: {
          const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: RPC_ERROR_CODES.INVALID_REQUEST,
              message: `Method ${request.method} not allowed`,
            },
          });
          return applyCors(
            new Response(body, {
              status: 405,
              headers: {
                "Content-Type": "application/json",
                Allow: "GET, POST, DELETE, OPTIONS",
              },
            }),
            request,
          );
        }
      }
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return applyCors(
        new Response(
          JSON.stringify({
            ok: true,
            server: SERVER_INFO.name,
            version: SERVER_INFO.version,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        request,
      );
    }

    // 404 for everything else
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      error: {
        code: RPC_ERROR_CODES.INVALID_REQUEST,
        message: `Not found: ${url.pathname}. Use POST / for MCP requests.`,
      },
    });
    return applyCors(
      new Response(body, { status: 404, headers: { "Content-Type": "application/json" } }),
      request,
    );
  },
};