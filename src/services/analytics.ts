// Analytics service for FreeLLMAPI
// Tracks request counts, token usage, latency
// Provides helper functions for common analytics queries

import type { Analytics } from '../types';
import { DB } from '../lib/db';
import { Cache } from '../lib/cache';

// Analytics data input for recording a request
export interface AnalyticsData {
  endpoint: string;
  provider: string;
  model: string;
  latencyMs: number;
  tokensPrompt: number;
  tokensCompletion: number;
  statusCode: number;
  userId?: string;
}

// Aggregated statistics
export interface Stats {
  totalRequests: number;
  totalTokens: number;
  averageLatency: number;
  providerStats: { provider: string; count: number; percentage: number }[];
  endpointStats: { endpoint: string; method: string; count: number }[];
  timeRange: number;
  tokensPerSecond: number;
  errorRate: number;
  successRate: number;
}

// Time-series data point
export interface TimeSeriesPoint {
  timestamp: string;
  requests: number;
  tokens: number;
  latency: number;
}

// Provider performance summary
export interface ProviderPerformance {
  provider: string;
  requestCount: number;
  avgLatency: number;
  avgTokens: number;
  errorRate: number;
  reliability: number;
}

// KV cache keys for analytics
const ANALYTICS_COUNTER_KEY = 'analytics:counter';
const ANALYTICS_LAST_HOUR_KEY = 'analytics:last_hour';

/**
 * Record a request's analytics data to the database.
 * Also updates real-time counters in cache.
 */
export async function recordRequest(
  db: DB,
  cache: Cache,
  data: AnalyticsData
): Promise<void> {
  const entry: Omit<Analytics, 'id' | 'timestamp'> = {
    endpoint: data.endpoint,
    provider: data.provider,
    model: data.model,
    latency_ms: data.latencyMs,
    tokens_prompt: data.tokensPrompt,
    tokens_completion: data.tokensCompletion,
    status_code: data.statusCode,
    user_id: data.userId || null,
  };

  // Record to D1 database
  await db.recordAnalytics(entry);

  // Update real-time counters in cache (for dashboard)
  await updateRealtimeCounters(data, cache);
}

/**
 * Update real-time analytics counters in cache.
 */
async function updateRealtimeCounters(data: AnalyticsData, cache: Cache): Promise<void> {
  const now = new Date();
  const hourKey = `${ANALYTICS_COUNTER_KEY}:${formatHourKey(now)}`;

  // The counter data is stored as a JSON object with running totals
  // This is eventually consistent and used for dashboard display
  try {
    const existing = await cache.get<{
      requests: number;
      tokens: number;
      errors: number;
      latency: number;
    }>(hourKey);

    const updated = {
      requests: (existing?.requests || 0) + 1,
      tokens: (existing?.tokens || 0) + data.tokensPrompt + data.tokensCompletion,
      errors: (existing?.errors || 0) + (data.statusCode >= 400 ? 1 : 0),
      latency: ((existing?.latency || 0) + data.latencyMs),
    };

    // Cache for 2 hours to cover the current and previous hour
    await cache.set(hourKey, updated, 7200);
  } catch {
    // Silently fail on cache updates - analytics should not break the main flow
    console.warn('[Analytics] Failed to update real-time counters');
  }
}

/**
 * Get aggregated statistics for the specified time range.
 */
export async function getStats(
  db: DB,
  hours: number = 24
): Promise<Stats> {
  const dbStats = await db.getAnalyticsStats(hours);

  const totalRequests = dbStats.totalRequests;
  const totalTokens = dbStats.totalTokens;
  const averageLatency = dbStats.averageLatency;

  // Calculate derived metrics
  const errorCount = await getErrorCount(db, hours);
  const errorRate = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;
  const successRate = 100 - errorRate;

  // Tokens per second (based on average latency)
  const tokensPerSecond = averageLatency > 0
    ? Math.round((totalTokens / (totalRequests * averageLatency)) * 1000)
    : 0;

  return {
    totalRequests,
    totalTokens,
    averageLatency,
    providerStats: dbStats.providerStats,
    endpointStats: dbStats.endpointStats,
    timeRange: hours,
    tokensPerSecond,
    errorRate: Math.round(errorRate * 100) / 100,
    successRate: Math.round(successRate * 100) / 100,
  };
}

/**
 * Get the error count for the specified time range.
 */
async function getErrorCount(db: DB, hours: number): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const result = await db['db'].prepare(
    "SELECT COUNT(*) as count FROM analytics WHERE timestamp > ? AND status_code >= 400"
  ).bind(since).first<{ count: number }>();
  return result?.count || 0;
}

/**
 * Get time-series data for charting.
 */
export async function getTimeSeries(
  db: DB,
  hours: number = 24,
  intervalMinutes: number = 60
): Promise<TimeSeriesPoint[]> {
  const points: TimeSeriesPoint[] = [];
  const now = Date.now();
  const intervalMs = intervalMinutes * 60 * 1000;
  const startTime = now - hours * 60 * 60 * 1000;

  for (let t = startTime; t < now; t += intervalMs) {
    const windowStart = new Date(t).toISOString();
    const windowEnd = new Date(Math.min(t + intervalMs, now)).toISOString();

    const result = await db['db'].prepare(
      `SELECT
        COUNT(*) as requests,
        COALESCE(SUM(tokens_prompt + tokens_completion), 0) as tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency
       FROM analytics
       WHERE timestamp >= ? AND timestamp < ?`
    ).bind(windowStart, windowEnd).first<{
      requests: number;
      tokens: number;
      avg_latency: number;
    }>();

    points.push({
      timestamp: new Date(t).toISOString(),
      requests: result?.requests || 0,
      tokens: result?.tokens || 0,
      latency: Math.round(result?.avg_latency || 0),
    });
  }

  return points;
}

/**
 * Get provider performance comparison.
 */
export async function getProviderPerformance(
  db: DB,
  hours: number = 24
): Promise<ProviderPerformance[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const results = await db['db'].prepare(
    `SELECT
      provider,
      COUNT(*) as request_count,
      COALESCE(AVG(latency_ms), 0) as avg_latency,
      COALESCE(AVG(tokens_prompt + tokens_completion), 0) as avg_tokens,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
     FROM analytics
     WHERE timestamp > ? AND provider IS NOT NULL
     GROUP BY provider
     ORDER BY request_count DESC`
  ).bind(since).all<{
    provider: string;
    request_count: number;
    avg_latency: number;
    avg_tokens: number;
    error_count: number;
  }>();

  return (results.results || []).map(r => ({
    provider: r.provider,
    requestCount: r.request_count,
    avgLatency: Math.round(r.avg_latency),
    avgTokens: Math.round(r.avg_tokens),
    errorRate: r.request_count > 0
      ? Math.round((r.error_count / r.request_count) * 10000) / 100
      : 0,
    reliability: r.request_count > 0
      ? Math.round(((r.request_count - r.error_count) / r.request_count) * 100)
      : 0,
  }));
}

/**
 * Get recent analytics entries for display.
 */
export async function getRecentRequests(
  db: DB,
  limit: number = 20
): Promise<Analytics[]> {
  const result = await db['db'].prepare(
    'SELECT * FROM analytics ORDER BY id DESC LIMIT ?'
  ).bind(limit).all<Analytics>();
  return result.results || [];
}

/**
 * Get total request count for a specific endpoint.
 */
export async function getEndpointCount(
  db: DB,
  endpoint: string,
  hours: number = 24
): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const result = await db['db'].prepare(
    'SELECT COUNT(*) as count FROM analytics WHERE endpoint = ? AND timestamp > ?'
  ).bind(endpoint, since).first<{ count: number }>();
  return result?.count || 0;
}

/**
 * Get total token usage for a specific model.
 */
export async function getModelTokenUsage(
  db: DB,
  model: string,
  hours: number = 24
): Promise<{ prompt: number; completion: number; total: number }> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const result = await db['db'].prepare(
    'SELECT COALESCE(SUM(tokens_prompt), 0) as prompt, COALESCE(SUM(tokens_completion), 0) as completion FROM analytics WHERE model = ? AND timestamp > ?'
  ).bind(model, since).first<{ prompt: number; completion: number }>();

  return {
    prompt: result?.prompt || 0,
    completion: result?.completion || 0,
    total: (result?.prompt || 0) + (result?.completion || 0),
  };
}

/**
 * Format a date to an hour key string (YYYYMMDDHH).
 */
function formatHourKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  return `${year}${month}${day}${hour}`;
}

// Helper exports for common analytics queries

export const AnalyticsHelpers = {
  /**
   * Get the average latency for a specific provider.
   */
  async getProviderAvgLatency(db: DB, provider: string, hours: number = 24): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await db['db'].prepare(
      'SELECT COALESCE(AVG(latency_ms), 0) as avg_latency FROM analytics WHERE provider = ? AND timestamp > ?'
    ).bind(provider, since).first<{ avg_latency: number }>();
    return Math.round(result?.avg_latency || 0);
  },

  /**
   * Get the top N most used models.
   */
  async getTopModels(db: DB, limit: number = 5, hours: number = 24): Promise<{ model: string; count: number }[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await db['db'].prepare(
      'SELECT model, COUNT(*) as count FROM analytics WHERE model IS NOT NULL AND timestamp > ? GROUP BY model ORDER BY count DESC LIMIT ?'
    ).bind(since, limit).all<{ model: string; count: number }>();
    return result.results || [];
  },

  /**
   * Get the total number of requests in the last N hours.
   */
  async getTotalRequests(db: DB, hours: number = 24): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await db['db'].prepare(
      'SELECT COUNT(*) as count FROM analytics WHERE timestamp > ?'
    ).bind(since).first<{ count: number }>();
    return result?.count || 0;
  },

  /**
   * Get the number of unique users in the last N hours.
   */
  async getUniqueUsers(db: DB, hours: number = 24): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await db['db'].prepare(
      'SELECT COUNT(DISTINCT user_id) as count FROM analytics WHERE user_id IS NOT NULL AND timestamp > ?'
    ).bind(since).first<{ count: number }>();
    return result?.count || 0;
  },

  /**
   * Cleanup old analytics data (older than N days).
   */
  async cleanupOldData(db: DB, days: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await db['db'].prepare(
      'DELETE FROM analytics WHERE timestamp < ?'
    ).bind(cutoff).run();
    return result.meta.changes || 0;
  },
};