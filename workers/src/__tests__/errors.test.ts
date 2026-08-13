/**
 * 统一错误处理单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  createError,
  unauthorized,
  notFound,
  rateLimitError,
  noRoute,
  invalidRequest,
  validationError,
  serverError,
  errorToJson,
  extractErrorMessage,
  safeJsonParse,
  safeExecute,
  safeExecuteSync,
} from '../lib/errors';

describe('createError', () => {
  it('should create error with correct fields', () => {
    const err = createError(400, 'invalid_request_error', 'Bad request', { field: 'name' });
    expect(err.status).toBe(400);
    expect(err.type).toBe('invalid_request_error');
    expect(err.message).toBe('Bad request');
    expect(err.details).toEqual({ field: 'name' });
  });
});

describe('error factories', () => {
  it('unauthorized()', () => {
    const err = unauthorized();
    expect(err.status).toBe(401);
    expect(err.type).toBe('unauthorized');
  });

  it('notFound()', () => {
    const err = notFound();
    expect(err.status).toBe(404);
    expect(err.type).toBe('not_found');
  });

  it('rateLimitError()', () => {
    const err = rateLimitError();
    expect(err.status).toBe(429);
    expect(err.type).toBe('rate_limit_error');
  });

  it('noRoute()', () => {
    const err = noRoute();
    expect(err.status).toBe(503);
    expect(err.type).toBe('no_route');
  });

  it('invalidRequest()', () => {
    const err = invalidRequest('Invalid model');
    expect(err.status).toBe(400);
    expect(err.message).toBe('Invalid model');
  });

  it('validationError()', () => {
    const err = validationError('Missing field', { field: 'model' });
    expect(err.status).toBe(400);
    expect(err.details?.field).toBe('model');
  });

  it('serverError()', () => {
    const err = serverError();
    expect(err.status).toBe(500);
    expect(err.type).toBe('server_error');
  });
});

describe('errorToJson', () => {
  it('should convert AppError to JSON response format', () => {
    const err = unauthorized('Invalid token');
    const json = errorToJson(err);
    expect(json.error.message).toBe('Invalid token');
    expect(json.error.type).toBe('unauthorized');
    expect(json.error.code).toBe('unauthorized');
  });

  it('should include details when present', () => {
    const err = validationError('Bad input', { field: 'email' });
    const json = errorToJson(err);
    expect(json.error.details?.field).toBe('email');
  });
});

describe('extractErrorMessage', () => {
  it('should extract from Error instance', () => {
    expect(extractErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('should extract from string', () => {
    expect(extractErrorMessage('raw string')).toBe('raw string');
  });

  it('should extract from object with message', () => {
    expect(extractErrorMessage({ message: 'obj msg' })).toBe('obj msg');
  });

  it('should return fallback for unknown types', () => {
    expect(extractErrorMessage(42, 'default')).toBe('default');
  });

  it('should return default fallback', () => {
    expect(extractErrorMessage(null)).toBe('Unknown error');
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('should return fallback for invalid JSON', () => {
    expect(safeJsonParse('invalid', { fallback: true })).toEqual({ fallback: true });
  });
});

describe('safeExecute', () => {
  it('should return value on success', async () => {
    const result = await safeExecute(async () => 'ok', 'fail');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('ok');
  });

  it('should return error on failure', async () => {
    const result = await safeExecute(async () => { throw new Error('boom'); }, 'failed', 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(500);
  });
});

describe('safeExecuteSync', () => {
  it('should return value on success', () => {
    const result = safeExecuteSync(() => 42, 'fail');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('should return error on failure', () => {
    const result = safeExecuteSync(() => { throw new Error('sync boom'); }, 'sync failed');
    expect(result.ok).toBe(false);
  });
});