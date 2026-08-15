import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { IconChevronRight } from '../components/Icons';

interface ModelInfo {
  id: number;
  name: string;
  displayName: string | null;
  platform: string;
  context: number | null;
  rpm: number | null;
  enabled: boolean;
  activeKeys: number;
  supportsTools: boolean;
  supportsVision: boolean;
  categories?: string[];
  freeTier: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  healthStatus?: string;
  source?: string;
  monthlyQuota?: number;
  monthlyUsed?: number;
}

type Strategy = 'balanced' | 'smartest' | 'fastest' | 'stable';

export function ModelsPage() {
  const t = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [strategy, setStrategy] = useState<Strategy>('fastest');
  const [search, setSearch] = useState('');
  const [myPlatforms, setMyPlatforms] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<number | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const r: any = await api.listModels();
      setModels((r.models || []) as ModelInfo[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.listKeys().then((j: any) => {
      setMyPlatforms(new Set((j.keys || []).map((k: any) => k.platform)));
    }).catch(() => {});
  }, []);

  useEffect(() => { reload(); }, []);

  const toggle = async (m: ModelInfo) => {
    setSavingId(m.id);
    // 乐观更新
    setModels(prev => prev.map(x => x.id === m.id ? { ...x, enabled: !x.enabled } : x));
    try {
      await api.updateModel(m.id, { enabled: m.enabled ? 0 : 1 });
    } catch (e) {
      // 失败回滚
      setModels(prev => prev.map(x => x.id === m.id ? { ...x, enabled: m.enabled } : x));
    } finally {
      setSavingId(null);
    }
  };

  const filtered = models.filter(m => {
    if (search) {
      const q = search.toLowerCase();
      const cats = (m.categories || []).join(' ').toLowerCase();
      if (!m.name.toLowerCase().includes(q) && !m.platform.toLowerCase().includes(q) && !cats.includes(q)) return false;
    }
    return true;
  });

  const stratWeights: Record<Strategy, { r: number; s: number; i: number }> = {
    balanced: { r: 33, s: 34, i: 33 },
    smartest: { r: 20, s: 20, i: 60 },
    fastest: { r: 35, s: 55, i: 10 },
    stable: { r: 60, s: 20, i: 20 },
  };

  const strat = stratWeights[strategy];
  const STRATEGY_IDS: Strategy[] = ['balanced', 'smartest', 'fastest', 'stable'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold gradient-text">{t('models.title')}</h1>
        <p className="text-text-secondary text-sm mt-1">{t('models.subtitle')}</p>
      </div>

      {/* 路由策略 */}
      <div className="card-gradient-border">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-base font-semibold">{t('models.strategy')}</h2>
          <span className="text-xs text-text-muted">
            {t('strategy.reliability')} {strat.r}% · {t('strategy.speed')} {strat.s}% · {t('strategy.intelligence')} {strat.i}%
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {STRATEGY_IDS.map(s => (
            <button
              key={s}
              onClick={() => setStrategy(s)}
              className={`px-4 py-1.5 text-sm rounded-full transition-colors ${
                strategy === s ? 'chip-selected font-medium' : 'chip-default hover:opacity-80'
              }`}
            >
              {t(`strategy.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {/* 每月令牌额度 */}
      <MonthlyQuotaPanel models={models} myPlatforms={myPlatforms} />

      {/* 搜索 + 计数 + 刷新 */}
      <div className="galaxy-fade-in">
        <div className="flex gap-2 items-center">
          <input
            className="input flex-1"
            placeholder={t('models.search.placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="btn-ghost text-sm" onClick={() => setSearch('')}>
              {t('models.search.reset')}
            </button>
          )}
          <button className="btn-ghost text-sm" onClick={reload} disabled={loading}>
            {loading ? t('common.loading') : t('settings.refresh')}
          </button>
          <span className="text-xs text-text-muted whitespace-nowrap">
            {filtered.length} / {models.length}
          </span>
        </div>
      </div>

      {/* 模型表格 */}
      {loading ? (
        <div className="card text-center py-12 text-text-secondary flex items-center justify-center gap-3">
          <span className="galaxy-spinner" />
          <span>{t('common.loading')}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12 text-text-secondary">
          {models.length === 0
            ? (t('models.empty') + ' — ' + t('common.cancel'))
            : t('models.empty')}
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs text-text-muted uppercase">
                <th className="text-left py-2 px-4 font-medium">{t('models.col.model')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.platform')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.categories')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.context')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.rpm')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.reliability')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.speed')}</th>
                <th className="text-left py-2 px-4 font-medium">{t('models.col.intelligence')}</th>
                <th className="text-right py-2 px-4 font-medium">{t('models.col.enable')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => {
                const haveKey = myPlatforms.has(m.platform);
                const isRateLimited = m.healthStatus === 'rate_limited';
                return (
                  <tr
                    key={m.id}
                    className="border-b border-border-subtle hover:bg-bg-tertiary"
                    style={{ opacity: m.enabled ? 1 : 0.55, backgroundColor: isRateLimited ? 'color-mix(in srgb, var(--danger) 5%, transparent)' : undefined }}
                  >
                    <td className="py-2 px-4 font-medium">
                      {m.displayName || m.name}
                      {isRateLimited && <span className="ml-2 badge-danger">额度耗尽</span>}
                      {!haveKey && !isRateLimited && <span className="ml-2 text-xs text-text-muted">({t('models.empty')})</span>}
                    </td>
                    <td className="py-2 px-4"><span className="badge-muted">{m.platform}</span></td>
                    <td className="py-2 px-4">
                      <div className="flex gap-1 flex-wrap">
                        {(m.categories || []).map(c => (
                          <span key={c} className="badge-cat">{c}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 px-4 text-text-secondary text-xs">
                      {m.context ? m.context.toLocaleString() : '-'}
                    </td>
                    <td className="py-2 px-4 text-text-secondary text-xs">{m.freeTier.rpm || '-'}</td>
                    <td className="py-2 px-4"><MeterBar pct={modelScore(m).reliability} color="green" /></td>
                    <td className="py-2 px-4"><MeterBar pct={modelScore(m).speed} color="blue" /></td>
                    <td className="py-2 px-4"><MeterBar pct={modelScore(m).intelligence} color="purple" /></td>
                    <td className="py-2 px-4 text-right">
                      <Toggle
                        checked={m.enabled}
                        onChange={() => toggle(m)}
                        disabled={!haveKey || savingId === m.id}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function modelScore(m: ModelInfo): { reliability: number; speed: number; intelligence: number } {
  const name = (m.displayName || m.name).toLowerCase();
  const platform = m.platform;

  // ===== 智能度:按模型品牌/系列评分 =====
  let intelligence = 50;
  if (/^gpt-[45]/.test(name) || /^o[13]\b/.test(name) || /o1-?preview|o1-?mini/.test(name)) intelligence = 95;
  else if (/claude.*opus|claude-?[34].*opus/.test(name)) intelligence = 93;
  else if (/claude.*sonnet|claude-?[34]/.test(name)) intelligence = 85;
  else if (/gemini.*pro|gemini-2/.test(name)) intelligence = 82;
  else if (/deepseek-r[12]/.test(name) || /deepseek-v[34]/.test(name)) intelligence = 80;
  else if (/gemini.*flash|gemini-1\.5/.test(name)) intelligence = 70;
  else if (/qwen.*max|qwen.*72b/.test(name)) intelligence = 75;
  else if (/qwen/.test(name)) intelligence = 60;
  else if (/llama.*70b|llama.*405b|llama-?[34]/.test(name)) intelligence = 68;
  else if (/llama/.test(name)) intelligence = 50;
  else if (/kimi|moonshot/.test(name)) intelligence = 65;
  else if (/glm-[45]/.test(name)) intelligence = 62;
  else if (/mistral.*large|mixtral/.test(name)) intelligence = 65;
  else if (/mistral/.test(name)) intelligence = 55;
  else if (/gemma/.test(name)) intelligence = 45;

  // 上下文窗口加成(对数曲线)
  if (m.context) intelligence += Math.min(10, Math.log2(m.context / 4096) * 1.5);

  // ===== 速度:按平台评分(推理加速平台更快) =====
  const platformSpeed: Record<string, number> = {
    groq: 95, cerebras: 92, cloudflare: 80,
    google: 75, nvidia: 85, openrouter: 60, mistral: 70,
    cohere: 65, zai: 55, huggingface: 50, ollama: 40,
    kilo: 65, pollinations: 55, llm7: 60, ovh: 50,
    aihorde: 35, opencode: 70, bailian: 65, custom: 50,
    modelscope: 65, agnes: 60,
  };
  let speed = platformSpeed[platform] ?? 55;
  // Flash/Lite 模型更快
  if (/flash|lite|mini|small|8b|7b/.test(name)) speed = Math.min(99, speed + 15);
  if (/70b|405b|large|pro|opus/.test(name)) speed = Math.max(30, speed - 15);

  // ===== 可靠性:按健康状态 + 平台稳定性评分 =====
  const platformReliability: Record<string, number> = {
    google: 88, openrouter: 85, groq: 80, cloudflare: 82,
    mistral: 75, cohere: 76, nvidia: 72,
    cerebras: 70, zai: 68, huggingface: 55, ollama: 60,
    kilo: 65, pollinations: 50, llm7: 55, ovh: 52,
    aihorde: 40, opencode: 65, bailian: 70, custom: 60,
    modelscope: 68, agnes: 60,
  };
  let reliability = platformReliability[platform] ?? 60;
  if (m.healthStatus === 'rate_limited') reliability = Math.min(reliability, 25);
  else if (m.healthStatus === 'error') reliability = Math.min(reliability, 20);
  else if (m.healthStatus === 'healthy') reliability = Math.min(98, reliability + 10);
  if (m.activeKeys === 0) reliability = Math.min(reliability, 15);

  return {
    reliability: Math.round(Math.max(10, Math.min(99, reliability))),
    speed: Math.round(Math.max(10, Math.min(99, speed))),
    intelligence: Math.round(Math.max(10, Math.min(99, intelligence))),
  };
}

function MeterBar({ pct, color }: { pct: number; color: 'green' | 'blue' | 'purple' }) {
  const c = color === 'green' ? 'var(--success)' : color === 'blue' ? 'var(--info)' : 'var(--accent-primary)';
  return (
    <div className="rounded-full h-1.5 w-24 overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      <div className="h-full" style={{ width: `${pct}%`, backgroundColor: c, boxShadow: `0 0 6px ${c}` }} />
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`galaxy-toggle${checked ? ' on' : ''}`}
      style={disabled ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
    >
      <span className="knob" />
    </button>
  );
}

// ===== 每月令牌额度面板 =====
const PLATFORM_COLORS: Record<string, string> = {
  google: '#4285f4',
  groq: '#f55036',
  cloudflare: '#f38020',
  cerebras: '#e84a3f',
  zai: '#3b5998',
  nvidia: '#76b900',
  mistral: '#ff7000',
  cohere: '#39594d',
  openrouter: '#6366f1',
  huggingface: '#ff9d00',
  bailian: '#ff6a00',
  ollama: '#000000',
  kilo: '#00b894',
  pollinations: '#e84393',
  llm7: '#0984e3',
  ovh: '#1230ff',
  aihorde: '#a29bfe',
  opencode: '#00b894',
  modelscope: '#ff6a00',
  agnes: '#e84393',
  custom: '#6366f1',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function MonthlyQuotaPanel({ models, myPlatforms }: { models: ModelInfo[]; myPlatforms: Set<string> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 只统计有 key 且 enabled 的模型
  const activeModels = models.filter(m => m.enabled && myPlatforms.has(m.platform));
  // 按平台聚合 — 同一平台的 used 只算一次(后端按平台聚合返回)
  const platformUsedMap = new Map<string, number>();
  // 按平台聚合
  const platformMap = new Map<string, { total: number; used: number; models: { name: string; quota: number; health: string }[] }>();
  let grandTotal = 0;
  let grandUsed = 0;
  for (const m of activeModels) {
    const q = m.monthlyQuota || 0;
    // 同一平台的 used 只取一次(后端按平台级别返回用量)
    if (!platformUsedMap.has(m.platform)) {
      const u = m.monthlyUsed || 0;
      platformUsedMap.set(m.platform, u);
      grandUsed += u;
    }
    grandTotal += q;
    if (!platformMap.has(m.platform)) {
      platformMap.set(m.platform, { total: 0, used: platformUsedMap.get(m.platform) || 0, models: [] });
    }
    const p = platformMap.get(m.platform)!;
    p.total += q;
    p.models.push({ name: m.displayName || m.name, quota: q, health: m.healthStatus || 'healthy' });
  }
  // 按总额度降序
  const sorted = [...platformMap.entries()].sort((a, b) => b[1].total - a[1].total);
  const platformsWithQuota = sorted.filter(([, v]) => v.total > 0);

  if (platformsWithQuota.length === 0) return null;

  const remaining = Math.max(0, grandTotal - grandUsed);
  const remainingPct = grandTotal > 0 ? Math.round((remaining / grandTotal) * 100) : 0;
  const usedPct = 100 - remainingPct;

  const toggle = (p: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="card">
      {/* 总览 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{t_or('models.monthlyQuota', '每月令牌额度')}</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)' }}>
            {platformsWithQuota.length} {t_or('models.platforms', '个平台')}
          </span>
        </div>
        <div className="text-right">
          <span className="text-lg font-mono font-semibold" style={{ color: 'var(--accent-primary)' }}>{fmtTokens(remaining)}</span>
          <span className="text-xs text-text-muted ml-1">{t_or('models.remaining', '剩余')}</span>
          <span className="text-xs text-text-muted ml-2">· {remainingPct}% · {t_or('models.used', '已用')} {fmtTokens(grandUsed)} / {fmtTokens(grandTotal)}</span>
        </div>
      </div>

      {/* 总进度条 */}
      <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden mb-4">
        <div className="h-full rounded-full transition-all" style={{ width: `${remainingPct}%`, background: 'linear-gradient(90deg, var(--accent-primary), var(--info))' }} />
      </div>

      {/* 按平台折叠列表 */}
      <div className="space-y-1">
        {platformsWithQuota.map(([platform, data]) => {
          const color = PLATFORM_COLORS[platform] || '#8b5cf6';
          const quotaModels = data.models.filter(m => m.quota > 0).sort((a, b) => b.quota - a.quota);
          const isOpen = expanded.has(platform);
          const limitedModels = data.models.filter(m => m.health === 'rate_limited').length;
          const platRemaining = Math.max(0, data.total - data.used);
          const platUsedPct = data.total > 0 ? Math.round((data.used / data.total) * 100) : 0;
          return (
            <div key={platform} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
              {/* 平台头(可点击) */}
              <button
                onClick={() => toggle(platform)}
                className="w-full flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-bg-tertiary"
                style={{ backgroundColor: isOpen ? 'var(--bg-tertiary)' : 'transparent' }}
              >
                <span style={{ color: 'var(--text-muted)', transition: 'transform .2s', display: 'inline-flex', transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                  <IconChevronRight size={12} />
                </span>
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-sm font-medium">{platformLabel(platform)}</span>
                <span className="text-xs text-text-muted">{quotaModels.length} {t_or('models.models', '模型')}</span>
                {limitedModels > 0 && (
                  <span className="badge-danger">{limitedModels} {t_or('models.exhausted', '耗尽')}</span>
                )}
                {/* 平台用量占比条 */}
                <div className="flex-1 mx-2 h-1.5 rounded-full bg-bg-tertiary overflow-hidden" style={{ maxWidth: 120 }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${platUsedPct}%`, backgroundColor: platUsedPct > 80 ? 'var(--danger)' : color }} />
                </div>
                <span className="text-xs font-mono shrink-0" style={{ color: 'var(--text-secondary)' }}>{fmtTokens(platRemaining)}</span>
                <span className="text-xs text-text-muted shrink-0">/ {fmtTokens(data.total)}</span>
              </button>
              {/* 展开后:模型明细 */}
              {isOpen && (
                <div className="px-3 pb-3 pt-1" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-0.5">
                    {quotaModels.map((m, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs py-0.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: m.health === 'rate_limited' ? 'var(--danger)' : color, opacity: m.health === 'rate_limited' ? 0.4 : 0.6 }} />
                        <span className="truncate text-text-secondary" style={{ maxWidth: 120 }}>{m.name}</span>
                        {m.health === 'rate_limited' && <span className="text-xs" style={{ color: 'var(--danger)' }}>●</span>}
                        <span className="text-text-muted ml-auto font-mono shrink-0">{fmtTokens(m.quota)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function platformLabel(p: string): string {
  const labels: Record<string, string> = {
    google: 'Google', groq: 'Groq', cloudflare: 'Cloudflare',
    cerebras: 'Cerebras', zai: '智谱', nvidia: 'NVIDIA', mistral: 'Mistral',
    cohere: 'Cohere', openrouter: 'OpenRouter', huggingface: 'HuggingFace',
    bailian: '阿里云百炼', ollama: 'Ollama', kilo: 'Kilo', pollinations: 'Pollinations',
    llm7: 'LLM7', ovh: 'OVH', aihorde: 'AI Horde', opencode: 'OpenCode', custom: 'Custom',
    modelscope: 'ModelScope', agnes: 'AGNES',
  };
  return labels[p] || p;
}

function t_or(key: string, fallback: string): string {
  return fallback;
}
