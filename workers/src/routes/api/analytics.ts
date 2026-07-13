/**
 * /api/analytics - 请求日志和统计
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { requireDashboardAuth } from '../../lib/auth';
import { getSetting } from '../../lib/response';

export const analyticsRoute = new Hono<{ Bindings: Env }>();
analyticsRoute.use('*', requireDashboardAuth);

analyticsRoute.get('/summary', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 86400 * 7;

  const [total, lastDay, lastWeek, successRate, platformBreakdown, modelBreakdown] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as c FROM request_logs').first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM request_logs WHERE created_at >= ?').bind(dayAgo).first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM request_logs WHERE created_at >= ?').bind(weekAgo).first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(CASE WHEN status_code < 400 THEN 1 END) as s, COUNT(*) as t FROM request_logs WHERE created_at >= ?').bind(weekAgo).first<{ s: number; t: number }>(),
    c.env.DB.prepare('SELECT platform, COUNT(*) as c, AVG(latency_ms) as avg_latency FROM request_logs WHERE created_at >= ? GROUP BY platform ORDER BY c DESC').bind(weekAgo).all(),
    c.env.DB.prepare('SELECT model, platform, COUNT(*) as c FROM request_logs WHERE created_at >= ? GROUP BY model, platform ORDER BY c DESC LIMIT 20').bind(weekAgo).all(),
  ]);

  return c.json({
    total: total?.c || 0,
    lastDay: lastDay?.c || 0,
    lastWeek: lastWeek?.c || 0,
    successRate: successRate?.t ? successRate.s / successRate.t : 0,
    platformBreakdown: platformBreakdown.results,
    modelBreakdown: modelBreakdown.results,
  });
});

analyticsRoute.get('/recent', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const rows = await c.env.DB.prepare(
    'SELECT id, model, platform, key_id, status_code, latency_ms, prompt_tokens, completion_tokens, total_tokens, stream, created_at FROM request_logs ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  return c.json({ logs: rows.results });
});

// 清理旧数据
analyticsRoute.post('/cleanup', async (c) => {
  const days = parseInt(await getSetting(c.env.DB, 'analytics_retention_days', '90'), 10);
  const maxRows = parseInt(await getSetting(c.env.DB, 'analytics_max_rows', '100000'), 10);

  let deleted = 0;
  if (days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const r = await c.env.DB.prepare('DELETE FROM request_logs WHERE created_at < ?').bind(cutoff).run();
    deleted += (r.meta as any).changes || 0;
  }
  if (maxRows > 0) {
    // 保留最新的 N 条
    await c.env.DB.prepare(`
      DELETE FROM request_logs WHERE id NOT IN (
        SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ?
      )
    `).bind(maxRows).run();
  }
  return c.json({ deleted });
});
