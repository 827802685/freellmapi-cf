/**
 * fallback-executor.ts
 *
 * 共享的 fallback 链执行模块。
 * 提取自 chat.ts / completions.ts / messages.ts / responses.ts 中共同的 fallback 循环逻辑。
 *
 * 使用模式:
 * 1. 每个 route 调用 pickRoute + precheckCandidates 获得候选列表
 * 2. 传入 executeFallbackChain,提供 makeRequest / processResponse / onError / onSuccess 回调
 * 3. 返回 { response, fallbackCount } 或 null(全部失败)
 */

import { extractErrorMessage } from './errors';
import type { Env, Platform } from '../types';

// ============= 公开接口 =============

export interface FallbackCandidate {
  platform: Platform;
  model: string;
  keyId: number;
  keyPlaintext: string;
  customBaseUrl?: string | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  healthStatus?: string;
  contextWindow?: number;
}

export interface FallbackRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FallbackResult {
  response: Response;
  candidate: FallbackCandidate;
  fallbackCount: number;
}

export interface FallbackError {
  status: number;
  message: string;
  platform: string;
  model: string;
}

// ============= 执行函数 =============

/**
 * 执行 fallback 链。
 *
 * @param env         - Cloudflare Workers 环境绑定
 * @param candidates  - 按优先级排序的候选列表
 * @param makeRequest - 为每个候选构建上游请求。返回 FallbackRequest 或 null(跳过该候选)
 * @param processResponse - 处理上游 2xx 响应。返回 Response 表示成功;返回 null 表示该候选失败,继续 fallback
 * @param onError     - 每次失败时调用(用于记录日志/更新状态)
 * @param onSuccess   - 成功时调用(用于消费配额/更新 sticky session)
 * @param options     - 可选配置,如 timeoutMs
 * @returns 成功时返回 { response, fallbackCount };全部失败时返回 null
 */
export async function executeFallbackChain(
  env: Env,
  candidates: FallbackCandidate[],
  makeRequest: (candidate: FallbackCandidate, index: number) => Promise<FallbackRequest | null>,
  processResponse: (
    response: Response,
    candidate: FallbackCandidate,
    fallbackCount: number
  ) => Promise<Response | null>,
  onError: (error: FallbackError, candidate: FallbackCandidate) => void,
  onSuccess: (candidate: FallbackCandidate, fallbackCount: number) => void,
  options?: { timeoutMs?: number }
): Promise<{ response: Response; fallbackCount: number } | null> {
  const timeoutMs = options?.timeoutMs ?? 30000;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    // 1) 构建请求
    let req: FallbackRequest;
    try {
      const built = await makeRequest(cand, i);
      if (built === null) {
        // makeRequest 返回 null 表示跳过该候选(如 provider 不支持)
        onError(
          { status: 0, message: 'Skipped by makeRequest', platform: cand.platform, model: cand.model },
          cand
        );
        continue;
      }
      req = built;
    } catch (e: unknown) {
      const msg = extractErrorMessage(e, 'Failed to build request');
      onError({ status: 0, message: msg, platform: cand.platform, model: cand.model }, cand);
      continue;
    }

    // 2) 发起上游请求(带超时)
    let upstreamRes: Response;
    try {
      const fetchController = new AbortController();
      const fetchTimeoutId = setTimeout(() => fetchController.abort(), timeoutMs);
      try {
        upstreamRes = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: fetchController.signal,
        });
      } finally {
        clearTimeout(fetchTimeoutId);
      }
    } catch (e: unknown) {
      const msg = extractErrorMessage(e, 'Fetch failed');
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      const displayMsg = isTimeout ? `Fetch timeout (${timeoutMs}ms)` : msg;
      console.warn(
        `[fallback-executor] ${isTimeout ? 'Timeout' : 'Error'} from ${cand.platform}/${cand.model}: ${displayMsg}`
      );
      onError({ status: 0, message: displayMsg, platform: cand.platform, model: cand.model }, cand);
      continue;
    }

    // 3) 非 2xx → 失败
    if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
      let errBody = '';
      try {
        errBody = await upstreamRes.text();
      } catch {
        // 读 body 失败不影响 fallback
      }
      onError(
        { status: upstreamRes.status, message: errBody.slice(0, 500), platform: cand.platform, model: cand.model },
        cand
      );
      continue;
    }

    // 4) 2xx → 交给 processResponse 处理
    try {
      const processed = await processResponse(upstreamRes, cand, i);
      if (processed === null) {
        // processResponse 返回 null 表示该候选应当被跳过(如空内容/error body)
        // onError 由 processResponse 内部调用
        continue;
      }

      // 成功
      onSuccess(cand, i);
      return { response: processed, fallbackCount: i };
    } catch (e: unknown) {
      const msg = extractErrorMessage(e, 'processResponse failed');
      onError({ status: 0, message: msg, platform: cand.platform, model: cand.model }, cand);
      continue;
    }
  }

  // 所有候选均失败
  return null;
}