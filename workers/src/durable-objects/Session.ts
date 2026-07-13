/**
 * Durable Object: Sticky Session
 * 同一会话(由 client 生成的 session_id 标识)30 分钟内持续路由到同一平台+模型
 * 减少多轮对话中途切换模型导致的幻觉尖峰
 */

const DEFAULT_TTL_MINUTES = 30;

export class Session implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, '');

    switch (action) {
      case 'get':
        return this.get();
      case 'set':
        return this.set(request);
      case 'touch':
        return this.touch(request);
      case 'clear':
        return this.clear();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async get(): Promise<Response> {
    const data = (await this.state.storage.get<any>('session')) || null;
    const now = Math.floor(Date.now() / 1000);
    if (data && data.expires_at < now) {
      await this.state.storage.delete('session');
      return Response.json({ session: null });
    }
    return Response.json({ session: data });
  }

  private async set(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      platform: string;
      model: string;
      ttlMinutes?: number;
    };
    const now = Math.floor(Date.now() / 1000);
    const ttl = (body.ttlMinutes || DEFAULT_TTL_MINUTES) * 60;
    const data = {
      platform: body.platform,
      model: body.model,
      expires_at: now + ttl,
      created_at: now,
    };
    await this.state.storage.put('session', data);
    // DO storage 自带 alarm 清理
    await this.state.storage.setAlarm(now + ttl + 60);
    return Response.json({ session: data });
  }

  private async touch(request: Request): Promise<Response> {
    const body = (await request.json()) as { ttlMinutes?: number };
    const data = (await this.state.storage.get<any>('session'));
    if (!data) return Response.json({ session: null });
    const now = Math.floor(Date.now() / 1000);
    const ttl = (body.ttlMinutes || DEFAULT_TTL_MINUTES) * 60;
    data.expires_at = now + ttl;
    await this.state.storage.put('session', data);
    return Response.json({ session: data });
  }

  private async clear(): Promise<Response> {
    await this.state.storage.delete('session');
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    await this.state.storage.delete('session');
  }
}

export function getSessionStub(
  env: { SESSION: DurableObjectNamespace },
  sessionId: string
): DurableObjectStub {
  const id = env.SESSION.idFromName(sessionId);
  return env.SESSION.get(id);
}
