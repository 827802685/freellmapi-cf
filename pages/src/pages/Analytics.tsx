import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function AnalyticsPage() {
  const [summary, setSummary] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getSummary(), api.getRecent(50)]).then(([s, r]) => {
      setSummary(s);
      setRecent(r.logs);
      setLoading(false);
    });
  }, []);

  if (loading) return <div>加载中...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Analytics</h1>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="总请求" value={summary.total} />
          <StatCard label="24h" value={summary.lastDay} />
          <StatCard label="7天" value={summary.lastWeek} />
          <StatCard label="成功率 (7d)" value={`${(summary.successRate * 100).toFixed(1)}%`} />
        </div>
      )}

      {summary?.platformBreakdown?.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">按供应商 (7d)</h2>
          <div className="space-y-2">
            {summary.platformBreakdown.map((p: any) => (
              <div key={p.platform} className="flex items-center justify-between text-sm">
                <span className="badge-muted">{p.platform}</span>
                <div className="flex-1 mx-4">
                  <div className="bg-bg-tertiary rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-accent-primary h-full"
                      style={{ width: `${(p.c / summary.platformBreakdown[0].c) * 100}%` }}
                    />
                  </div>
                </div>
                <span className="text-text-secondary w-20 text-right">{p.c} 次</span>
                <span className="text-text-muted w-20 text-right">{Math.round(p.avg_latency || 0)}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        <div className="p-6 pb-3">
          <h2 className="text-lg font-semibold">最近请求</h2>
        </div>
        <table className="w-full">
          <thead className="bg-bg-tertiary border-y border-border-subtle">
            <tr>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">时间</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">模型</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">平台</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">状态</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">延迟</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((l: any) => (
              <tr key={l.id} className="border-b border-border-subtle hover:bg-bg-tertiary/50">
                <td className="py-2 px-4 text-xs text-text-muted">
                  {new Date(l.created_at * 1000).toLocaleTimeString()}
                </td>
                <td className="py-2 px-4 text-xs font-mono">{l.model}</td>
                <td className="py-2 px-4"><span className="badge-muted">{l.platform}</span></td>
                <td className="py-2 px-4">
                  {l.status_code < 400 ? (
                    <span className="badge-healthy">{l.status_code}</span>
                  ) : (
                    <span className="badge-danger">{l.status_code}</span>
                  )}
                </td>
                <td className="py-2 px-4 text-xs text-text-secondary">{l.latency_ms}ms</td>
                <td className="py-2 px-4 text-xs text-text-secondary">{l.total_tokens || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: any }) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
