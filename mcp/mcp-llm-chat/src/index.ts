// ===== Type Definitions =====

export interface Env {
  API_BASE: string;
}

interface MCPRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPError {
  code: number;
  message: string;
}

interface MCPResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: MCPError;
}

interface BackendResponse {
  status: number;
  data: Record<string, unknown> | null;
  headers: Headers;
}

interface ChatArgs {
  message: string;
  system?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

interface ChatStreamArgs {
  message: string;
  system?: string;
  model?: string;
  max_tokens?: number;
}

interface ListModelsArgs {
  platform?: string;
}

interface GetModelInfoArgs {
  model: string;
}

interface CompareModelsArgs {
  message: string;
  models: string[];
  system?: string;
}

interface ModelInfo {
  model_name?: string;
  name?: string;
  platform?: string;
  context_window?: number;
  supports_vision?: number;
  supports_tools?: number;
  [key: string]: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgumentDefinition[];
}

interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

interface ToolResultContent {
  type: string;
  text: string;
}

interface ModelComparisonResult {
  model: string;
  content: string | null;
  error?: string;
  platform?: string;
  latency?: string;
  tokens?: number;
}

interface ChatMessage {
  role: string;
  content: string;
}

// ===== Constants =====

const MCP_PROTOCOL_VERSION = "2025-06-18";

const TOOLS: ToolDefinition[] = [
  {
    name: "chat",
    description:
      "Send a chat completion request to the LLM router. Automatically selects the best available model and falls back on failure.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The user message" },
        system: { type: "string", description: "Optional system prompt" },
        model: {
          type: "string",
          description: 'Model name or "auto". Default: auto',
        },
        max_tokens: {
          type: "number",
          description: "Max output tokens. Default: 8192",
        },
        temperature: {
          type: "number",
          description: "Sampling temperature (0-2)",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "chat_stream",
    description:
      "Send a streaming chat completion request. Returns the full response text after streaming completes.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The user message" },
        system: { type: "string", description: "Optional system prompt" },
        model: {
          type: "string",
          description: 'Model name or "auto". Default: auto',
        },
        max_tokens: {
          type: "number",
          description: "Max output tokens. Default: 8192",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_models",
    description:
      "List all available LLM models, optionally filtered by platform.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", description: "Filter by platform" },
      },
    },
  },
  {
    name: "get_model_info",
    description: "Get detailed information about a specific model.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model name" },
      },
      required: ["model"],
    },
  },
  {
    name: "compare_models",
    description:
      "Compare responses from multiple models for the same prompt. Sends the same message to each model in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The prompt to send" },
        models: {
          type: "array",
          items: { type: "string" },
          description: "List of model names to compare",
        },
        system: { type: "string", description: "Optional system prompt" },
      },
      required: ["message", "models"],
    },
  },
];

const PROMPTS: PromptDefinition[] = [
  {
    name: "summarize",
    description: "Summarize text using the LLM router",
    arguments: [
      { name: "text", description: "Text to summarize", required: true },
    ],
  },
  {
    name: "translate",
    description: "Translate text to a target language",
    arguments: [
      { name: "text", description: "Text to translate", required: true },
      { name: "language", description: "Target language", required: true },
    ],
  },
  {
    name: "explain_code",
    description: "Explain a code snippet",
    arguments: [
      { name: "code", description: "Code to explain", required: true },
    ],
  },
  {
    name: "review_code",
    description: "Review code for bugs and improvements",
    arguments: [
      { name: "code", description: "Code to review", required: true },
    ],
  },
];

// ===== Utility Functions =====

function rpcResult(id: number | string, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function extractToken(req: MCPRequest | Request): string | null {
  if (req instanceof Request) {
    const auth = req.headers.get("Authorization");
    if (auth) {
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    const xKey = req.headers.get("x-api-key");
    if (xKey) return xKey.trim();
  }
  return null;
}

// ===== Backend Communication =====

async function callBackend(
  apiBase: string,
  token: string,
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {}
): Promise<BackendResponse> {
  const url = `${apiBase}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const resp = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const data: Record<string, unknown> | null = await resp
    .json()
    .catch(() => null);
  return { status: resp.status, data, headers: resp.headers };
}

// ===== Tool Implementations =====

async function toolChat(
  apiBase: string,
  token: string,
  args: ChatArgs
): Promise<ToolResult> {
  if (!args.message) {
    return {
      content: [{ type: "text", text: "Error: 'message' is required" }],
      isError: true,
    };
  }

  const messages: ChatMessage[] = [];
  if (args.system) messages.push({ role: "system", content: args.system });
  messages.push({ role: "user", content: args.message });

  const body: Record<string, unknown> = {
    model: args.model || "auto",
    messages,
    stream: false,
    max_tokens: args.max_tokens || 8192,
  };
  if (args.temperature !== undefined) body.temperature = args.temperature;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await callBackend(apiBase, token, "/v1/chat/completions", {
      method: "POST",
      body,
      signal: controller.signal,
    });

    if (resp.status !== 200) {
      return {
        content: [
          {
            type: "text",
            text: `Error (${resp.status}): ${JSON.stringify(resp.data).slice(0, 500)}`,
          },
        ],
        isError: true,
      };
    }

    const choices = resp.data?.choices as
      | Array<{ message: { content: string } }>
      | undefined;
    const content = choices?.[0]?.message?.content || "(empty)";
    const usage = resp.data?.usage as { total_tokens?: number } | undefined;

    const platform = resp.headers.get("X-Platform") || "?";
    const model = resp.headers.get("X-Model") || "?";
    const latency = resp.headers.get("X-Latency") || "?";
    const tokens = usage?.total_tokens ?? "N/A";

    const meta = `Platform: ${platform} | Model: ${model} | Latency: ${latency}ms | Tokens: ${tokens}`;

    return {
      content: [
        { type: "text", text: content },
        { type: "text", text: `\n---\n${meta}` },
      ],
    };
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[toolChat] Error: ${errMsg}`);
    return { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function toolChatStream(
  apiBase: string,
  token: string,
  args: ChatStreamArgs
): Promise<ToolResult> {
  if (!args.message) {
    return {
      content: [{ type: "text", text: "Error: 'message' is required" }],
      isError: true,
    };
  }

  const messages: ChatMessage[] = [];
  if (args.system) messages.push({ role: "system", content: args.system });
  messages.push({ role: "user", content: args.message });

  const body: Record<string, unknown> = {
    model: args.model || "auto",
    messages,
    stream: true,
    max_tokens: args.max_tokens || 8192,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const resp = await fetch(`${apiBase}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok || !resp.body) {
      return {
        content: [{ type: "text", text: `Error (${resp.status})` }],
        isError: true,
      };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";
    let reasoning = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const j = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
          };
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) fullText += delta.content;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    const parts: ToolResultContent[] = [];
    if (reasoning) {
      parts.push({ type: "text", text: `[Reasoning]\n${reasoning}\n` });
    }
    parts.push({ type: "text", text: fullText || "(empty response)" });

    const platform = resp.headers.get("X-Platform") || "?";
    const model = resp.headers.get("X-Model") || "?";
    parts.push({
      type: "text",
      text: `\n---\nPlatform: ${platform} | Model: ${model}`,
    });

    return { content: parts };
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[toolChatStream] Error: ${errMsg}`);
    return {
      content: [{ type: "text", text: `Error: ${errMsg}` }],
      isError: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function toolListModels(
  apiBase: string,
  token: string,
  args: ListModelsArgs
): Promise<ToolResult> {
  const path = args.platform
    ? `/api/models?platform=${encodeURIComponent(args.platform)}`
    : "/api/models";

  const resp = await callBackend(apiBase, token, path);
  if (resp.status !== 200) {
    return {
      content: [{ type: "text", text: `Error: ${resp.status}` }],
      isError: true,
    };
  }

  const rawModels = (resp.data?.models as ModelInfo[]) || [];
  const models = rawModels.map((m) => ({
    name: m.model_name || m.name,
    platform: m.platform,
    context: m.context_window,
    vision: m.supports_vision === 1,
    tools: m.supports_tools === 1,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ count: models.length, models }, null, 2),
      },
    ],
  };
}

async function toolGetModelInfo(
  apiBase: string,
  token: string,
  args: GetModelInfoArgs
): Promise<ToolResult> {
  if (!args.model) {
    return {
      content: [{ type: "text", text: "Error: 'model' is required" }],
      isError: true,
    };
  }

  const resp = await callBackend(apiBase, token, "/api/models");
  if (resp.status !== 200) {
    return {
      content: [{ type: "text", text: `Error: ${resp.status}` }],
      isError: true,
    };
  }

  const rawModels = (resp.data?.models as ModelInfo[]) || [];
  const model = rawModels.find(
    (m) => (m.model_name || m.name) === args.model
  );

  if (!model) {
    return {
      content: [
        { type: "text", text: `Model "${args.model}" not found` },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(model, null, 2) }],
  };
}

async function toolCompareModels(
  apiBase: string,
  token: string,
  args: CompareModelsArgs
): Promise<ToolResult> {
  if (!args.message) {
    return {
      content: [{ type: "text", text: "Error: 'message' is required" }],
      isError: true,
    };
  }
  if (!args.models || !Array.isArray(args.models) || args.models.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: 'models' must be a non-empty array" },
      ],
      isError: true,
    };
  }
  if (args.models.length > 10) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Maximum 10 models can be compared at once",
        },
      ],
      isError: true,
    };
  }

  const models = args.models;
  const message = args.message;
  const system = args.system;

  const results = await Promise.allSettled(
    models.map(async (model) => {
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: message });

      const resp = await callBackend(apiBase, token, "/v1/chat/completions", {
        method: "POST",
        body: { model, messages, stream: false, max_tokens: 8192 },
      });

      if (resp.status !== 200) {
        return { model, error: `HTTP ${resp.status}`, content: null } as ModelComparisonResult;
      }

      const choices = resp.data?.choices as
        | Array<{ message: { content: string } }>
        | undefined;
      const usage = resp.data?.usage as { total_tokens?: number } | undefined;

      return {
        model,
        content: choices?.[0]?.message?.content || "(empty)",
        platform: resp.headers.get("X-Platform") || "?",
        latency: resp.headers.get("X-Latency") || "?",
        tokens: usage?.total_tokens || 0,
      } as ModelComparisonResult;
    })
  );

  const comparison: ModelComparisonResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      model: models[i],
      error: r.reason?.message || "Failed",
      content: null,
    };
  });

  const text = comparison
    .map((c) => {
      let s = `=== ${c.model} (${c.platform || "N/A"}) ===\n`;
      if (c.error) {
        s += `ERROR: ${c.error}\n`;
      } else {
        s += `${c.content}\n[Latency: ${c.latency}ms | Tokens: ${c.tokens}]\n`;
      }
      return s;
    })
    .join("\n");

  return { content: [{ type: "text", text }] };
}

// ===== MCP Request Handler =====

async function handleRequest(
  env: Env,
  req: MCPRequest,
  token: string | null
): Promise<MCPResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "mcp-llm-chat", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments || {}) as Record<string, unknown>;
      const apiBase = env.API_BASE;

      if (!token) {
        return rpcError(
          id,
          -32603,
          "Authentication required. Pass your freellmapi token via Authorization: Bearer header."
        );
      }

      try {
        let result: ToolResult;
        switch (name) {
          case "chat":
            result = await toolChat(apiBase, token, args as unknown as ChatArgs);
            break;
          case "chat_stream":
            result = await toolChatStream(apiBase, token, args as unknown as ChatStreamArgs);
            break;
          case "list_models":
            result = await toolListModels(apiBase, token, args as unknown as ListModelsArgs);
            break;
          case "get_model_info":
            result = await toolGetModelInfo(apiBase, token, args as unknown as GetModelInfoArgs);
            break;
          case "compare_models":
            result = await toolCompareModels(apiBase, token, args as unknown as CompareModelsArgs);
            break;
          default:
            return rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        return rpcResult(id, result);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[handleRequest] Tool '${name}' failed: ${errMsg}`);
        return rpcError(id, -32603, `Tool failed: ${errMsg}`);
      }
    }

    case "resources/list":
      return rpcResult(id, {
        resources: [
          {
            uri: "llm://models",
            name: "Available Models",
            mimeType: "application/json",
          },
        ],
      });

    case "resources/read": {
      const uri = params?.uri as string | undefined;
      if (uri === "llm://models" && token) {
        const r = await toolListModels(env.API_BASE, token, {});
        return rpcResult(id, {
          contents: [
            { uri, mimeType: "application/json", ...r.content[0] },
          ],
        });
      }
      return rpcError(id, -32602, "Unknown resource");
    }

    case "prompts/list":
      return rpcResult(id, { prompts: PROMPTS });

    case "prompts/get": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments || {}) as Record<string, string>;
      let text = "";

      if (name === "summarize") {
        text = `Please summarize the following text concisely:\n\n${args.text || ""}`;
      } else if (name === "translate") {
        text = `Translate the following text to ${args.language || "English"}:\n\n${args.text || ""}`;
      } else if (name === "explain_code") {
        text = `Please explain this code:\n\n\`\`\`\n${args.code || ""}\n\`\`\``;
      } else if (name === "review_code") {
        text = `Please review this code for bugs, security issues, and improvements:\n\n\`\`\`\n${args.code || ""}\n\`\`\``;
      } else {
        return rpcError(id, -32602, `Unknown prompt: ${name}`);
      }

      return rpcResult(id, {
        messages: [{ role: "user", content: { type: "text", text } }],
      });
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ===== Worker Entry Point =====

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-api-key, Mcp-Session-Id",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        name: "mcp-llm-chat",
        version: "1.0.0",
      });
    }

    // MCP endpoint
    if (url.pathname === "/" || url.pathname === "/mcp") {
      if (req.method === "POST") {
        const body: unknown = await req.json().catch(() => null);
        if (!body) {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const token = extractToken(req);
        const requests: MCPRequest[] = Array.isArray(body) ? body : [body];
        const responses: MCPResponse[] = [];

        for (const r of requests) {
          if (!r.jsonrpc || r.jsonrpc !== "2.0") {
            responses.push(rpcError(r.id || 0, -32600, "Invalid Request"));
            continue;
          }
          try {
            const resp = await handleRequest(env, r, token);
            if (resp) responses.push(resp);
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.error(`[fetch] handleRequest failed: ${errMsg}`);
            responses.push(rpcError(r.id || 0, -32603, `Internal error: ${errMsg}`));
          }
        }

        if (responses.length === 0) {
          return new Response(null, { status: 202 });
        }

        const responseBody = Array.isArray(body) ? responses : responses[0];
        return Response.json(responseBody, {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": `mcp-chat-${Date.now()}`,
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // SSE (GET) for MCP session
      if (req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (d: string) => controller.enqueue(enc.encode(d));

            send(": keepalive\n\n");

            const interval = setInterval(() => {
              try {
                send(": keepalive\n\n");
              } catch {
                clearInterval(interval);
              }
            }, 30_000);

            req.signal?.addEventListener("abort", () => {
              clearInterval(interval);
              try {
                controller.close();
              } catch {
                // Controller may already be closed
              }
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // DELETE
      if (req.method === "DELETE") {
        return Response.json({ ok: true });
      }
    }

    // 404 fallback
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};