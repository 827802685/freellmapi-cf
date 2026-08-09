// ============================================================
// FreeLLM API - Analytics Service
// ============================================================

import type { AnalyticsRecord, AdminStats, ApiResponse } from '../types';
import { Db } from '../lib/db';

export class AnalyticsService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async recordRequest(data: {
    modelId: string;
    provider: string;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    status: string;
    ipAddress: string | null;
    userId: number | null;
    apiKeyId: number | null;
    cost: number;
  }): Promise<void> {
    const record: Omit<AnalyticsRecord, 'id'> = {
      timestamp: new Date().toISOString(),
      model_id: data.modelId,
      provider: data.provider,
      request_duration_ms: data.durationMs,
      prompt_tokens: data.promptTokens,
      completion_tokens: data.completionTokens,
      total_tokens: data.promptTokens + data.completionTokens,
      status: data.status,
      ip_address: data.ipAddress,
      user_id: data.userId,
      api_key_id: data.apiKeyId,
      cost: data.cost,
    };

    await this.db.recordAnalytics(record);
  }

  async getStats(): Promise<AdminStats> {
    return this.db.getAdminStats();
  }

  async getAnalyticsList(
    page: number,
    pageSize: number,
    filters?: { model?: string; status?: string; from?: string; to?: string }
  ): Promise<ApiResponse<{ records: AnalyticsRecord[]; total: number }>> {
    try {
      const result = await this.db.getAnalytics(page, pageSize, filters);
      return {
        success: true,
        data: result,
        pagination: {
          page,
          page_size: pageSize,
          total: result.total,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取分析数据失败',
      };
    }
  }

  calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number {
    // Default pricing per 1K tokens (in USD)
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 0.0025, output: 0.01 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-4': { input: 0.03, output: 0.06 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
      'claude-3-5-haiku-20241022': { input: 0.0008, output: 0.004 },
      'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
      'deepseek-chat': { input: 0.00014, output: 0.00028 },
      'deepseek-reasoner': { input: 0.00055, output: 0.00219 },
      'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
      'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
      'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
      'llama-3.3-70b-versatile': { input: 0.00059, output: 0.00079 },
      'llama-3.1-8b-instant': { input: 0.00005, output: 0.00008 },
    };

    const price = pricing[model] || { input: 0.001, output: 0.002 };
    const inputCost = (promptTokens / 1000) * price.input;
    const outputCost = (completionTokens / 1000) * price.output;
    return inputCost + outputCost;
  }
}