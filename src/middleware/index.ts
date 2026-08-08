// Middleware chain for FreeLLMAPI

import type { Env } from '../types';
import { DB } from '../lib/db';
import { Cache } from '../lib/cache';
import { handleCORS, attachCORS } from './cors';
import { verifyAuth } from './auth';
import type { AuthResult } from './auth';

export interface MiddlewareContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  db: DB;
  cache: Cache;
  auth: AuthResult;
}

export type MiddlewareHandler = (
  context: MiddlewareContext,
  next: () => Promise<Response>
) => Promise<Response>;

/**
 * Apply CORS middleware.
 * Returns a preflight response for OPTIONS requests, otherwise passes through.
 */
async function corsMiddleware(
  context: MiddlewareContext,
  next: () => Promise<Response>
): Promise<Response> {
  const corsResponse = handleCORS(context.request);
  if (corsResponse) return corsResponse;

  const response = await next();
  return attachCORS(response);
}

/**
 * Apply authentication middleware.
 * Populates context.auth with user/apiKey info.
 */
async function authMiddleware(
  context: MiddlewareContext,
  next: () => Promise<Response>
): Promise<Response> {
  context.auth = await verifyAuth(context.request, context.env, context.db);
  return next();
}

/**
 * Compose middleware functions into a single handler.
 * Middleware is executed in the order they are provided.
 */
export function composeMiddleware(...middleware: MiddlewareHandler[]): MiddlewareHandler {
  return async (context: MiddlewareContext, next: () => Promise<Response>): Promise<Response> => {
    const dispatch = (index: number): Promise<Response> => {
      if (index >= middleware.length) {
        return next();
      }
      return middleware[index](context, () => dispatch(index + 1));
    };
    return dispatch(0);
  };
}

/**
 * Default middleware chain: CORS -> Auth
 */
export const defaultMiddleware = composeMiddleware(corsMiddleware, authMiddleware);

/**
 * Create a full middleware context from request components.
 */
export function createContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  db: DB,
  cache: Cache
): MiddlewareContext {
  return {
    request,
    env,
    ctx,
    db,
    cache,
    auth: { user: null, apiKey: null },
  };
}

/**
 * Run the default middleware chain and return the response.
 * The route handler receives the enriched context.
 */
export async function runMiddleware(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  db: DB,
  cache: Cache,
  routeHandler: (context: MiddlewareContext) => Promise<Response>
): Promise<Response> {
  const context = createContext(request, env, ctx, db, cache);
  return defaultMiddleware(context, () => routeHandler(context));
}