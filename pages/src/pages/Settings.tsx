import { useCallback, useEffect, useState } from 'react';
import {
  api,
  PlatformGroup,
  SettingsModel,
  ModelUpdateBody,
} from '../lib/api';
import { useT } from '../lib/i18n';

/**
 * 设置页 — 管理所有平台的模型配置
 *
 * 功能:
 *  1. 列出所有平台（platform），每个平台可展开/折叠
 *  2. 展开后显示该平台所有模型，每个模型可 inline 编辑全部字段
 *  3. 平台顶部批量设置额度（RPM/RPD/TPM/TPD 一键应用到该平台所有模型）
 *  4. 每个平台可添加新模型、删除模型
 *  5. 显示每个平台的 key 信息（有/无 key、总数、启用数）
 */
export function SettingsPage() {
  const t = useT();
  const [platforms, setPlatforms] = useState<PlatformGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddProvider, setShowAddProvider] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.getProviders();
      setPlatforms(r.platforms || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
          <p className="text-text-secondary text-sm mt-1">
            {t('settings.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary text-sm" onClick={() => setShowAddProvider((v) => !v)}>
            {showAddProvider ? t('common.cancel') : t('settings.addProvider')}
          </button>
          <button className="btn-ghost text-sm" onClick={reload} disabled={loading}>
            {loading ? t('settings.refreshing') : t('settings.refresh')}
          </button>
        </div>
      </div>

      {/* 添加新提供商表单 */}
      {showAddProvider && (
        <AddProviderForm onAdded={() => { setShowAddProvider(false); reload(); }} />
      )}

      {/* 错误提示 */}
      {error && (
        <div
          className="card"
          style={{ borderColor: 'rgba(239,68,68,0.3)' }}
        >
          <pre className="text-sm text-danger whitespace-pre-wrap break-words">{error}</pre>
          <button className="btn-secondary text-sm mt-2" onClick={reload}>
            {t('settings.retry')}
          </button>
        </div>
      )}

      {/* 平台列表 */}
      {loading ? (
        <div className="card text-center py-12 text-text-secondary">{t('common.loading')}</div>
      ) : platforms.length === 0 ? (
        <div className="card text-center py-12 text-text-secondary">{t('settings.empty.platforms')}</div>
      ) : (
        platforms.map((p) => (
          <PlatformCard key={p.platform} group={p} onReload={reload} />
        ))
      )}
    </div>
  );
}

// ============= 添加提供商表单 =============
function AddProviderForm({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const [platform, setPlatform] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!platform.trim() || !label.trim()) {
      setErr(t('settings.addProvider.req'));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.addProvider({
        platform: platform.trim().toLowerCase(),
        label: label.trim(),
        base_url: baseUrl.trim() || undefined,
      });
      setPlatform('');
      setLabel('');
      setBaseUrl('');
      onAdded();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card space-y-3" style={{ borderColor: 'var(--accent-primary)' }}>
      <h2 className="text-base font-semibold">{t('settings.addProvider.title')}</h2>
      <p className="text-xs text-text-muted">
        {t('settings.addProvider.desc')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-text-muted">{t('settings.addProvider.platformId')}</label>
          <input
            className="input mt-1"
            placeholder={t('settings.addProvider.platformId.placeholder')}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-text-muted">{t('settings.addProvider.displayName')}</label>
          <input
            className="input mt-1"
            placeholder={t('settings.addProvider.displayName.placeholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-text-muted">{t('settings.addProvider.baseUrl')}</label>
          <input
            className="input mt-1"
            placeholder={t('settings.addProvider.baseUrl.placeholder')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
      <button className="btn-primary text-sm" onClick={submit} disabled={saving}>
        {saving ? t('settings.addProvider.submitting') : t('settings.addProvider.submit')}
      </button>
    </div>
  );
}

// ============= 平台卡片（可折叠） =============
function PlatformCard({
  group,
  onReload,
}: {
  group: PlatformGroup;
  onReload: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { platform, label, keyInfo, models } = group;
  const hasKey = keyInfo.total > 0;
  const enabledModels = models.filter((m) => m.enabled).length;

  const deleteProvider = async () => {
    if (!confirm(t('settings.provider.delete.confirm', { label }))) return;
    setDeleting(true);
    try {
      await api.deleteProvider(platform);
      onReload();
    } catch (e: any) {
      alert(t('settings.provider.delete.fail', { msg: e?.message || String(e) }));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="card">
      {/* 卡片头部 — 点击展开/折叠 */}
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted w-4 inline-block">
            {expanded ? '▼' : '▶'}
          </span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{label}</h2>
              <span className="badge-muted">{platform}</span>
              {group.enabled === 0 && <span className="badge-warning">{t('settings.provider.disabled')}</span>}
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              {t('settings.provider.models', { total: models.length, enabled: enabledModels })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {hasKey ? (
            <span className="badge-healthy">
              {t('settings.provider.keyInfo', { total: keyInfo.total, enabled: keyInfo.enabled })}
            </span>
          ) : (
            <span className="badge-danger">{t('settings.provider.noKey')}</span>
          )}
          <button
            className="btn-ghost text-xs px-2 py-1"
            onClick={onReload}
            title={t('settings.refresh')}
          >
            🔄
          </button>
          <button
            className="btn-ghost text-xs px-2 py-1 text-danger"
            onClick={deleteProvider}
            disabled={deleting}
            title={t('settings.provider.delete.title')}
          >
            {deleting ? '...' : '🗑'}
          </button>
        </div>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="mt-4 space-y-4 border-t border-border-subtle pt-4">
          {/* 批量设置额度 */}
          <BatchLimitsBar platform={platform} onApplied={onReload} />

          {/* 添加新模型 */}
          <AddModelForm platform={platform} onAdded={onReload} />

          {/* 模型表格 */}
          <ModelsTable models={models} onReload={onReload} />
        </div>
      )}
    </div>
  );
}

// ============= 批量额度设置 =============
function BatchLimitsBar({
  platform,
  onApplied,
}: {
  platform: string;
  onApplied: () => void;
}) {
  const t = useT();
  const [rpm, setRpm] = useState('');
  const [rpd, setRpd] = useState('');
  const [tpm, setTpm] = useState('');
  const [tpd, setTpd] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);

  const apply = async () => {
    const body: {
      rpm?: number;
      rpd?: number;
      tpm?: number;
      tpd?: number;
    } = {};
    if (rpm.trim() !== '') body.rpm = Number(rpm);
    if (rpd.trim() !== '') body.rpd = Number(rpd);
    if (tpm.trim() !== '') body.tpm = Number(tpm);
    if (tpd.trim() !== '') body.tpd = Number(tpd);

    if (Object.keys(body).length === 0) {
      setMsgOk(false);
      setMsg(t('settings.batch.req'));
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.updatePlatformLimits(platform, body);
      setMsgOk(true);
      setMsg(t('settings.batch.updated', { n: r.updated }));
      setRpm('');
      setRpd('');
      setTpm('');
      setTpd('');
      onApplied();
    } catch (e: any) {
      setMsgOk(false);
      setMsg(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-md p-3"
      style={{ backgroundColor: 'var(--bg-tertiary)' }}
    >
      <div className="text-xs text-text-muted mb-2">
        {t('settings.batch.title')}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <LimitInput label="RPM" value={rpm} onChange={setRpm} />
        <LimitInput label="RPD" value={rpd} onChange={setRpd} />
        <LimitInput label="TPM" value={tpm} onChange={setTpm} />
        <LimitInput label="TPD" value={tpd} onChange={setTpd} />
        <button
          className="btn-primary text-sm"
          onClick={apply}
          disabled={busy}
        >
          {busy ? t('settings.batch.applying') : t('settings.batch.apply')}
        </button>
        {msg && (
          <span
            className={`text-xs ${msgOk ? 'text-success' : 'text-danger'}`}
          >
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

function LimitInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input
        className="input text-sm w-24"
        type="number"
        min={0}
        placeholder="-"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ============= 添加新模型 =============
function AddModelForm({
  platform,
  onAdded,
}: {
  platform: string;
  onAdded: () => void;
}) {
  const t = useT();
  const [modelName, setModelName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modelName.trim()) {
      setErr(t('settings.model.name.req'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.addModel({
        platform,
        model_name: modelName.trim(),
        display_name: displayName.trim() || undefined,
      });
      setModelName('');
      setDisplayName('');
      onAdded();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs text-text-muted mb-1">
          {t('settings.model.name')}
        </label>
        <input
          className="input text-sm font-mono"
          placeholder={t('settings.model.name.placeholder')}
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
        />
      </div>
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs text-text-muted mb-1">
          {t('settings.model.displayName')}
        </label>
        <input
          className="input text-sm"
          placeholder={t('settings.model.displayName.placeholder')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn-secondary text-sm"
        disabled={busy || !modelName.trim()}
      >
        {busy ? t('settings.addProvider.submitting') : t('settings.model.add')}
      </button>
      {err && <span className="text-xs text-danger">{err}</span>}
    </form>
  );
}

// ============= 模型表格 =============
function ModelsTable({
  models,
  onReload,
}: {
  models: SettingsModel[];
  onReload: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (prev.size === models.length) return new Set();
      return new Set(models.map((m) => m.id));
    });
  };

  const batchDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(t('settings.model.delete.confirm.batch', { n: selected.size }))) return;
    setDeleting(true);
    try {
      const r = await api.batchDeleteModels([...selected]);
      setSelected(new Set());
      onReload();
      alert(t('settings.model.deleted', { n: r.deleted }));
    } catch (e: any) {
      alert(t('settings.model.delete.fail', { msg: e?.message || String(e) }));
    } finally {
      setDeleting(false);
    }
  };

  if (models.length === 0) {
    return (
      <div className="text-center py-6 text-text-muted text-sm">
        {t('settings.model.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div
          className="flex items-center gap-3 rounded-md p-2"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <span className="text-sm text-danger">{t('settings.model.selected', { n: selected.size })}</span>
          <button
            className="btn-ghost text-xs"
            onClick={() => setSelected(new Set())}
            disabled={deleting}
          >
            {t('settings.model.deselect')}
          </button>
          <button
            className="btn-ghost text-xs text-danger"
            onClick={batchDelete}
            disabled={deleting}
            style={{ border: '1px solid rgba(239,68,68,0.3)' }}
          >
            {deleting ? t('settings.model.deleting') : t('settings.model.batchDelete')}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs text-text-muted uppercase">
              <th className="text-center py-2 px-2 w-8">
                <input
                  type="checkbox"
                  checked={selected.size === models.length && models.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">{t('settings.col.modelName')}</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">{t('settings.col.displayName')}</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">{t('settings.col.context')}</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">RPM</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">RPD</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">TPM</th>
              <th className="text-left py-2 px-2 font-medium whitespace-nowrap">TPD</th>
              <th className="text-center py-2 px-2 font-medium">{t('settings.col.tools')}</th>
              <th className="text-center py-2 px-2 font-medium">{t('settings.col.vision')}</th>
              <th className="text-center py-2 px-2 font-medium">{t('settings.col.streaming')}</th>
              <th className="text-center py-2 px-2 font-medium">{t('settings.col.enabled')}</th>
              <th className="text-right py-2 px-2 font-medium whitespace-nowrap">{t('settings.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                onReload={onReload}
                selected={selected.has(m.id)}
                onToggleSelect={() => toggleSelect(m.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============= 单个模型行（inline 可编辑） =============
interface EditDraft {
  display_name: string;
  context_window: string;
  free_tier_rpm: string;
  free_tier_rpd: string;
  free_tier_tpm: string;
  free_tier_tpd: string;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_streaming: boolean;
  enabled: boolean;
}

function toDraft(m: SettingsModel): EditDraft {
  return {
    display_name: m.display_name || '',
    context_window: m.context_window != null ? String(m.context_window) : '',
    free_tier_rpm: m.free_tier_rpm != null ? String(m.free_tier_rpm) : '',
    free_tier_rpd: m.free_tier_rpd != null ? String(m.free_tier_rpd) : '',
    free_tier_tpm: m.free_tier_tpm != null ? String(m.free_tier_tpm) : '',
    free_tier_tpd: m.free_tier_tpd != null ? String(m.free_tier_tpd) : '',
    supports_tools: !!m.supports_tools,
    supports_vision: !!m.supports_vision,
    supports_streaming: !!m.supports_streaming,
    enabled: !!m.enabled,
  };
}

function fromDraft(d: EditDraft): Partial<ModelUpdateBody> {
  const numOrNull = (s: string): number | null =>
    s.trim() === '' ? null : Number(s);
  return {
    display_name: d.display_name.trim() || null,
    context_window: numOrNull(d.context_window),
    free_tier_rpm: numOrNull(d.free_tier_rpm),
    free_tier_rpd: numOrNull(d.free_tier_rpd),
    free_tier_tpm: numOrNull(d.free_tier_tpm),
    free_tier_tpd: numOrNull(d.free_tier_tpd),
    supports_tools: d.supports_tools ? 1 : 0,
    supports_vision: d.supports_vision ? 1 : 0,
    supports_streaming: d.supports_streaming ? 1 : 0,
    enabled: d.enabled ? 1 : 0,
  };
}

function ModelRow({
  model,
  onReload,
  selected,
  onToggleSelect,
}: {
  model: SettingsModel;
  onReload: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => toDraft(model));

  const startEdit = () => {
    setDraft(toDraft(model));
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateModel(model.id, fromDraft(draft));
      setEditing(false);
      onReload();
    } catch (e: any) {
      alert(t('settings.model.save.fail', { msg: e?.message || String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(t('settings.model.delete.confirm', { name: model.model_name }))) return;
    try {
      await api.deleteModel(model.id);
      onReload();
    } catch (e: any) {
      alert(t('settings.model.delete.fail.single', { msg: e?.message || String(e) }));
    }
  };

  const quickToggleEnabled = async () => {
    try {
      await api.updateModel(model.id, { enabled: model.enabled ? 0 : 1 });
      onReload();
    } catch (e: any) {
      alert(t('settings.model.toggle.fail', { msg: e?.message || String(e) }));
    }
  };

  // ---- 编辑模式 ----
  if (editing) {
    return (
      <tr
        className="border-b border-border-subtle"
        style={{ backgroundColor: 'var(--bg-tertiary)' }}
      >
        <td className="py-2 px-2 text-center">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} disabled />
        </td>
        <td className="py-2 px-2 font-mono text-xs text-text-muted whitespace-nowrap">
          {model.model_name}
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs"
            value={draft.display_name}
            onChange={(e) =>
              setDraft({ ...draft, display_name: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs w-20"
            type="number"
            value={draft.context_window}
            onChange={(e) =>
              setDraft({ ...draft, context_window: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs w-16"
            type="number"
            value={draft.free_tier_rpm}
            onChange={(e) =>
              setDraft({ ...draft, free_tier_rpm: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs w-16"
            type="number"
            value={draft.free_tier_rpd}
            onChange={(e) =>
              setDraft({ ...draft, free_tier_rpd: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs w-20"
            type="number"
            value={draft.free_tier_tpm}
            onChange={(e) =>
              setDraft({ ...draft, free_tier_tpm: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1">
          <input
            className="input text-xs w-20"
            type="number"
            value={draft.free_tier_tpd}
            onChange={(e) =>
              setDraft({ ...draft, free_tier_tpd: e.target.value })
            }
          />
        </td>
        <td className="py-1 px-1 text-center">
          <input
            type="checkbox"
            checked={draft.supports_tools}
            onChange={(e) =>
              setDraft({ ...draft, supports_tools: e.target.checked })
            }
          />
        </td>
        <td className="py-1 px-1 text-center">
          <input
            type="checkbox"
            checked={draft.supports_vision}
            onChange={(e) =>
              setDraft({ ...draft, supports_vision: e.target.checked })
            }
          />
        </td>
        <td className="py-1 px-1 text-center">
          <input
            type="checkbox"
            checked={draft.supports_streaming}
            onChange={(e) =>
              setDraft({ ...draft, supports_streaming: e.target.checked })
            }
          />
        </td>
        <td className="py-1 px-1 text-center">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) =>
              setDraft({ ...draft, enabled: e.target.checked })
            }
          />
        </td>
        <td className="py-2 px-2 text-right whitespace-nowrap">
          <button
            className="btn-primary text-xs px-2 py-1"
            onClick={save}
            disabled={saving}
          >
            {saving ? '...' : t('settings.btn.save')}
          </button>
          <button
            className="btn-ghost text-xs px-2 py-1 ml-1"
            onClick={cancelEdit}
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
        </td>
      </tr>
    );
  }

  // ---- 查看模式 ----
  return (
    <tr
      className="border-b border-border-subtle hover:bg-bg-tertiary/30"
      style={{ opacity: model.enabled ? 1 : 0.6 }}
    >
      <td className="py-2 px-2 text-center">
        <input type="checkbox" checked={selected} onChange={onToggleSelect} />
      </td>
      <td className="py-2 px-2 font-mono text-xs whitespace-nowrap">
        {model.model_name}
      </td>
      <td className="py-2 px-2 text-text-secondary">
        {model.display_name || '-'}
      </td>
      <td className="py-2 px-2 text-text-secondary text-xs">
        {model.context_window ? model.context_window.toLocaleString() : '-'}
      </td>
      <td className="py-2 px-2 text-text-secondary text-xs">
        {model.free_tier_rpm ?? '-'}
      </td>
      <td className="py-2 px-2 text-text-secondary text-xs">
        {model.free_tier_rpd ?? '-'}
      </td>
      <td className="py-2 px-2 text-text-secondary text-xs">
        {model.free_tier_tpm ? model.free_tier_tpm.toLocaleString() : '-'}
      </td>
      <td className="py-2 px-2 text-text-secondary text-xs">
        {model.free_tier_tpd ? model.free_tier_tpd.toLocaleString() : '-'}
      </td>
      <td className="py-2 px-2 text-center">
        {model.supports_tools ? (
          <span className="text-success">✓</span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>
      <td className="py-2 px-2 text-center">
        {model.supports_vision ? (
          <span className="text-success">✓</span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>
      <td className="py-2 px-2 text-center">
        {model.supports_streaming ? (
          <span className="text-success">✓</span>
        ) : (
          <span className="text-text-muted">-</span>
        )}
      </td>
      <td className="py-2 px-2 text-center">
        <Toggle checked={!!model.enabled} onChange={quickToggleEnabled} />
      </td>
      <td className="py-2 px-2 text-right whitespace-nowrap">
        <button
          className="btn-ghost text-xs px-2 py-1"
          onClick={startEdit}
        >
          {t('settings.btn.edit')}
        </button>
        <button
          className="btn-ghost text-xs px-2 py-1"
          onClick={remove}
        >
          {t('settings.btn.delete')}
        </button>
      </td>
    </tr>
  );
}

// ============= 小型开关组件 =============
function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="w-9 h-5 rounded-full transition-colors relative inline-block"
      style={{
        backgroundColor: checked ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
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
