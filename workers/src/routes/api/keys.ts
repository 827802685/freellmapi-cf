/**
 * /api/keys - API Key 管理
 *
 * ⭐ 这里是用户最初要求改造的 UI 部分,后端 API 已经为"添加后立刻显示"准备好
 *
 * - GET    /api/keys           列表(只返 hint,不返明文)
 * - POST   /api/keys           添加(返回完整 key 一次!!)
 * - GET    /api/keys/:id       详情(只返 hint)
 * - GET    /api/keys/:id/plain 临时获取明文(记录审计)
 * - PATCH  /api/keys/:id       改 label / enabled
 * - DELETE /api/keys/:id       删除
 * - POST   /api/keys/:id/check 健康检查
 */

import { Hono } from 'hono';
import type { Env, ApiKey, Platform, ChatCompletionRequest } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { encryptApiKey, decrypt, makeKeyHint, randomB64Url } from '../../lib/crypto';
import { getProvider, PLATFORM_LABELS } from '../../providers';
import { getSetting } from '../../lib/response';
import { err, ok, notFound, badRequest } from '../../lib/response';
import { detectVisionSupport, detectToolSupport } from '../../lib/model-meta';

export const keysRoute = new Hono<{ Bindings: Env }>();
keysRoute.use('*', requireDashboardAuth);

// 列表(转 camelCase,跟前端类型对齐)
keysRoute.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, platform, label, key_hint, enabled, health_status, last_checked_at, created_at, updated_at, custom_base_url, custom_models FROM api_keys ORDER BY id'
  ).all<{
    id: number; platform: string; label: string | null; key_hint: string; enabled: number;
    health_status: string; last_checked_at: number | null; created_at: number; updated_at: number;
    custom_base_url: string | null; custom_models: string | null;
  }>();
  const keys = (rows.results || []).map(r => ({
    id: r.id,
    platform: r.platform,
    label: r.label,
    keyHint: r.key_hint,
    enabled: r.enabled,
    healthStatus: r.health_status,
    lastCheckedAt: r.last_checked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    customBaseUrl: r.custom_base_url,
    customModels: r.custom_models,
  }));
  return c.json({ keys });
});

// 添加(⭐ 重点:返回明文一次)
keysRoute.post('/', async (c) => {
  const body = await c.req.json<{ platform: Platform; key: string; label?: string; customBaseUrl?: string; customModels?: string }>();
  if (!body.platform || !body.key) {
    return badRequest(c, 'platform and key are required');
  }
  if (body.platform === 'custom' && !body.customBaseUrl) {
    return badRequest(c, 'custom platform requires customBaseUrl');
  }
  if (body.key.length < 8) {
    return badRequest(c, 'Key too short');
  }

  const { encrypted, hint } = await encryptApiKey(body.key, c.env.ENCRYPTION_KEY);

  const result = await c.env.DB.prepare(
    `INSERT INTO api_keys (platform, label, key_ciphertext, key_iv, key_tag, key_hint, custom_base_url, custom_models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    body.platform,
    body.label || null,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    hint,
    body.customBaseUrl || null,
    body.customModels || null
  ).first<{ id: number }>();

  // 如果有 customModels,同步写入 models 表(这样试玩台能选到)
  if (body.customModels && body.customModels.trim()) {
    const modelNames = body.customModels.split(',').map(m => m.trim()).filter(Boolean);
    for (const modelName of modelNames) {
      const modelId = `${body.platform}:${modelName}`;
      await c.env.DB.prepare(
        `INSERT INTO models (id, platform, model_name, display_name, enabled, source)
         VALUES (?, ?, ?, ?, 1, 'custom')
         ON CONFLICT(id) DO UPDATE SET updated_at = unixepoch()`
      ).bind(modelId, body.platform, modelName, modelName).run();
    }
  }

  // 异步:健康检查 + 模型同步(custom 走 baseUrl)
  c.executionCtx.waitUntil((async () => {
    await checkAndUpdateHealth(c.env, result!.id, body.platform, body.key, body.customBaseUrl);
    // 非 custom 平台:自动拉取上游模型列表同步到 models 表
    if (body.platform !== 'custom' && !body.customModels) {
      try {
        const provider = getProvider(body.platform, body.customBaseUrl);
        // 优先用 provider 自带的 listModels(处理 Google/CF 等非标准 API)
        // 否则回退到 OpenAI 兼容的 Bearer + baseUrl/models
        let remoteModels: string[] = [];
        if (typeof provider.listModels === 'function') {
          remoteModels = await provider.listModels(body.key);
        } else {
          const res = await fetch(provider.baseUrl + '/models', {
            headers: { 'Authorization': `Bearer ${body.key}` },
          });
          if (res.ok) {
            const data = await res.json() as { data?: { id: string }[] };
            remoteModels = (data.data || []).map(m => m.id);
          }
        }
        if (remoteModels.length > 0) {
          const existing = await c.env.DB.prepare(
            'SELECT model_name FROM models WHERE platform = ?'
          ).bind(body.platform).all<{ model_name: string }>();
          const existingSet = new Set((existing.results || []).map(m => m.model_name));
          for (const modelName of remoteModels) {
            if (existingSet.has(modelName)) continue;
            const supportsVision = detectVisionSupport(modelName);
            const supportsTools = detectToolSupport(modelName);
            await c.env.DB.prepare(
              `INSERT OR IGNORE INTO models (id, platform, model_name, display_name, enabled, supports_vision, supports_tools, source)
               VALUES (?, ?, ?, ?, 1, ?, ?, 'auto')`
            ).bind(`${body.platform}:${modelName}`, body.platform, modelName, modelName, supportsVision, supportsTools).run();
          }
        }
      } catch (e: unknown) {
        // 模型同步失败不影响 key 添加
      }
    }
  })());

  // ⭐ 关键:立刻返回完整 key,UI 才能在弹窗里展示
  return ok(c, {
    id: result!.id,
    platform: body.platform,
    label: body.label,
    keyHint: hint,
    keyPlain: body.key,  // 一次性返回,前端展示后必须丢弃
    enabled: 1,
    healthStatus: 'unknown',
    customBaseUrl: body.customBaseUrl || null,
    customModels: body.customModels || null,
  }, 201);
});

// 详情(只返 hint,绝不返明文)
keysRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, platform, label, key_hint, enabled, health_status, last_checked_at, created_at, updated_at FROM api_keys WHERE id = ?'
  ).bind(id).first();
  if (!row) return notFound(c);
  return c.json({
    key: {
      id: row.id,
      platform: row.platform,
      label: row.label,
      keyHint: row.key_hint,
      enabled: row.enabled,
      healthStatus: row.health_status,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
});

// ⭐ 临时获取明文(用于 UI 临时显示/复制)
keysRoute.get('/:id/plain', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT key_ciphertext, key_iv, key_tag, key_hint FROM api_keys WHERE id = ?'
  ).bind(id).first<{ key_ciphertext: string; key_iv: string; key_tag: string; key_hint: string }>();
  if (!row) return notFound(c);

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );

  // 审计日志(谁看过明文)
  const session = c.get('session');
  console.log(`[AUDIT] account=${session.email} revealed key id=${id} hint=${row.key_hint}`);

  return c.json({ keyPlain: plaintext, keyHint: row.key_hint });
});

// 改 label / enabled
keysRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; enabled?: number }>();
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (body.label !== undefined) { updates.push('label = ?'); values.push(body.label); }
  if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled); }
  if (updates.length === 0) return badRequest(c, 'Nothing to update');
  updates.push('updated_at = unixepoch()');
  values.push(id);
  await c.env.DB.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
  return ok(c, { updated: true });
});

// 删除
keysRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  return ok(c, { deleted: true });
});

// 试玩:用这个 key 真正调一次上游,看响应
// POST /api/keys/:id/chat
// body: { model: string, messages: ChatMsg[], stream?: boolean, maxTokens?: number }
keysRoute.post('/:id/chat', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, platform, key_ciphertext, key_iv, key_tag, custom_base_url, label FROM api_keys WHERE id = ?'
  ).bind(id).first<{ id: number; platform: Platform; key_ciphertext: string; key_iv: string; key_tag: string; custom_base_url: string | null; label: string | null }>();
  if (!row) return notFound(c);
  if (!row.key_ciphertext) return err(c, 'No key material stored', 400, 'no_key_material');

  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return badRequest(c, 'Invalid JSON'); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return badRequest(c, 'messages must be non-empty');
  const model = String(body.model || 'default');
  const stream = !!body.stream;
  const maxTokens = body.maxTokens || 256;

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );
  const provider = getProvider(row.platform, row.custom_base_url || undefined);
  const upstreamReq = provider.transformRequest(
    { model, messages, stream, max_tokens: maxTokens } as ChatCompletionRequest,
    plaintext,
    model
  );

  // 8s 硬超时,保护 worker
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 8000);
  const start = Date.now();
  try {
    const res = await fetch(upstreamReq.url, {
      method: upstreamReq.method,
      headers: upstreamReq.headers,
      body: upstreamReq.body,
      signal: ac.signal,
    });
    clearTimeout(timeoutId);
    const latency = Date.now() - start;

    if (stream) {
      // 透传 SSE
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          'X-Latency-Ms': String(latency),
          'X-Platform': row.platform,
          'X-Model': model,
          'Access-Control-Expose-Headers': 'X-Latency-Ms, X-Platform, X-Model',
        },
      });
    } else {
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json',
          'X-Latency-Ms': String(latency),
          'X-Platform': row.platform,
          'X-Model': model,
          'Access-Control-Expose-Headers': 'X-Latency-Ms, X-Platform, X-Model',
        },
      });
    }
  } catch (e: unknown) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error && e.name === 'AbortError' ? 'Upstream timeout (8s)' : e instanceof Error ? e.message : String(e);
    return err(c, msg, 504, 'upstream_failed');
  }
});

// 批量检查所有密钥健康状态
// POST /api/keys/check-all
keysRoute.post('/check-all', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, platform, key_ciphertext, key_iv, key_tag, custom_base_url, key_hint, label FROM api_keys WHERE enabled = 1 ORDER BY platform'
  ).all<{
    id: number; platform: string; key_ciphertext: string; key_iv: string; key_tag: string;
    custom_base_url: string | null; key_hint: string; label: string | null;
  }>();

  const allKeys = rows.results || [];
  if (allKeys.length === 0) {
    return c.json({ ok: true, results: [], message: 'No enabled keys to check' });
  }

  // 后台异步批量检查
  c.executionCtx.waitUntil((async () => {
    const results = await Promise.all(allKeys.map(async (k) => {
      try {
        const plaintext = await decrypt(
          { ciphertext: k.key_ciphertext, iv: k.key_iv, tag: k.key_tag },
          c.env.ENCRYPTION_KEY
        );
        const provider = getProvider(k.platform as Platform, k.custom_base_url || undefined);
        const result = await Promise.race([
          provider.healthCheck(plaintext),
          new Promise<{ ok: false; status: 0; message: string }>((resolve) =>
            setTimeout(() => resolve({ ok: false, status: 0, message: 'Health check timeout (8s)' }), 8000)
          ),
        ]);
        let status: string;
        if (result.ok) {
          status = 'healthy';
        } else if (result.status === 401 || result.status === 403) {
          status = 'invalid';
        } else if (result.status === 429) {
          status = 'rate_limited';
        } else {
          status = 'error';
        }
        await c.env.DB.prepare(
          'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
        ).bind(status, k.id).run();
        return { id: k.id, platform: k.platform, hint: k.key_hint, ok: result.ok, status, detail: result.message };
      } catch (e: unknown) {
        await c.env.DB.prepare(
          'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
        ).bind('error', k.id).run();
        return { id: k.id, platform: k.platform, hint: k.key_hint, ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) };
      }
    }));

    const healthy = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`[health-check] Batch complete: ${healthy} healthy, ${failed} failed (${results.length} total)`);
  })());

  return c.json({ ok: true, total: allKeys.length, message: 'Batch health check started, results will be updated shortly.' });
});

// 重置所有密钥健康状态为 healthy
// POST /api/keys/reset-health
keysRoute.post('/reset-health', async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE api_keys SET health_status = 'healthy', last_checked_at = 0 WHERE enabled = 1"
  ).run();
  // 也重置模型的健康状态
  const modelResult = await c.env.DB.prepare(
    "UPDATE models SET health_status = 'healthy' WHERE enabled = 1"
  ).run();
  // 清除 KV 中的模型失败计数
  try {
    const kvList = await c.env.CONFIG.list({ prefix: 'model_fails:' });
    if (kvList.keys.length > 0) {
      await Promise.all(kvList.keys.map(k => c.env.CONFIG.delete(k.name)));
    }
  } catch { /* ignore */ }
  return c.json({
    ok: true,
    keysReset: result.meta?.changes || 0,
    modelsReset: modelResult.meta?.changes || 0,
  });
});

// 健康检查 - 改为后台异步,POST 立即返回,前端 1.5s 后再 load 一次就能看到新状态
keysRoute.post('/:id/check', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT platform, key_ciphertext, key_iv, key_tag, custom_base_url FROM api_keys WHERE id = ?'
  ).bind(id).first<{ platform: Platform; key_ciphertext: string; key_iv: string; key_tag: string; custom_base_url: string | null }>();
  if (!row) return notFound(c);

  // 先把状态置为"检查中"(UI 不会显示这个值,只是为了占位)
  await c.env.DB.prepare(
    'UPDATE api_keys SET last_checked_at = unixepoch() WHERE id = ?'
  ).bind(id).run();

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );

  // 后台异步跑检查(用 AbortController 给个 8s 上限,避免上游慢导致 worker 超时)
  const ac = new AbortController();
  c.executionCtx.waitUntil((async () => {
    try {
      const provider = getProvider(row.platform, row.custom_base_url || undefined);
      // 给 provider 注入 signal —— base class 没用,但 healthCheck 内部 fetch 可能受它影响
      const result = await Promise.race([
        provider.healthCheck(plaintext),
        new Promise<{ ok: false; status: 0; message: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, status: 0, message: 'Health check timeout (8s)' }), 8000)
        ),
      ]);
      // 根据状态码细分: healthy / invalid / rate_limited / error
      let status: string;
      if (result.ok) {
        status = 'healthy';
      } else if (result.status === 401 || result.status === 403) {
        status = 'invalid';
      } else if (result.status === 429) {
        status = 'rate_limited';
      } else {
        status = 'error';
      }
      await c.env.DB.prepare(
        'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
      ).bind(status, id).run();
    } catch (e: unknown) {
      await c.env.DB.prepare(
        'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
      ).bind('error', id).run();
    }
  })());

  // 立即返回,前端 ~1.5s 后再 load() 就能看到结果
  return c.json({ ok: true, status: 'checking', message: 'Health check started, refresh in a moment.' });
});

async function checkAndUpdateHealth(env: Env, id: number, platform: Platform, keyPlain: string, customBaseUrl?: string) {
  try {
    const provider = getProvider(platform, customBaseUrl);
    const result = await provider.healthCheck(keyPlain);
    let status: string;
    if (result.ok) {
      status = 'healthy';
    } else if (result.status === 401 || result.status === 403) {
      status = 'invalid';
    } else if (result.status === 429) {
      status = 'rate_limited';
    } else {
      status = 'error';
    }
    await env.DB.prepare(
      'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
    ).bind(status, id).run();
    return { ...result, healthStatus: status };
  } catch (e: unknown) {
    // ⭐ 之前 catch 里没写 D1,所以超时/网络错误时 health_status 字段没更新,UI 看起来"刷新不了"
    await env.DB.prepare(
      'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
    ).bind('error', id).run();
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e), healthStatus: 'error' };
  }
}

// 用真实 chat completions 请求测试密钥是否可用
// POST /api/keys/:id/test
// 发一个最小请求("hi"),返回上游响应状态码和内容
keysRoute.post('/:id/test', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, platform, key_ciphertext, key_iv, key_tag, custom_base_url, label FROM api_keys WHERE id = ?'
  ).bind(id).first<{ id: number; platform: Platform; key_ciphertext: string; key_iv: string; key_tag: string; custom_base_url: string | null; label: string | null }>();
  if (!row) return notFound(c);
  if (!row.key_ciphertext) return err(c, 'No key material stored', 400, 'no_key_material');

  const body = await c.req.json<{ model?: string }>().catch(() => ({} as { model?: string }));
  const model = body.model || '';

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );

  try {
    const provider = getProvider(row.platform, row.custom_base_url || undefined);
    const testReq = provider.transformRequest(
      { model, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 50 } as ChatCompletionRequest,
      plaintext,
      model
    );

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 10000);
    const start = Date.now();

    const res = await fetch(testReq.url, {
      method: testReq.method,
      headers: testReq.headers,
      body: testReq.body,
      signal: ac.signal,
    });
    clearTimeout(timeoutId);
    const latency = Date.now() - start;

    let responseBody: string | null = null;
    try {
      if (res.headers.get('content-type')?.includes('json')) {
        responseBody = JSON.stringify(await res.json(), null, 2).slice(0, 500);
      } else {
        responseBody = (await res.text()).slice(0, 500);
      }
    } catch { /* ignore */ }

    // 更新健康状态
    let healthStatus: string;
    if (res.ok) {
      healthStatus = 'healthy';
    } else if (res.status === 401 || res.status === 403) {
      healthStatus = 'invalid';
    } else if (res.status === 429) {
      healthStatus = 'rate_limited';
    } else {
      healthStatus = 'error';
    }
    await c.env.DB.prepare(
      'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
    ).bind(healthStatus, row.id).run();

    return c.json({
      ok: res.ok,
      status: res.status,
      latency,
      healthStatus,
      model,
      platform: row.platform,
      response: responseBody,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error && e.name === 'AbortError' ? 'Upstream timeout (10s)' : e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      'UPDATE api_keys SET health_status = ?, last_checked_at = unixepoch() WHERE id = ?'
    ).bind('error', row.id).run();
    return err(c, msg, 504, 'upstream_failed');
  }
});

// 同步模型 - 从 provider 的 /v1/models 拉取所有可用模型,写入 models 表
keysRoute.post('/:id/sync-models', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT platform, key_ciphertext, key_iv, key_tag, custom_base_url FROM api_keys WHERE id = ?'
  ).bind(id).first<{ platform: Platform; key_ciphertext: string; key_iv: string; key_tag: string; custom_base_url: string | null }>();
  if (!row) return notFound(c);

  const plaintext = await decrypt(
    { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag },
    c.env.ENCRYPTION_KEY
  );

  const provider = getProvider(row.platform, row.custom_base_url || undefined);

  try {
    // 优先用 provider 自带的 listModels(处理 Google/CF 等非标准 API)
    let remoteModels: string[] = [];
    if (typeof provider.listModels === 'function') {
      remoteModels = await provider.listModels(plaintext);
    } else {
      const res = await fetch(provider.baseUrl + '/models', {
        headers: { 'Authorization': `Bearer ${plaintext}` },
      });
      if (!res.ok) {
        return err(c, `Provider returned ${res.status}: ${await res.text()}`, 502, 'upstream_failed');
      }
      const data = await res.json() as { data?: { id: string }[] };
      remoteModels = (data.data || []).map(m => m.id);
    }

    // 查现有模型
    const existing = await c.env.DB.prepare(
      'SELECT model_name FROM models WHERE platform = ?'
    ).bind(row.platform).all<{ model_name: string }>();
    const existingSet = new Set((existing.results || []).map(m => m.model_name));

    // 插入新模型
    let added = 0;
    for (const modelName of remoteModels) {
      if (existingSet.has(modelName)) continue;
      await c.env.DB.prepare(
        'INSERT INTO models (id, platform, model_name, enabled) VALUES (?, ?, ?, 1)'
      ).bind(`${row.platform}:${modelName}`, row.platform, modelName).run();
      added++;
    }

    return c.json({ ok: true, platform: row.platform, total: remoteModels.length, added, skipped: remoteModels.length - added });
  } catch (e: unknown) {
    return err(c, e instanceof Error ? e.message : String(e), 500, 'sync_failed');
  }
});
