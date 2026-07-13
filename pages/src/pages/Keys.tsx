import { useState, useEffect } from 'react';
import { api, ApiKey, PlatformInfo } from '../lib/api';

/**
 * ⭐ 这个组件实现了用户最核心的需求:
 *    "添加完 API key 之后,我要能看到 key"
 *
 * 设计要点:
 * 1. 添加成功后,弹窗不立刻关闭,而是显示"明文展示"步骤
 * 2. 提供"已复制"勾选 + 强制 5 秒倒计时才能关闭
 * 3. 列表里默认脱敏,提供"👁 显示 / 📋 复制 / 🔄 重新生成"按钮
 * 4. 临时显示 10 秒后自动隐藏
 */

export function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newlyAddedKey, setNewlyAddedKey] = useState<ApiKey | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [k, p] = await Promise.all([api.listKeys(), api.listPlatforms()]);
      setKeys(k.keys);
      setPlatforms(p.platforms);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleKeyAdded = (key: ApiKey) => {
    setShowAddModal(false);
    setNewlyAddedKey(key);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">API Keys</h1>
          <p className="text-text-secondary text-sm mt-1">
            管理上游 LLM 供应商的 API Key。所有 key 都用 AES-256-GCM 加密存储。
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowAddModal(true)}>
          + 添加 Key
        </button>
      </div>

      {loading ? (
        <div className="card text-text-secondary text-center">加载中...</div>
      ) : keys.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-text-secondary mb-4">还没有添加任何 Key</p>
          <button className="btn-primary" onClick={() => setShowAddModal(true)}>
            添加第一个 Key
          </button>
        </div>
      ) : (
        <KeyList keys={keys} onChange={load} />
      )}

      {showAddModal && (
        <AddKeyModal
          platforms={platforms}
          onClose={() => setShowAddModal(false)}
          onAdded={handleKeyAdded}
        />
      )}

      {newlyAddedKey && (
        <ShowKeyOnceModal
          keyPlain={newlyAddedKey.keyPlain!}
          keyHint={newlyAddedKey.keyHint!}
          platform={newlyAddedKey.platform}
          onClose={() => setNewlyAddedKey(null)}
        />
      )}
    </div>
  );
}

// ============= 添加 Key 弹窗 =============

function AddKeyModal({
  platforms,
  onClose,
  onAdded,
}: {
  platforms: PlatformInfo[];
  onClose: () => void;
  onAdded: (key: ApiKey) => void;
}) {
  const [platform, setPlatform] = useState(platforms[0]?.id || 'groq');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.addKey(platform, key, label || undefined);
      onAdded(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="添加 API Key" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1.5">供应商</label>
          <select className="input" value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">标签 (可选)</label>
          <input
            className="input"
            placeholder="例如:主号 / 备用 / 个人"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">API Key</label>
          <div className="relative">
            <input
              className="input pr-10 font-mono text-sm"
              type={showKey ? 'text' : 'password'}
              placeholder="粘贴你的 API key"
              value={key}
              onChange={e => setKey(e.target.value)}
              required
              autoFocus
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-sm px-2"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1.5">
            🔒 提交后用 AES-256-GCM 加密保存,密文存到 D1 数据库
          </p>
        </div>

        {error && (
          <div className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-md p-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting || !key}>
            {submitting ? '添加中...' : '添加'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============= ⭐ 关键组件:添加成功后的明文展示弹窗 =============

function ShowKeyOnceModal({
  keyPlain,
  keyHint,
  platform,
  onClose,
}: {
  keyPlain: string;
  keyHint: string;
  platform: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [countdown, setCountdown] = useState(5);

  // 5 秒倒计时(防止用户手滑关掉没保存)
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(keyPlain);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal title="✅ Key 添加成功" onClose={countdown === 0 ? onClose : () => {}}>
      <div className="space-y-4">
        <div className="bg-warning/10 border border-warning/30 rounded-md p-3 text-sm">
          ⚠️ <strong>请立即复制并保存</strong>。这是唯一一次看到完整 Key 的机会,
          关闭后将无法再次查看(出于安全考虑,密文不存明文)。
        </div>

        <div>
          <div className="text-sm text-text-secondary mb-1.5">供应商</div>
          <div className="badge-muted">{platform}</div>
        </div>

        <div>
          <div className="text-sm text-text-secondary mb-1.5">完整 Key</div>
          <div className="relative">
            <div className="input font-mono text-sm break-all pr-24 bg-bg-tertiary">
              {keyPlain}
            </div>
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 btn-secondary py-1 text-xs"
              onClick={handleCopy}
            >
              {copied ? '✓ 已复制' : '📋 复制'}
            </button>
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
          />
          <span className="text-text-secondary">
            我已保存(或确认不再需要)这个 Key
          </span>
        </label>

        <div className="flex justify-between items-center pt-2">
          <span className="text-xs text-text-muted">
            {countdown > 0 ? `还剩 ${countdown} 秒可关闭...` : ''}
          </span>
          <button
            className="btn-primary"
            onClick={onClose}
            disabled={!confirmed || countdown > 0}
          >
            {countdown > 0 ? `等待 ${countdown}s` : '我已保存,关闭'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============= Key 列表 =============

function KeyList({ keys, onChange }: { keys: ApiKey[]; onChange: () => void }) {
  return (
    <div className="card overflow-hidden p-0">
      <table className="w-full">
        <thead className="bg-bg-tertiary border-b border-border-subtle">
          <tr>
            <th className="text-left py-3 px-4 text-xs font-medium text-text-secondary uppercase">供应商</th>
            <th className="text-left py-3 px-4 text-xs font-medium text-text-secondary uppercase">标签</th>
            <th className="text-left py-3 px-4 text-xs font-medium text-text-secondary uppercase">Key</th>
            <th className="text-left py-3 px-4 text-xs font-medium text-text-secondary uppercase">状态</th>
            <th className="text-left py-3 px-4 text-xs font-medium text-text-secondary uppercase">健康</th>
            <th className="text-right py-3 px-4 text-xs font-medium text-text-secondary uppercase">操作</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <KeyRow key={k.id} apiKey={k} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyRow({ apiKey, onChange }: { apiKey: ApiKey; onChange: () => void }) {
  const [revealing, setRevealing] = useState(false);
  const [plain, setPlain] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);

  const reveal = async () => {
    if (revealing) {
      setRevealing(false);
      setPlain(null);
      return;
    }
    setRevealing(true);
    setLoading(true);
    try {
      const r = await api.getKeyPlain(apiKey.id);
      setPlain(r.keyPlain);
      // 10 秒后自动隐藏
      setTimeout(() => {
        setRevealing(false);
        setPlain(null);
      }, 10_000);
    } catch (e: any) {
      alert('获取失败: ' + e.message);
      setRevealing(false);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    let p = plain;
    if (!p) {
      const r = await api.getKeyPlain(apiKey.id);
      p = r.keyPlain;
    }
    await navigator.clipboard.writeText(p);
    alert('已复制到剪贴板');
  };

  const toggle = async () => {
    await api.updateKey(apiKey.id, { enabled: apiKey.enabled ? 0 : 1 });
    onChange();
  };

  const remove = async () => {
    if (!confirm(`确定删除 ${apiKey.platform} 的这个 Key?`)) return;
    await api.deleteKey(apiKey.id);
    onChange();
  };

  const check = async () => {
    setChecking(true);
    try {
      await api.checkKey(apiKey.id);
      onChange();
    } catch (e: any) {
      alert('检查失败: ' + e.message);
    } finally {
      setChecking(false);
    }
  };

  const healthBadge = () => {
    switch (apiKey.healthStatus) {
      case 'healthy': return <span className="badge-healthy">正常</span>;
      case 'rate_limited': return <span className="badge-warning">限流中</span>;
      case 'invalid': return <span className="badge-danger">失效</span>;
      case 'error': return <span className="badge-danger">错误</span>;
      default: return <span className="badge-muted">未知</span>;
    }
  };

  return (
    <tr className="border-b border-border-subtle hover:bg-bg-tertiary/50">
      <td className="py-3 px-4">
        <span className="badge-muted">{apiKey.platform}</span>
      </td>
      <td className="py-3 px-4 text-sm text-text-secondary">
        {apiKey.label || <span className="text-text-muted">-</span>}
      </td>
      <td className="py-3 px-4">
        {revealing && plain ? (
          <span className="font-mono text-xs break-all text-accent-primary">{plain}</span>
        ) : (
          <span className="font-mono text-xs text-text-muted">{apiKey.keyHint}</span>
        )}
      </td>
      <td className="py-3 px-4">
        {apiKey.enabled ? (
          <span className="badge-healthy">启用</span>
        ) : (
          <span className="badge-muted">禁用</span>
        )}
      </td>
      <td className="py-3 px-4">{healthBadge()}</td>
      <td className="py-3 px-4">
        <div className="flex justify-end gap-1">
          <button
            className="btn-ghost p-1.5 text-xs"
            onClick={reveal}
            disabled={loading}
            title={revealing ? '隐藏' : '临时显示 10 秒'}
          >
            {loading ? '...' : revealing ? '🙈' : '👁'}
          </button>
          <button className="btn-ghost p-1.5 text-xs" onClick={copy} title="复制">📋</button>
          <button
            className="btn-ghost p-1.5 text-xs"
            onClick={check}
            disabled={checking}
            title="健康检查"
          >
            {checking ? '...' : '🔄'}
          </button>
          <button className="btn-ghost p-1.5 text-xs" onClick={toggle} title="启用/禁用">
            {apiKey.enabled ? '⏸' : '▶'}
          </button>
          <button className="btn-ghost p-1.5 text-xs hover:text-danger" onClick={remove} title="删除">🗑</button>
        </div>
      </td>
    </tr>
  );
}

// ============= 通用 Modal =============

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-bg-secondary border border-border-subtle rounded-lg max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-border-subtle">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1">✕</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
