/**
 * 响应工具单元测试
 * 注意:这些测试在标准 Node 环境中运行,不依赖 Cloudflare Workers 运行时。
 * 因此测试仅覆盖纯逻辑部分(getSetting/setSetting 需要 D1 环境,跳过)。
 */
import { describe, it, expect, vi } from 'vitest';

// 模拟 Context
function mockContext() {
  return {
    json: vi.fn((data: unknown, status?: number) => new Response(JSON.stringify(data), { status })),
    req: { header: vi.fn() },
    env: {},
    executionCtx: {},
  } as any;
}

describe('response helpers (basic)', () => {
  it('should import without errors', async () => {
    // 验证模块可以被正确导入
    const mod = await import('../lib/response');
    expect(mod.ok).toBeDefined();
    expect(mod.err).toBeDefined();
    expect(mod.notFound).toBeDefined();
    expect(mod.unauthorized).toBeDefined();
    expect(mod.badRequest).toBeDefined();
    expect(mod.serverError).toBeDefined();
    expect(mod.getSetting).toBeDefined();
    expect(mod.setSetting).toBeDefined();
  });
});