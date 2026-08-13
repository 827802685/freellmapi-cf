/**
 * Provider 适配器基类
 * 每个供应商继承这个,实现各自的请求转换和响应解析
 */

import type { ChatCompletionRequest } from '../types';

export interface ProviderRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;          // 非流式
  stream?: ReadableStream<Uint8Array>;  // 流式
}

export interface ProviderError {
  status: number;
  message: string;
  code?: string;
  retryable: boolean;
}

export abstract class BaseProvider {
  abstract name: string;
  abstract baseUrl: string;

  /**
   * 把 OpenAI 格式请求转换为此供应商的请求
   */
  abstract transformRequest(
    req: ChatCompletionRequest,
    apiKey: string,
    model: string
  ): ProviderRequest;

  /**
   * 解析非流式响应为 OpenAI ChatCompletion 格式
   * 上游已是 OpenAI 兼容时直接返回
   */
  abstract parseResponse(
    body: unknown,
    model: string
  ): unknown;

  /**
   * 健康检查:发一个最小请求
   * 返回 { ok, status, message }
   */
  abstract healthCheck(apiKey: string): Promise<{ ok: boolean; status: number; message?: string }>;

  /**
   * 拉取远程模型列表(可选,部分 provider 实现)
   * 返回模型 ID 数组,用于自动发现新模型
   */
  async listModels?(apiKey: string): Promise<string[]>;

  /**
   * 判断错误是否可重试
   */
  isRetryable(err: ProviderError): boolean {
    if (err.status === 429) return true;
    if (err.status >= 500) return true;
    if (err.status === 408 || err.status === 504) return true;
    return false;
  }
}

/**
 * 通用工具:JSON 安全的 fetch
 */
export async function safeFetch(
  url: string,
  init: RequestInit
): Promise<{ status: number; body: unknown; headers: Headers; raw: Response }> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  let body: unknown;
  if (ct.includes('application/json')) {
    body = await res.json().catch(() => null);
  } else {
    body = await res.text();
  }
  return { status: res.status, body, headers: res.headers, raw: res };
}

export function detectProviderError(status: number, body: unknown): ProviderError {
  const data = body as Record<string, unknown> | undefined | null;
  const err = data?.error as Record<string, unknown> | undefined;
  const message =
    (err?.message as string) ||
    (data?.message as string) ||
    (err?.code as string) ||
    `Upstream returned ${status}`;
  return {
    status,
    message,
    code: (err?.code as string) || (err?.type as string),
    retryable: status === 429 || status >= 500 || status === 408 || status === 504,
  };
}
