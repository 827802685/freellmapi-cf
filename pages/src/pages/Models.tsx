import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';

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
  freeTier: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
}

type Strategy = 'manual' | 'balanced' | 'smartest' | 'fastest' | 'stable' | 'custom';

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
      if (!m.name.toLowerCase().includes(q) && !m.platform.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const stratWeights: Record<Strategy, { r: number; s: number; i: number }> = {
    manual: { r: 0, s: 0, i: 0 },
    balanced: { r: 33, s: 34, i: 33 },
    smartest: { r: 20, s: 20, i: 60 },
    fastest: { r: 35, s: 55, i: 10 },
    stable: { r: 60, s: 20, i: 20 },
    custom: { r: 33, s: 34, i: 33 },
  };

  const strat = stratWeights[strategy];
  const STRATEGY_IDS: Strategy[] = ['manual', 'balanced', 'smartest', 'fastest', 'stable', 'custom'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('models.title')}</h1>
        <p className="text-text-secondary text-sm mt-1">{t('models.subtitle')}</p>
      </div>

      {/* 路由策略 */}
      <div className="card">
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

      {/* 搜索 + 计数 */}
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
        <span className="text-xs text-text-muted whitespace-nowrap">
          {filtered.length} / {models.length}
        </span>
      </div>

      {/* 模型表格 */}
      {loading ? (
        <div className="card text-center py-12 text-text-secondary">{t('common.loading')}</div>
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
                return (
                  <tr
                    key={m.id}
                    className="border-b border-border-subtle hover:bg-bg-tertiary/50"
                    style={{ opacity: m.enabled ? 1 : 0.6 }}
                  >
                    <td className="py-2 px-4 font-medium">
                      {m.displayName || m.name}
                      {!haveKey && <span className="ml-2 text-xs text-text-muted">({t('models.empty')})</span>}
                    </td>
                    <td className="py-2 px-4"><span className="badge-muted">{m.platform}</span></td>
                    <td className="py-2 px-4 text-text-secondary text-xs">
                      {m.context ? m.context.toLocaleString() : '-'}
                    </td>
                    <td className="py-2 px-4 text-text-secondary text-xs">{m.freeTier.rpm || '-'}</td>
                    <td className="py-2 px-4"><MeterBar pct={60 + Math.random() * 30} color="green" /></td>
                    <td className="py-2 px-4"><MeterBar pct={50 + Math.random() * 40} color="blue" /></td>
                    <td className="py-2 px-4"><MeterBar pct={40 + Math.random() * 50} color="purple" /></td>
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

function MeterBar({ pct, color }: { pct: number; color: 'green' | 'blue' | 'purple' }) {
  const c = color === 'green' ? 'var(--success)' : color === 'blue' ? 'var(--info)' : 'var(--accent-primary)';
  return (
    <div className="rounded-full h-1.5 w-24 overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      <div className="h-full" style={{ width: `${pct}%`, backgroundColor: c }} />
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className="w-9 h-5 rounded-full transition-colors relative"
      style={{
        backgroundColor: checked ? 'var(--selected-bg)' : 'var(--bg-tertiary)',
        opacity: disabled ? 0.3 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        className="block w-3.5 h-3.5 rounded-full shadow absolute top-[3px] transition-transform"
        style={{
          backgroundColor: '#ffffff',
          transform: checked ? 'translateX(18px)' : 'translateX(3px)',
        }}
      />
    </button>
  );
}
