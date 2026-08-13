// ---------------------------------------------------------------------------
// mcp-provider-monitor — Cloudflare Worker providing MCP tools & resources
// for monitoring LLM providers, API keys, analytics, and fallback chains.
// ---------------------------------------------------------------------------

// ---- Environment & globals -------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "mcp-provider-monitor",
  version: "1.0.0",
};
const SERVER_CAPABILITIES = {
  tools: {},
  resources: {},
  logging: {},
};

// ---- Types -----------------------------------------------------------------

export interface Env {
  API_BASE: string;
}

// ---- Backend response shapes ------------------------------------------------

interface BackendPlatform {
  platform: string;
  label: string;
  enabled: number | boolean;
  baseUrl?: string;
  keyInfo?: { total: number; enabled: number };
  models?: BackendModel[];
}

interface BackendModel {
  model_name?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
  id?: string | number;
  family?: string;
  context_window?: number;
  context?: number;
  enabled: number | boolean;
  supports_tools?: number | boolean;
  supportsTools?: number | boolean;
  supports_vision?: number | boolean;
  supportsVision?: number | boolean;
  source?: string;
}

interface BackendKey {
  id: string | number;
  platform: string;
  label?: string;
  keyHint: string;
  enabled: number | boolean;
  healthStatus?: string;
  lastCheckedAt?: number;
  customBaseUrl?: string;
}

interface BackendAnalytics {
  total?: number;
  lastDay?: number;
  lastWeek?: number;
  successRate?: number;
  avgLatency?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  estimatedSavings?: number;
  platformBreakdown?: Array<{
    platform: string;
    c?: number;
    avg_latency?: number;
  }>;
  modelBreakdown?: Array<{
    model: string;
    platform: string;
    c?: number;
  }>;
  trend?: Array<{
    day: string;
    c?: number;
  }>;
}

interface BackendLogEntry {
  id: string | number;
  model: string;
  platform: string;
  key_id: string;
  status_code: number;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  stream?: number | boolean;
  created_at?: number;
}

interface BackendFallbackEntry {
  id: string | number;
  position: number;
  platform: string;
  model: string;
  key_id?: string;
  enabled: number | boolean;
}

// ---- Internal result / error shapes -----------------------------------------

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

interface McpResourceResult {
  contents?: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
  error?: string;
}

// ---- MCP tool schemas -------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_providers",
    description:
      "List all configured LLM providers with their key count, enabled status, and health summary. Returns platform name, label, enabled flag, total/enabled key counts, and model count for each provider.",
    inputSchema: {
      type: "object",
      properties: {
        include_models: {
          type: "boolean",
          description:
            "If true, include the full model list for each provider. Default: false.",
        },
      },
    },
  },
  {
    name: "health_check",
    description:
      "Check the health status of all API keys across all providers. Returns per-key health status (healthy, rate_limited, invalid, error, unknown) with a summary. Optionally trigger a fresh health check on the backend.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "boolean",
          description:
            "If true, trigger a fresh health check for each key on the backend (async). Default: false (returns cached status only).",
        },
      },
    },
  },
  {
    name: "get_analytics",
    description:
      "Get analytics summary including total requests, success rate, average latency, token usage (prompt/completion/total), estimated savings, platform breakdown, model breakdown, and daily trend for the last 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description:
            "Number of days to look back (passed to backend; currently fixed at 7). Default: 7.",
        },
      },
    },
  },
  {
    name: "get_request_logs",
    description:
      "Get recent request logs. Returns model, platform, status code, latency, token usage, and timestamp for each request, sorted by most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of logs to return (1-200). Default: 50.",
        },
        platform: {
          type: "string",
          description:
            "Filter logs by platform (e.g. groq, google). If omitted, returns all platforms.",
        },
      },
    },
  },
  {
    name: "get_provider_details",
    description:
      "Get detailed information for a specific provider, including provider metadata, key list with health status, and full model list with capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description:
            "The platform identifier (e.g. groq, google, openrouter, cloudflare).",
        },
      },
      required: ["platform"],
    },
  },
  {
    name: "get_fallback_chain",
    description:
      "Get the configured fallback chain \u2014 the ordered list of models the router tries when the primary model fails. Each entry has a position, platform, model name, and enabled flag.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "monitor_alerts",
    description:
      "Check for anomalies that may need attention: all keys unhealthy for a provider, success rate dropping below threshold, high average latency, no healthy keys system-wide, or high ratio of rate-limited keys. Returns a list of alerts with severity levels.",
    inputSchema: {
      type: "object",
      properties: {
        success_rate_threshold: {
          type: "number",
          description:
            "Alert if success rate falls below this (0-1). Default: 0.8.",
        },
        latency_threshold_ms: {
          type: "number",
          description:
            "Alert if average latency exceeds this (in ms). Default: 5000.",
        },
      },
    },
  },
];

// ---- MCP resource definitions -----------------------------------------------

interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const RESOURCES: ResourceDefinition[] = [
  {
    uri: "providers://status",
    name: "Provider Status",
    description:
      "All configured LLM providers with key counts and health summary.",
    mimeType: "application/json",
  },
  {
    uri: "analytics://summary",
    name: "Analytics Summary",
    description: "Request analytics summary for the last 7 days.",
    mimeType: "application/json",
  },
  {
    uri: "keys://health",
    name: "Key Health Status",
    description: "Health status of all API keys across all providers.",
    mimeType: "application/json",
  },
  {
    uri: "fallback://chain",
    name: "Fallback Chain",
    description: "The configured fallback chain for model routing.",
    mimeType: "application/json",
  },
];

// ---- RPC helpers ------------------------------------------------------------

interface JsonRpcErrorObj {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(
  id: number | string | null,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  const error: JsonRpcErrorObj = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

// ---- BackendError & helpers -------------------------------------------------

class BackendError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Backend returned ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
    this.name = "BackendError";
  }
}

async function backendGet(
  apiBase: string,
  authHeader: string | null,
  path: string,
): Promise<unknown> {
  const url = `${apiBase}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new BackendError(resp.status, text);
    }
    return resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function backendPost(
  apiBase: string,
  authHeader: string | null,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${apiBase}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new BackendError(resp.status, text);
    }
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function backendErrorToToolResult(e: unknown): ToolResult {
  if (e instanceof BackendError) {
    const hint =
      e.status === 401
        ? "Authentication failed. Ensure a valid dashboard JWT is provided via Authorization: Bearer header."
        : e.status === 404
          ? "Resource not found on backend."
          : e.status >= 500
            ? "Backend server error."
            : "Backend request failed.";
    return {
      content: [
        {
          type: "text",
          text: `Error (${e.status}): ${hint}\n${e.body.slice(0, 500)}`,
        },
      ],
      isError: true,
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}

function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ---- Tool implementations ---------------------------------------------------

// list_providers
interface ListProvidersArgs {
  include_models?: boolean;
}

interface ProviderOutput {
  platform: string;
  label: string;
  enabled: boolean;
  baseUrl: string | null;
  keyInfo: { total: number; enabled: number };
  modelCount: number;
  models?: ModelOutput[];
}

interface ModelOutput {
  name: string;
  displayName: string;
  enabled: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number | null;
}

async function toolListProviders(
  apiBase: string,
  authHeader: string | null,
  args: ListProvidersArgs,
): Promise<ToolResult> {
  const includeModels = args.include_models === true;
  const data = (await backendGet(
    apiBase,
    authHeader,
    "/api/settings/providers",
  )) as { platforms?: BackendPlatform[] };
  const platforms = data.platforms || [];
  const providers: ProviderOutput[] = platforms.map((p) => {
    const models = p.models || [];
    const keyInfo = p.keyInfo || { total: 0, enabled: 0 };
    const provider: ProviderOutput = {
      platform: p.platform,
      label: p.label,
      enabled: p.enabled === 1 || p.enabled === true,
      baseUrl: p.baseUrl || null,
      keyInfo: {
        total: keyInfo.total || 0,
        enabled: keyInfo.enabled || 0,
      },
      modelCount: models.length,
    };
    if (includeModels) {
      provider.models = models.map((m) => ({
        name: m.model_name || m.name || "",
        displayName:
          m.display_name || m.displayName || m.model_name || m.name || "",
        enabled: m.enabled === 1 || m.enabled === true,
        supportsTools: m.supports_tools === 1 || m.supportsTools === true,
        supportsVision: m.supports_vision === 1 || m.supportsVision === true,
        contextWindow: m.context_window || m.context || null,
      }));
    }
    return provider;
  });
  return textResult({
    count: providers.length,
    providers,
  });
}

// health_check
interface HealthCheckArgs {
  trigger?: boolean;
}

interface HealthSummary {
  total: number;
  healthy: number;
  rateLimited: number;
  invalid: number;
  error: number;
  unknown: number;
}

interface KeyDetail {
  id: string | number;
  platform: string;
  label: string | null;
  keyHint: string;
  enabled: boolean;
  healthStatus: string;
  lastCheckedAt: string | null;
}

async function toolHealthCheck(
  apiBase: string,
  authHeader: string | null,
  args: HealthCheckArgs,
): Promise<ToolResult> {
  const trigger = args.trigger === true;
  const data = (await backendGet(apiBase, authHeader, "/api/keys")) as {
    keys?: BackendKey[];
  };
  const keys = data.keys || [];
  const triggered: (string | number)[] = [];

  if (trigger && keys.length > 0) {
    const results = await Promise.allSettled(
      keys.map((k) =>
        backendPost(apiBase, authHeader, `/api/keys/${k.id}/check`).then(
          () => k.id,
        ),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") triggered.push(r.value);
    }
  }

  const summary: HealthSummary = {
    total: keys.length,
    healthy: 0,
    rateLimited: 0,
    invalid: 0,
    error: 0,
    unknown: 0,
  };

  const byProvider: Record<string, HealthSummary> = {};

  for (const k of keys) {
    const status = k.healthStatus || "unknown";
    switch (status) {
      case "healthy":
        summary.healthy++;
        break;
      case "rate_limited":
        summary.rateLimited++;
        break;
      case "invalid":
        summary.invalid++;
        break;
      case "error":
        summary.error++;
        break;
      default:
        summary.unknown++;
        break;
    }
    const platform = k.platform;
    if (!byProvider[platform]) {
      byProvider[platform] = {
        total: 0,
        healthy: 0,
        rateLimited: 0,
        invalid: 0,
        error: 0,
        unknown: 0,
      };
    }
    byProvider[platform].total++;
    const bucket =
      status === "healthy"
        ? "healthy"
        : status === "rate_limited"
          ? "rateLimited"
          : status === "invalid"
            ? "invalid"
            : status === "error"
              ? "error"
              : "unknown";
    byProvider[platform][bucket as keyof HealthSummary]++;
  }

  const keyDetails: KeyDetail[] = keys.map((k) => ({
    id: k.id,
    platform: k.platform,
    label: k.label || null,
    keyHint: k.keyHint,
    enabled: k.enabled === 1 || k.enabled === true,
    healthStatus: k.healthStatus || "unknown",
    lastCheckedAt: k.lastCheckedAt
      ? new Date(k.lastCheckedAt * 1000).toISOString()
      : null,
  }));

  return textResult({
    summary,
    byProvider,
    keys: keyDetails,
    ...(trigger ? { healthChecksTriggered: triggered.length } : {}),
  });
}

// get_analytics
interface GetAnalyticsArgs {
  days?: number;
}

async function toolGetAnalytics(
  apiBase: string,
  authHeader: string | null,
  args: GetAnalyticsArgs,
): Promise<ToolResult> {
  const days = args.days || 7;
  const data = (await backendGet(
    apiBase,
    authHeader,
    "/api/analytics/summary",
  )) as BackendAnalytics;
  const successRate =
    typeof data.successRate === "number" ? data.successRate : 0;
  const avgLatency = typeof data.avgLatency === "number" ? data.avgLatency : 0;
  const promptTokens = data.totalPromptTokens || 0;
  const completionTokens = data.totalCompletionTokens || 0;
  const platformBreakdown = (data.platformBreakdown || []).map((p) => ({
    platform: p.platform,
    requests: p.c || 0,
    avgLatencyMs: p.avg_latency ? Math.round(p.avg_latency) : null,
  }));
  const modelBreakdown = (data.modelBreakdown || []).map((m) => ({
    model: m.model,
    platform: m.platform,
    requests: m.c || 0,
  }));
  const trend = (data.trend || []).map((t) => ({
    date: t.day,
    requests: t.c || 0,
  }));

  return textResult({
    period: `${days} days`,
    totalRequests: data.total || 0,
    lastDayRequests: data.lastDay || 0,
    lastWeekRequests: data.lastWeek || 0,
    successRate: `${(successRate * 100).toFixed(1)}%`,
    successRateRaw: successRate,
    totalPromptTokens: promptTokens,
    totalCompletionTokens: completionTokens,
    totalTokens: promptTokens + completionTokens,
    avgLatencyMs: Math.round(avgLatency),
    avgLatencyDisplay:
      avgLatency > 0 ? `${Math.round(avgLatency)}ms` : "N/A",
    estimatedSavingsUSD:
      typeof data.estimatedSavings === "number" ? data.estimatedSavings : 0,
    platformBreakdown,
    modelBreakdown,
    trend,
  });
}

// get_request_logs
interface GetRequestLogsArgs {
  limit?: number;
  platform?: string;
}

interface FormattedLogEntry {
  id: string | number;
  model: string;
  platform: string;
  keyId: string;
  statusCode: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  stream: boolean;
  timestamp: string | null;
}

async function toolGetRequestLogs(
  apiBase: string,
  authHeader: string | null,
  args: GetRequestLogsArgs,
): Promise<ToolResult> {
  let limit = args.limit ?? 50;
  // clamp to [1, 200]
  limit = Math.min(Math.max(Math.round(limit), 1), 200);
  const platformFilter = args.platform;

  const data = (await backendGet(
    apiBase,
    authHeader,
    `/api/analytics/recent?limit=${limit}`,
  )) as { logs?: BackendLogEntry[] };
  let logs = data.logs || [];
  if (platformFilter) {
    logs = logs.filter((l) => l.platform === platformFilter);
  }
  const formattedLogs: FormattedLogEntry[] = logs.map((l) => ({
    id: l.id,
    model: l.model,
    platform: l.platform,
    keyId: l.key_id,
    statusCode: l.status_code,
    latencyMs: l.latency_ms,
    promptTokens: l.prompt_tokens || 0,
    completionTokens: l.completion_tokens || 0,
    totalTokens: l.total_tokens || 0,
    stream: l.stream === 1 || l.stream === true,
    timestamp: l.created_at
      ? new Date(l.created_at * 1000).toISOString()
      : null,
  }));

  const summary = {
    count: formattedLogs.length,
    successCount: formattedLogs.filter((l) => l.statusCode < 400).length,
    errorCount: formattedLogs.filter((l) => l.statusCode >= 400).length,
    avgLatencyMs:
      formattedLogs.length > 0
        ? Math.round(
            formattedLogs.reduce((sum, l) => sum + (l.latencyMs || 0), 0) /
              formattedLogs.length,
          )
        : 0,
    totalTokens: formattedLogs.reduce(
      (sum, l) => sum + (l.totalTokens || 0),
      0,
    ),
  };

  return textResult({
    summary,
    logs: formattedLogs,
  });
}

// get_provider_details
interface GetProviderDetailsArgs {
  platform: string;
}

interface ProviderDetailKey {
  id: string | number;
  label: string | null;
  keyHint: string;
  enabled: boolean;
  healthStatus: string;
  lastCheckedAt: string | null;
  customBaseUrl: string | null;
}

interface ProviderDetailModel {
  id: string | number | undefined;
  name: string;
  displayName: string;
  family: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  source: string;
}

async function toolGetProviderDetails(
  apiBase: string,
  authHeader: string | null,
  args: GetProviderDetailsArgs,
): Promise<ToolResult> {
  const platform = args.platform;
  if (!platform) {
    return {
      content: [
        { type: "text", text: "Error: platform parameter is required" },
      ],
      isError: true,
    };
  }

  const [providersData, keysData] = (await Promise.all([
    backendGet(apiBase, authHeader, "/api/settings/providers"),
    backendGet(apiBase, authHeader, "/api/keys"),
  ])) as [
    { platforms?: BackendPlatform[] },
    { keys?: BackendKey[] },
  ];

  const platforms = providersData.platforms || [];
  const provider = platforms.find((p) => p.platform === platform);
  if (!provider) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Provider "${platform}" not found. Available: ${platforms.map((p) => p.platform).join(", ")}`,
        },
      ],
      isError: true,
    };
  }

  const allKeys = keysData.keys || [];
  const providerKeys = allKeys.filter((k) => k.platform === platform);
  const keys: ProviderDetailKey[] = providerKeys.map((k) => ({
    id: k.id,
    label: k.label || null,
    keyHint: k.keyHint,
    enabled: k.enabled === 1 || k.enabled === true,
    healthStatus: k.healthStatus || "unknown",
    lastCheckedAt: k.lastCheckedAt
      ? new Date(k.lastCheckedAt * 1000).toISOString()
      : null,
    customBaseUrl: k.customBaseUrl || null,
  }));

  const keySummary = {
    total: keys.length,
    enabled: keys.filter((k) => k.enabled).length,
    healthy: keys.filter((k) => k.healthStatus === "healthy").length,
    rateLimited: keys.filter((k) => k.healthStatus === "rate_limited").length,
    invalid: keys.filter((k) => k.healthStatus === "invalid").length,
    error: keys.filter((k) => k.healthStatus === "error").length,
  };

  const models = provider.models || [];
  const formattedModels: ProviderDetailModel[] = models.map((m) => ({
    id: m.id,
    name: m.model_name || m.name || "",
    displayName: m.display_name || m.displayName || m.model_name || m.name || "",
    family: m.family || null,
    contextWindow: m.context_window || m.context || null,
    enabled: m.enabled === 1 || m.enabled === true,
    supportsTools: m.supports_tools === 1 || m.supportsTools === true,
    supportsVision: m.supports_vision === 1 || m.supportsVision === true,
    source: m.source || "local",
  }));

  return textResult({
    platform: provider.platform,
    label: provider.label,
    enabled: provider.enabled === 1 || provider.enabled === true,
    baseUrl: provider.baseUrl || null,
    keySummary,
    keys,
    modelCount: formattedModels.length,
    models: formattedModels,
  });
}

// get_fallback_chain
interface FallbackEntryOutput {
  id: string | number;
  position: number;
  platform: string;
  model: string;
  keyId: string | null;
  enabled: boolean;
}

async function toolGetFallbackChain(
  apiBase: string,
  authHeader: string | null,
): Promise<ToolResult> {
  const data = (await backendGet(apiBase, authHeader, "/api/fallback")) as {
    chain?: BackendFallbackEntry[];
  };
  const chain = data.chain || [];
  const formattedChain: FallbackEntryOutput[] = chain.map((entry) => ({
    id: entry.id,
    position: entry.position,
    platform: entry.platform,
    model: entry.model,
    keyId: entry.key_id || null,
    enabled: entry.enabled === 1 || entry.enabled === true,
  }));
  const summary = {
    total: formattedChain.length,
    enabled: formattedChain.filter((e) => e.enabled).length,
    disabled: formattedChain.filter((e) => !e.enabled).length,
    platforms: [...new Set(formattedChain.map((e) => e.platform))],
  };
  return textResult({
    summary,
    chain: formattedChain,
  });
}

// monitor_alerts
interface MonitorAlertsArgs {
  success_rate_threshold?: number;
  latency_threshold_ms?: number;
}

interface Alert {
  severity: string;
  type: string;
  platform?: string;
  message: string;
  details: Record<string, unknown>;
}

async function toolMonitorAlerts(
  apiBase: string,
  authHeader: string | null,
  args: MonitorAlertsArgs,
): Promise<ToolResult> {
  let successRateThreshold = args.success_rate_threshold ?? 0.8;
  let latencyThresholdMs = args.latency_threshold_ms ?? 5000;

  // input validation
  successRateThreshold = Math.min(Math.max(successRateThreshold, 0), 1);
  latencyThresholdMs = Math.max(latencyThresholdMs, 0);

  const [keysData, analyticsData] = (await Promise.all([
    backendGet(apiBase, authHeader, "/api/keys"),
    backendGet(apiBase, authHeader, "/api/analytics/summary"),
  ])) as [{ keys?: BackendKey[] }, BackendAnalytics];

  const keys = keysData.keys || [];
  const alerts: Alert[] = [];

  // Group keys by platform
  const platformMap: Record<string, BackendKey[]> = {};
  for (const k of keys) {
    if (!platformMap[k.platform]) platformMap[k.platform] = [];
    platformMap[k.platform].push(k);
  }

  // Check per-provider: all enabled keys unhealthy
  for (const [platform, platformKeys] of Object.entries(platformMap)) {
    const enabledKeys = platformKeys.filter(
      (k) => k.enabled === 1 || k.enabled === true,
    );
    if (enabledKeys.length === 0) continue;
    const healthyKeys = enabledKeys.filter(
      (k) => k.healthStatus === "healthy",
    );
    if (healthyKeys.length === 0) {
      const rateLimited = enabledKeys.filter(
        (k) => k.healthStatus === "rate_limited",
      ).length;
      const invalid = enabledKeys.filter(
        (k) => k.healthStatus === "invalid",
      ).length;
      const error = enabledKeys.filter(
        (k) => k.healthStatus === "error",
      ).length;
      alerts.push({
        severity: "critical",
        type: "all_keys_unhealthy",
        platform,
        message: `All ${enabledKeys.length} enabled key(s) for provider "${platform}" are unhealthy`,
        details: {
          total: enabledKeys.length,
          healthy: 0,
          rateLimited,
          invalid,
          error,
        },
      });
    }
  }

  // System-wide: no healthy keys at all
  const enabledKeys = keys.filter(
    (k) => k.enabled === 1 || k.enabled === true,
  );
  const totalHealthy = enabledKeys.filter(
    (k) => k.healthStatus === "healthy",
  ).length;
  if (enabledKeys.length > 0 && totalHealthy === 0) {
    alerts.push({
      severity: "critical",
      type: "no_healthy_keys",
      message: `No healthy API keys across all providers (${enabledKeys.length} keys enabled, 0 healthy)`,
      details: {
        totalEnabled: enabledKeys.length,
        totalHealthy: 0,
      },
    });
  }

  // Low success rate
  const successRate =
    typeof analyticsData.successRate === "number"
      ? analyticsData.successRate
      : 1;
  const lastWeekRequests = analyticsData.lastWeek || 0;
  if (lastWeekRequests >= 10 && successRate < successRateThreshold) {
    alerts.push({
      severity: successRate < 0.5 ? "critical" : "warning",
      type: "low_success_rate",
      message: `Success rate is ${(successRate * 100).toFixed(1)}% over the last 7 days (threshold: ${(successRateThreshold * 100).toFixed(0)}%), based on ${lastWeekRequests} requests`,
      details: {
        successRate,
        threshold: successRateThreshold,
        totalRequests: lastWeekRequests,
      },
    });
  }

  // High latency
  const avgLatency =
    typeof analyticsData.avgLatency === "number"
      ? analyticsData.avgLatency
      : 0;
  if (avgLatency > latencyThresholdMs) {
    alerts.push({
      severity: avgLatency > latencyThresholdMs * 2 ? "critical" : "warning",
      type: "high_latency",
      message: `Average latency is ${Math.round(avgLatency)}ms over the last 7 days (threshold: ${latencyThresholdMs}ms)`,
      details: {
        avgLatencyMs: Math.round(avgLatency),
        thresholdMs: latencyThresholdMs,
      },
    });
  }

  // High rate-limit ratio
  const rateLimitedCount = enabledKeys.filter(
    (k) => k.healthStatus === "rate_limited",
  ).length;
  if (enabledKeys.length > 0 && rateLimitedCount > 0) {
    const ratio = rateLimitedCount / enabledKeys.length;
    if (ratio > 0.5) {
      alerts.push({
        severity: "warning",
        type: "high_rate_limit_ratio",
        message: `${rateLimitedCount} of ${enabledKeys.length} enabled keys (${(ratio * 100).toFixed(0)}%) are rate limited`,
        details: {
          rateLimitedCount,
          totalEnabled: enabledKeys.length,
          ratio,
        },
      });
    }
  }

  // High invalid ratio
  const invalidCount = enabledKeys.filter(
    (k) => k.healthStatus === "invalid",
  ).length;
  if (enabledKeys.length > 0 && invalidCount > 0) {
    const ratio = invalidCount / enabledKeys.length;
    if (ratio > 0.3) {
      alerts.push({
        severity: "warning",
        type: "high_invalid_ratio",
        message: `${invalidCount} of ${enabledKeys.length} enabled keys (${(ratio * 100).toFixed(0)}%) are invalid (auth failure)`,
        details: {
          invalidCount,
          totalEnabled: enabledKeys.length,
          ratio,
        },
      });
    }
  }

  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const warningCount = alerts.filter((a) => a.severity === "warning").length;
  const status =
    criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok";

  const summary = {
    totalKeys: keys.length,
    enabledKeys: enabledKeys.length,
    healthyKeys: totalHealthy,
    rateLimitedKeys: rateLimitedCount,
    invalidKeys: invalidCount,
    errorKeys: enabledKeys.filter((k) => k.healthStatus === "error").length,
    lastWeekRequests,
    successRate: `${(successRate * 100).toFixed(1)}%`,
    avgLatencyMs: Math.round(avgLatency),
  };

  return textResult({
    status,
    alertCount: alerts.length,
    criticalCount,
    warningCount,
    alerts,
    summary,
    checkedAt: new Date().toISOString(),
  });
}

// ---- Resource reader --------------------------------------------------------

async function readResource(
  apiBase: string,
  authHeader: string | null,
  uri: string,
): Promise<McpResourceResult> {
  try {
    let data: unknown;
    switch (uri) {
      case "providers://status": {
        const result = await toolListProviders(apiBase, authHeader, {
          include_models: false,
        });
        data = JSON.parse(result.content[0].text);
        break;
      }
      case "analytics://summary": {
        const result = await toolGetAnalytics(apiBase, authHeader, {});
        data = JSON.parse(result.content[0].text);
        break;
      }
      case "keys://health": {
        const result = await toolHealthCheck(apiBase, authHeader, {});
        data = JSON.parse(result.content[0].text);
        break;
      }
      case "fallback://chain": {
        const result = await toolGetFallbackChain(apiBase, authHeader);
        data = JSON.parse(result.content[0].text);
        break;
      }
      default:
        return { error: `Unknown resource: ${uri}` };
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (e) {
    console.error("readResource error:", e);
    if (e instanceof BackendError) {
      return { error: `Backend error (${e.status}): ${e.body.slice(0, 200)}` };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- MCP request handler ----------------------------------------------------

interface McpRequest {
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handleMcpRequest(
  env: Env,
  authHeader: string | null,
  req: McpRequest,
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = req;
  const respId = id !== undefined && id !== null ? id : 0;

  const requiresAuth = method === "tools/call" || method === "resources/read";
  if (requiresAuth && !authHeader) {
    return rpcError(
      respId,
      -32001,
      "Authentication required: provide a dashboard JWT via Authorization: Bearer header",
    );
  }

  switch (method) {
    case "initialize":
      return rpcResult(respId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(respId, {});

    case "tools/list":
      return rpcResult(respId, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const toolName = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) || {};
      try {
        let result: ToolResult;
        switch (toolName) {
          case "list_providers":
            result = await toolListProviders(
              env.API_BASE,
              authHeader,
              args as ListProvidersArgs,
            );
            break;
          case "health_check":
            result = await toolHealthCheck(
              env.API_BASE,
              authHeader,
              args as HealthCheckArgs,
            );
            break;
          case "get_analytics":
            result = await toolGetAnalytics(
              env.API_BASE,
              authHeader,
              args as GetAnalyticsArgs,
            );
            break;
          case "get_request_logs":
            result = await toolGetRequestLogs(
              env.API_BASE,
              authHeader,
              args as GetRequestLogsArgs,
            );
            break;
          case "get_provider_details":
            result = await toolGetProviderDetails(
              env.API_BASE,
              authHeader,
              args as GetProviderDetailsArgs,
            );
            break;
          case "get_fallback_chain":
            result = await toolGetFallbackChain(env.API_BASE, authHeader);
            break;
          case "monitor_alerts":
            result = await toolMonitorAlerts(
              env.API_BASE,
              authHeader,
              args as MonitorAlertsArgs,
            );
            break;
          default:
            return rpcError(respId, -32602, `Unknown tool: ${toolName}`);
        }
        return rpcResult(respId, result);
      } catch (e) {
        console.error("tools/call error:", e);
        if (e instanceof BackendError) {
          return rpcResult(respId, backendErrorToToolResult(e));
        }
        const msg = e instanceof Error ? e.message : String(e);
        return rpcResult(respId, {
          content: [{ type: "text", text: `Tool execution failed: ${msg}` }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return rpcResult(respId, {
        resources: RESOURCES.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      });

    case "resources/read": {
      const uri = params?.uri as string | undefined;
      if (!uri) {
        return rpcError(respId, -32602, "Missing uri parameter");
      }
      const result = await readResource(env.API_BASE, authHeader, uri);
      if ("error" in result) {
        return rpcError(respId, -32602, result.error!);
      }
      return rpcResult(respId, result);
    }

    case "logging/setLevel":
      return rpcResult(respId, {});

    default:
      return rpcError(respId, -32601, `Method not found: ${method}`);
  }
}

// ---- HTTP handlers ----------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(body, { ...init, headers });
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.error("handlePost: invalid JSON", e);
    return corsResponse(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = request.headers.get("Authorization");
  const requests: McpRequest[] = Array.isArray(body) ? body : [body];
  const responses: Record<string, unknown>[] = [];

  for (const req of requests) {
    if (!req || typeof req !== "object" || (req as Record<string, unknown>).jsonrpc !== "2.0") {
      responses.push(
        rpcError(
          (req as Record<string, unknown>)?.id as number | string | undefined ?? 0,
          -32600,
          'Invalid Request: jsonrpc must be "2.0"',
        ),
      );
      continue;
    }
    if (typeof req.method !== "string") {
      responses.push(
        rpcError(
          (req as Record<string, unknown>).id as number | string | undefined ?? 0,
          -32600,
          "Invalid Request: method must be a string",
        ),
      );
      continue;
    }
    try {
      const resp = await handleMcpRequest(env, authHeader, req);
      if (resp) responses.push(resp);
    } catch (e) {
      console.error("handlePost: internal error", e);
      const msg = e instanceof Error ? e.message : String(e);
      responses.push(
        rpcError(
          (req as Record<string, unknown>).id as number | string | undefined ?? 0,
          -32603,
          `Internal error: ${msg}`,
        ),
      );
    }
  }

  if (responses.length === 0) {
    return new Response(null, {
      status: 202,
      headers: CORS_HEADERS,
    });
  }

  const responseBody = Array.isArray(body) ? responses : responses[0];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  };

  const hasInitialize = (requests as McpRequest[]).some(
    (r) => r?.method === "initialize",
  );
  if (hasInitialize) {
    headers["Mcp-Session-Id"] = `monitor-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers,
  });
}

async function handleGet(request: Request): Promise<Response> {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string): void => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          clearInterval(interval);
        }
      };
      send(": keepalive\n\n");
      const interval = setInterval(() => {
        send(": keepalive\n\n");
      }, 30_000);
      request.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

async function handleDelete(): Promise<Response> {
  return corsResponse(
    JSON.stringify({ ok: true, message: "Session terminated" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function handleHealth(): Promise<Response> {
  return corsResponse(
    JSON.stringify({
      status: "ok",
      server: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocolVersion: MCP_PROTOCOL_VERSION,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// ---- Worker entry point -----------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check endpoint
    if (path === "/health" && method === "GET") {
      return handleHealth();
    }

    // MCP endpoint
    if (path === "/" || path === "/mcp") {
      switch (method) {
        case "POST":
          return handlePost(request, env);
        case "GET":
          return handleGet(request);
        case "DELETE":
          return handleDelete();
        default:
          return corsResponse(
            JSON.stringify({ error: "Method not allowed" }),
            {
              status: 405,
              headers: {
                "Content-Type": "application/json",
                Allow: "GET, POST, DELETE, OPTIONS",
              },
            },
          );
      }
    }

    // 404 for everything else
    return corsResponse(
      JSON.stringify({
        error: "Not found",
        availableEndpoints: ["POST /", "GET /", "DELETE /", "GET /health"],
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};