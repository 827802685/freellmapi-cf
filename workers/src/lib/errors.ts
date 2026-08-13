/**
 * 统一错误处理工具
 * - 标准化错误类型与响应格式
 * - 消除 catch 静默吞异常
 * - 提供类型安全的错误工厂函数
 */

import type { Context } from 'hono';
import type { Env, ErrorResponse } from '../types';

// ============= 错误类型常量 =============

export const ErrorType = {
  UNAUTHORIZED: 'unauthorized',
  INVALID_SESSION: 'invalid_session',
  NOT_FOUND: 'not_found',
  RATE_LIMIT: 'rate_limit_error',
  NO_ROUTE: 'no_route',
  ALL_COOLDOWN: 'all_cooldown',
  ALL_ROUTES_FAILED: 'all_routes_failed',
  INVALID_REQUEST: 'invalid_request_error',
  SERVER_ERROR: 'server_error',
  VALIDATION_ERROR: 'validation_error',
  QUOTA_EXCEEDED: 'quota_exceeded',
} as const;

export type ErrorTypeValue = (typeof ErrorType)[keyof typeof ErrorType];

// ============= 错误响应工厂 =============

export interface AppError {
  status: number;
  type: ErrorTypeValue;
  message: string;
  details?: Record<string, unknown>;
}

export function createError(
  status: number,
  type: ErrorTypeValue,
  message: string,
  details?: Record<string, unknown>
): AppError {
  return { status, type, message, details };
}

export function unauthorized(message = 'Unauthorized'): AppError {
  return createError(401, ErrorType.UNAUTHORIZED, message);
}

export function notFound(message = 'Not found'): AppError {
  return createError(404, ErrorType.NOT_FOUND, message);
}

export function rateLimitError(message = 'Too many requests'): AppError {
  return createError(429, ErrorType.RATE_LIMIT, message);
}

export function noRoute(message = 'No available route'): AppError {
  return createError(503, ErrorType.NO_ROUTE, message);
}

export function invalidRequest(message: string): AppError {
  return createError(400, ErrorType.INVALID_REQUEST, message);
}

export function validationError(message: string, details?: Record<string, unknown>): AppError {
  return createError(400, ErrorType.VALIDATION_ERROR, message, details);
}

export function serverError(message = 'Internal server error'): AppError {
  return createError(500, ErrorType.SERVER_ERROR, message);
}

// ============= 错误转 JSON 响应 =============

export function errorToJson(err: AppError): ErrorResponse {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.type,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

// ============= Hono 响应快捷方式 =============

export function sendError(c: Context, err: AppError): Response {
  return c.json(errorToJson(err), err.status as 200 | 400 | 401 | 404 | 429 | 500 | 502 | 503);
}

export function sendUnauthorized(c: Context, message?: string): Response {
  return sendError(c, unauthorized(message));
}

export function sendNotFound(c: Context, message?: string): Response {
  return sendError(c, notFound(message));
}

export function sendInvalidRequest(c: Context, message: string): Response {
  return sendError(c, invalidRequest(message));
}

export function sendServerError(c: Context, message?: string): Response {
  return sendError(c, serverError(message));
}

// ============= 安全捕获工具 =============

/**
 * 安全地执行异步操作，catch 到的异常会被记录并转为 AppError。
 * 替代裸 try/catch 中静默吞异常的模式。
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  errorMessage: string,
  context?: string
): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${context || 'safeExecute'}] ${errorMessage}: ${msg}`, e);
    return { ok: false, error: serverError(errorMessage) };
  }
}

/**
 * 安全地执行同步操作，类似 safeExecute 的同步版本。
 */
export function safeExecuteSync<T>(
  fn: () => T,
  errorMessage: string,
  context?: string
): { ok: true; value: T } | { ok: false; error: AppError } {
  try {
    const value = fn();
    return { ok: true, value };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${context || 'safeExecuteSync'}] ${errorMessage}: ${msg}`, e);
    return { ok: false, error: serverError(errorMessage) };
  }
}

/**
 * 从 unknown 异常中提取消息。
 * 用于 catch 块中替代 `e: any` + `e.message`。
 */
export function extractErrorMessage(e: unknown, fallback = 'Unknown error'): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const maybeMsg = (e as Record<string, unknown>).message;
    if (typeof maybeMsg === 'string') return maybeMsg;
  }
  return fallback;
}

/**
 * 安全地解析 JSON，失败时返回默认值而非抛出异常。
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 记录错误并返回一个标准化的 AppError。
 * 替代 catch 块中 `console.error(...)` + `return c.json({ error: ... }, 500)` 的重复模式。
 */
export function logAndReturnError(
  context: string,
  e: unknown,
  errorMessage: string
): AppError {
  const msg = extractErrorMessage(e);
  console.error(`[${context}] ${errorMessage}: ${msg}`);
  if (e instanceof Error && e.stack) {
    console.error(`[${context}] Stack: ${e.stack}`);
  }
  return serverError(errorMessage);
}