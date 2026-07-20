import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT, getLang } from '../lib/i18n';

type TFn = (key: string, params?: Record<string, string | number>) => string;

interface ChangelogEntry {
  version: string;
  date: string;
  changes: { zh: string[]; en: string[] };
}

interface AboutInfo {
  name: string;
  version: string;
  description: string;
  region: string;
  runtime: string;
  startedAt: number;
  uptimeMs: number;
  stats: {
    totalRequests: number;
    apiKeys: number;
    models: number;
    activeTokens: number;
    accounts: number;
    lastRequestAt: number | null;
  };
  platforms: { platform: string; total: number; enabled: number }[];
  endpoints: Record<string, string>;
  docs: { openai_compatible: boolean; auth: string };
  changelog?: ChangelogEntry[];
}

function formatUptime(ms: number, t: TFn): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const day = t('about.uptime.day');
  const hour = t('about.uptime.hour');
  const min = t('about.uptime.min');
  const secU = t('about.uptime.sec');
  if (d > 0) return `${d} ${day} ${h} ${hour} ${m} ${min} ${s} ${secU}`;
  if (h > 0) return `${h} ${hour} ${m} ${min} ${s} ${secU}`;
  if (m > 0) return `${m} ${min} ${s} ${secU}`;
  return `${s} ${secU}`;
}

function formatDate(ms: number): string {
  const locale = getLang() === 'zh' ? 'zh-CN' : 'en-US';
  return new Date(ms).toLocaleString(locale, { hour12: false });
}

export function AboutPage() {
  const t = useT();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [err, setErr] = useState('');
  const [, setTick] = useState(0);

  // 每秒重新拉取以让 uptime 持续增长
  useEffect(() => {
    let mounted = true;
    const fetchInfo = async () => {
      try {
        const data: AboutInfo = await api.getAbout();
        if (mounted) setInfo(data);
      } catch (e: any) {
        if (mounted) setErr(e.message || t('about.loadFail'));
      }
    };
    fetchInfo();
    const id = setInterval(() => setTick(n => n + 1), 1000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // 客户端单独再算 uptime(让秒数实时变)
  const liveUptime = info ? info.uptimeMs + (Date.now() - (info.startedAt + info.uptimeMs)) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('about.title')}</h1>
        <p className="text-text-secondary text-sm mt-1">{t('about.subtitle')}</p>
      </div>

      {err && (
        <div className="rounded p-3 text-sm" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
          {err}
        </div>
      )}

      {!info ? (
        <div className="card text-center py-12 text-text-secondary">{t('common.loading')}</div>
      ) : (
        <>
          {/* 运行时间卡片 (高亮) */}
          <div
            className="rounded-lg p-6"
            style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.15) 0%, rgba(59,130,246,0.10) 100%)',
              border: '1px solid rgba(139,92,246,0.3)',
            }}
          >
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div>
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <span className="w-2 h-2 rounded-full bg-success animate-pulse"></span>
                  <span>{t('about.running')}</span>
                </div>
                <div className="text-3xl font-semibold mt-2 font-mono">
                  {formatUptime(liveUptime, t)}
                </div>
                <div className="text-xs text-text-muted mt-2">
                  {t('about.firstDeploy')}: {formatDate(info.startedAt)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-text-muted">{t('about.dataCenter')}</div>
                <div className="text-lg font-mono mt-1">{info.region}</div>
                <div className="text-xs text-text-muted mt-2">{t('about.runtime')}</div>
                <div className="text-sm font-mono mt-1">{info.runtime}</div>
              </div>
            </div>
          </div>

          {/* 累计统计 */}
          <div className="card">
            <h2 className="text-base font-semibold mb-4">{t('about.stats')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Stat label={t('about.stat.totalRequests')} value={info.stats.totalRequests.toLocaleString()} />
              <Stat label={t('about.stat.apiKeys')} value={String(info.stats.apiKeys)} />
              <Stat label={t('about.stat.models')} value={String(info.stats.models)} />
              <Stat label={t('about.stat.activeTokens')} value={String(info.stats.activeTokens)} />
              <Stat label={t('about.stat.accounts')} value={String(info.stats.accounts)} />
              <Stat label={t('about.stat.lastRequest')} value={info.stats.lastRequestAt ? formatDate(info.stats.lastRequestAt * 1000) : '—'} />
            </div>
          </div>

          {/* Provider 平台分布 */}
          {info.platforms.length > 0 && (
            <div className="card">
              <h2 className="text-base font-semibold mb-4">{t('about.providers')}</h2>
              <div className="space-y-2">
                {info.platforms.map(p => (
                  <div key={p.platform} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{p.platform}</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>({t('about.providers.count', { enabled: p.enabled, total: p.total })})</span>
                    </div>
                    <div className="flex-1 mx-3 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                      <div
                        className="h-full bg-accent-primary"
                        style={{ width: `${p.total ? (p.enabled / p.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* API 端点 */}
          <div className="card">
            <h2 className="text-base font-semibold mb-4">{t('about.endpoints')}</h2>
            <div className="space-y-2 text-sm">
              {Object.entries(info.endpoints).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 font-mono text-xs">
                  <span className="w-24" style={{ color: 'var(--text-secondary)' }}>{k}</span>
                  <code className="px-2 py-1 rounded bg-bg-tertiary break-all" style={{ color: 'var(--text-primary)' }}>{v}</code>
                </div>
              ))}
            </div>
            <div className="mt-4 text-xs text-text-muted">
              {t('about.auth')}: {info.docs.auth} · {t('about.openaiCompat')}
            </div>
          </div>

          {/* 版本日志 (从后端 /api/about 动态获取) */}
          {info.changelog && info.changelog.length > 0 && (
          <div className="card">
            <h2 className="text-base font-semibold mb-4">{t('about.changelog')}</h2>
            <div className="space-y-4">
              {info.changelog.map((entry, i) => (
                <div key={entry.version} className={i === 0 ? '' : 'pt-4 border-t border-border-subtle'}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono font-semibold text-sm" style={{ color: 'var(--accent-primary)' }}>v{entry.version}</span>
                    <span className="text-xs text-text-muted">{entry.date}</span>
                    {i === 0 && <span className="badge-healthy text-xs">{t('about.changelog.latest')}</span>}
                  </div>
                  <ul className="space-y-1">
                    {entry.changes[getLang()].map((c, j) => (
                      <li key={j} className="text-xs flex items-start gap-2" style={{ color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--accent-primary)' }}>•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
          )}

          <div className="text-center text-xs text-text-muted pt-2">
            {info.name} v{info.version} · {info.description}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-lg font-semibold mt-1 font-mono" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
