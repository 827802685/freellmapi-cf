import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';

export function AnalyticsPage() {
  const t = useT();
  const [summary, setSummary] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllRecent, setShowAllRecent] = useState(false);

  useEffect(() => {
    Promise.all([api.getSummary(), api.getRecent(50)]).then(([s, r]) => {
      setSummary(s);
      setRecent(r.logs);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="card text-center py-12 text-text-secondary">{t('common.loading')}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('analytics.title')}</h1>
        <p className="text-text-secondary text-sm mt-1">{t('analytics.subtitle')}</p>
      </div>

      {/* 6 统计卡 */}
      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label={t('analytics.requests')} value={summary.total} />
            <StatCard label={t('analytics.success')} value={`${((summary.successRate || 0) * 100).toFixed(1)}%`} />
            <StatCard label={t('analytics.inputTokens')} value={(summary.totalPromptTokens || 0).toLocaleString()} />
            <StatCard label={t('analytics.outputTokens')} value={(summary.totalCompletionTokens || 0).toLocaleString()} />
            <StatCard label={t('analytics.avgLatency')} value={`${Math.round(summary.avgLatency || 0)}ms`} />
            <StatCard label={t('analytics.estimatedSavings')} value={`$${(summary.estimatedSavings || 0).toFixed(2)}`} />
          </div>

          {/* 4 图表 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 1. 按提供商的请求数 */}
            <div className="card">
              <h2 className="text-sm font-semibold mb-4">{t('analytics.byProviderRequests')}</h2>
              {summary.platformBreakdown?.length > 0 ? (
                <BarChart
                  data={summary.platformBreakdown.map((p: any) => ({ label: p.platform, value: p.c }))}
                  color="var(--accent-primary)"
                />
              ) : <Empty />}
            </div>

            {/* 2. 按提供商的平均延迟 */}
            <div className="card">
              <h2 className="text-sm font-semibold mb-4">{t('analytics.byProviderLatency')}</h2>
              {summary.platformBreakdown?.length > 0 ? (
                <BarChart
                  data={summary.platformBreakdown.map((p: any) => ({ label: p.platform, value: Math.round(p.avg_latency || 0) }))}
                  color="var(--warning)"
                  suffix="ms"
                />
              ) : <Empty />}
            </div>

            {/* 3. 请求趋势 (7d) */}
            <div className="card">
              <h2 className="text-sm font-semibold mb-4">{t('analytics.trend')}</h2>
              {summary.trend?.length > 0 ? (
                <LineChart
                  points={summary.trend.map((d: any) => ({ x: d.day, y: d.c }))}
                  color="var(--accent-primary)"
                />
              ) : <Empty />}
            </div>

            {/* 4. 按模型细分 */}
            <div className="card">
              <h2 className="text-sm font-semibold mb-4">{t('analytics.byModel')}</h2>
              {summary.modelBreakdown?.length > 0 ? (
                <div className="space-y-2">
                  {summary.modelBreakdown.slice(0, 10).map((m: any) => {
                    const total = summary.modelBreakdown.reduce((s: number, x: any) => s + (x.c || 0), 0);
                    const pct = total > 0 ? (m.c / total) * 100 : 0;
                    return (
                      <div key={`${m.platform}-${m.model}`} className="text-sm">
                        <div className="flex justify-between mb-1">
                          <span className="font-mono text-xs truncate">{m.model}</span>
                          <span className="text-text-muted text-xs">{m.c} · {pct.toFixed(1)}%</span>
                        </div>
                        <div className="rounded-full h-1.5 overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                          <div className="h-full" style={{ width: `${pct}%`, backgroundColor: 'var(--accent-primary)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : <Empty />}
            </div>
          </div>
        </>
      )}

      {/* 最近请求 */}
      <div className="card overflow-hidden p-0">
        <div className="p-6 pb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('analytics.recent')}</h2>
          {recent.length > 10 && (
            <button
              className="btn-ghost text-xs"
              onClick={() => setShowAllRecent(v => !v)}
            >
              {showAllRecent
                ? t('analytics.collapse')
                : t('analytics.showAll', { n: recent.length })}
            </button>
          )}
        </div>
        <table className="w-full">
          <thead className="border-y border-border-subtle" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <tr>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.time')}</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.model')}</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.platform')}</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.status')}</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.latency')}</th>
              <th className="text-left py-2 px-4 text-xs font-medium text-text-secondary uppercase">{t('analytics.col.tokens')}</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr><td colSpan={6} className="py-6 text-center text-text-muted text-sm">{t('analytics.empty')}</td></tr>
            ) : (
              <>
                {(showAllRecent ? recent : recent.slice(0, 10)).map((l: any) => (
                  <tr key={l.id} className="border-b border-border-subtle hover:bg-bg-tertiary/50">
                    <td className="py-2 px-4 text-xs text-text-muted">
                      {new Date(l.created_at * 1000).toLocaleString()}
                    </td>
                    <td className="py-2 px-4 text-xs font-mono">{l.model}</td>
                    <td className="py-2 px-4"><span className="badge-muted">{l.platform}</span></td>
                    <td className="py-2 px-4">
                      {l.status_code < 400
                        ? <span className="badge-healthy">{l.status_code}</span>
                        : <span className="badge-danger">{l.status_code}</span>}
                    </td>
                    <td className="py-2 px-4 text-xs text-text-secondary">{l.latency_ms}ms</td>
                    <td className="py-2 px-4 text-xs text-text-secondary">{l.total_tokens || '-'}</td>
                  </tr>
                ))}
                {!showAllRecent && recent.length > 10 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-center">
                      <button
                        className="text-xs text-text-muted hover:text-text-primary transition-colors"
                        onClick={() => setShowAllRecent(true)}
                      >
                        {t('analytics.showMore', { n: recent.length - 10 })}
                      </button>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: any }) {
  return (
    <div className="card !p-4">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Empty() {
  return <div className="text-center py-8 text-text-muted text-sm">—</div>;
}

function BarChart({ data, color, suffix = '' }: { data: { label: string; value: number }[]; color: string; suffix?: string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="space-y-2">
      {data.map(d => (
        <div key={d.label} className="text-sm">
          <div className="flex justify-between mb-1">
            <span className="badge-muted text-xs">{d.label}</span>
            <span className="text-text-secondary text-xs">{d.value}{suffix}</span>
          </div>
          <div className="rounded-full h-2 overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <div className="h-full transition-all" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LineChart({ points, color }: { points: { x: string; y: number }[]; color: string }) {
  const max = Math.max(1, ...points.map(p => p.y));
  const w = 100, h = 100;
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points.map((p, i) => {
    const x = i * stepX;
    const y = h - (p.y / max) * h * 0.9 - 5;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const area = path + ` L${w},${h} L0,${h} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32" preserveAspectRatio="none">
        <path d={area} fill={color} fillOpacity="0.2" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={i} cx={i * stepX} cy={h - (p.y / max) * h * 0.9 - 5} r="1.5" fill={color} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="flex justify-between text-xs text-text-muted mt-1">
        <span>{points[0]?.x}</span>
        <span>{points[points.length - 1]?.x}</span>
      </div>
    </div>
  );
}
