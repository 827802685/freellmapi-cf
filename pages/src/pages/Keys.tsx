import { useEffect, useState } from 'react';
import { api, UserToken, ApiKey, setAuthToken, getAuthToken } from '../lib/api';
import { useT } from '../lib/i18n';

/** 安全复制到剪贴板,失败不抛错 */
async function safeCopy(s: string): Promise<boolean> {
  try {
    if (navigator?.clipboard && document.hasFocus()) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {}
  // 降级:用临时 textarea
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 密钥页 - 按原版 freellmapi 桌面应用布局
 *
 * 三大卡片:
 *  1) 统一 API 密钥(顶,显示你建的那个 freellmapi-***)
 *  2) 出站代理(中,SOCKS5/HTTP/HTTPS 配置)
 *  3) 添加提供方密钥(底,平台下拉 + key + 标签 + 添加按钮)
 *
 * 已添加的 keys 列表在"添加提供方密钥"卡片下方(可折叠)
 *
 * ⭐ 用户原始需求:添加 key 后立刻看到完整 key 一次 - 已实现
 */
export function KeysPage() {
  const t = useT();
  const [tokens, setTokens] = useState<UserToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showList, setShowList] = useState(true);

  const loadTokens = async () => {
    setLoading(true);
    try {
      const r = await api.listTokens();
      setTokens(r.tokens);
    } finally {
      setLoading(false);
    }
  };
  const loadKeys = async () => {
    setKeysLoading(true);
    try {
      const r = await api.listKeys();
      setKeys(r.keys);
    } finally {
      setKeysLoading(false);
    }
  };

  useEffect(() => {
    loadTokens();
    loadKeys();
  }, []);

  return (
    <div className="space-y-6">
      {/* ===== 卡片 1: 统一 API 密钥 ===== */}
      <UnifiedKeyCard tokens={tokens} loading={loading} onChange={loadTokens} />

      {/* ===== 卡片 2: 出站代理(已删除 - CF Workers 不支持客户端代理) ===== */}

      {/* ===== 卡片 3: 添加提供方密钥 (内置平台) ===== */}
      <AddProviderKeyCard onAdded={loadKeys} />

      {/* ===== 卡片 4: 自定义提供商密钥 ===== */}
      <CustomProviderKeyCard onAdded={loadKeys} />

      {/* ===== 已添加的 keys 列表(可折叠) ===== */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">{t('keys.list.count', { n: keys.length })}</h2>
            <p className="text-xs text-text-muted mt-0.5">{t('keys.list.desc')}</p>
          </div>
          <button className="btn-ghost text-xs" onClick={() => setShowList(v => !v)}>
            {showList ? t('keys.list.collapse') : t('keys.list.expand')}
          </button>
        </div>
        {showList && (
          keysLoading ? (
            <div className="text-center py-6 text-text-secondary text-sm">{t('common.loading')}</div>
          ) : keys.length === 0 ? (
            <div className="text-center py-6 text-text-muted text-sm">{t('keys.list.empty')}</div>
          ) : (
            <KeysListTable keys={keys} onChange={loadKeys} />
          )
        )}
      </div>
    </div>
  );
}

// ============= 卡片 1: 统一 API 密钥 =============
function UnifiedKeyCard({ tokens, loading, onChange }: { tokens: UserToken[]; loading: boolean; onChange: () => void }) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealedNewToken, setRevealedNewToken] = useState<string | null>(null);

  const createFirst = async () => {
    setCreating(true);
    try {
      await api.createToken(undefined);
      onChange();
    } finally {
      setCreating(false);
    }
  };

  const regenerate = async () => {
    if (!tokens[0]) return;
    if (!confirm(t('common.regen.warn'))) return;
    const r = await api.regenerateToken(tokens[0].id);
    // 立即存到 localStorage,试玩台就能用了
    setAuthToken(r.tokenPlain);
    // 安全复制(不抛错)
    await safeCopy(r.tokenPlain);
    // 用自定义模态而不是 alert,让用户能看清 + 重试
    setRevealedNewToken(r.tokenPlain);
    onChange();
  };

  const copy = async () => {
    if (tokens[0]) {
      const r = await api.getTokenPlain(tokens[0].id);
      // 同时存到 localStorage(防止下次又没 token)
      setAuthToken(r.keyPlain);
      const ok = await safeCopy(r.keyPlain);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        // 失败:弹窗显示明文让用户手动复制
        prompt(t('keys.copy.fail'), r.keyPlain);
      }
    }
  };

  const [revealedPlain, setRevealedPlain] = useState<string | null>(null);
  const [hideTimer, setHideTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const showKey = async () => {
    // 如果当前已显示 → 隐藏
    if (show) {
      setShow(false);
      setRevealedPlain(null);
      if (hideTimer) { clearTimeout(hideTimer); setHideTimer(null); }
      return;
    }
    // 当前隐藏 → 显示(需先拉取明文)
    if (tokens[0]) {
      try {
        const r = await api.getTokenPlain(tokens[0].id);
        setRevealedPlain(r.keyPlain);
        setAuthToken(r.keyPlain);
        setShow(true);
        // 30 秒后自动隐藏
        const timer = setTimeout(() => {
          setShow(false);
          setRevealedPlain(null);
          setHideTimer(null);
        }, 30_000);
        setHideTimer(timer);
      } catch (e: any) {
        alert(t('keys.getPlain.fail') + e.message);
      }
    }
  };

  // 探测 base URL — 从后端 /api/about 读取 BACKEND_URL,这样换域名自动同步
  const [finalBase, setFinalBase] = useState('');
  useEffect(() => {
    fetch('/api/about')
      .then(r => r.json())
      .then(d => {
        // about 返回 endpoints.base 或 backendUrl
        const base = d.backendUrl || d.endpoints?.base || '';
        if (base) {
          setFinalBase(base.replace(/\/+$/, '').replace(/\/v1$/, ''));
        } else {
          // fallback: 用当前域名
          setFinalBase(typeof window !== 'undefined' ? window.location.origin : '');
        }
      })
      .catch(() => {
        setFinalBase(typeof window !== 'undefined' ? window.location.origin : '');
      });
  }, []);
  const masked = (hint: string) => hint; // 后端返回的就是 hint(sk-***xx),用 :id/plain 拿明文

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t('keys.unified.title')}</h2>
          <p className="text-xs text-text-muted mt-1">
            {t('keys.unified.desc')}
          </p>
        </div>
        {tokens.length > 0 && (
          <button className="btn-ghost text-xs" onClick={regenerate}>{t('keys.unified.regenerate')}</button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-text-muted py-2">{t('common.loading')}</div>
      ) : tokens.length === 0 ? (
        <div className="space-y-2">
          <div className="text-sm text-text-muted">{t('common.empty.unified')}</div>
          <button className="btn-primary" onClick={createFirst} disabled={creating}>
            {creating ? t('keys.unified.creating') : t('keys.unified.create')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-sm"
              readOnly
              value={show ? (revealedPlain || t('common.loading')) : tokens[0].tokenHint}
            />
            <button className="btn-secondary text-sm" onClick={showKey}>
              {show ? t('keys.unified.hide') : t('keys.unified.show')}
            </button>
            <button className="btn-secondary text-sm" onClick={copy}>
              {copied ? t('keys.unified.copied') : t('keys.unified.copy')}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <div className="flex gap-2 py-1">
              <span className="text-text-muted w-24 flex-shrink-0">{t('keys.unified.baseurl')}</span>
              <code className="font-mono text-xs break-all">{finalBase}/v1</code>
            </div>
            <div className="flex gap-2 py-1">
              <span className="text-text-muted w-24 flex-shrink-0">{t('keys.unified.chat')}</span>
              <code className="font-mono text-xs break-all">/v1/chat/completions</code>
            </div>
            <div className="flex gap-2 py-1">
              <span className="text-text-muted w-24 flex-shrink-0">{t('keys.unified.responses')}</span>
              <code className="font-mono text-xs break-all">/v1/responses</code>
            </div>
            <div className="flex gap-2 py-1">
              <span className="text-text-muted w-24 flex-shrink-0">{t('keys.unified.embeddings')}</span>
              <code className="font-mono text-xs break-all">/v1/embeddings</code>
            </div>
          </div>
        </div>
      )}

      {/* 重新生成后的新 token 模态 */}
      {revealedNewToken && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
          onClick={() => setRevealedNewToken(null)}
        >
          <div
            className="card max-w-md w-full"
            style={{ backgroundColor: 'var(--bg-secondary)' }}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold mb-2">{t('keys.unified.newToken.title')}</h2>
            <p className="text-xs text-text-secondary mb-3">
              {t('keys.unified.newToken.warn')}
              <br />
              <span className="text-success">{t('keys.unified.newToken.saved')}</span>
            </p>
            <pre
              className="text-xs font-mono p-3 rounded break-all whitespace-pre-wrap"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              {revealedNewToken}
            </pre>
            <div className="flex gap-2 mt-3">
              <button
                className="btn-primary flex-1"
                onClick={async () => {
                  const ok = await safeCopy(revealedNewToken);
                  if (!ok) prompt(t('keys.copy.fail.short'), revealedNewToken);
                }}
              >
                {t('keys.action.copy')}
              </button>
              <button className="btn-secondary" onClick={() => setRevealedNewToken(null)}>
                {t('keys.add.revealed.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============= 卡片 2: 出站代理(已删除) =============

// ============= 卡片 3: 添加提供方密钥 (内置平台,还原原样) =============
const PROVIDER_OPTIONS = [
  { value: '', label: 'keys.add.platform.placeholder' },
  { value: 'groq', label: 'Groq' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'opencode', label: 'OpenCode Zen' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'zai', label: 'Z.ai (Zhipu)' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'huggingface', label: 'HuggingFace' },
  { value: 'ollama', label: 'Ollama Cloud' },
  { value: 'kilo', label: 'Kilo Gateway' },
  { value: 'pollinations', label: 'Pollinations (anon)' },
  { value: 'llm7', label: 'LLM7 (anon)' },
  { value: 'ovh', label: 'OVH AI Endpoints' },
  { value: 'horde', label: 'AI Horde (anon)' },
  { value: 'custom', label: 'Custom OpenAI-compatible' },
];

function AddProviderKeyCard({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const [platform, setPlatform] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [revealed, setRevealed] = useState<{ keyPlain: string; keyHint: string; platform: string; count: number; customBaseUrl?: string | null } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!platform) { setErr(t('common.req.provider')); return; }
    if (platform === 'custom' && !customBaseUrl.trim()) { setErr(t('common.req.customUrl')); return; }
    if (!key.trim()) { setErr(t('common.req.key')); return; }
    setSubmitting(true);
    setErr('');
    try {
      const r: any = await api.createKey({
        platform,
        key: key.trim(),
        label: label.trim() || undefined,
        customBaseUrl: platform === 'custom' ? customBaseUrl.trim().replace(/\/+$/, '') : undefined,
      });
      setRevealed({ keyPlain: r.keyPlain, keyHint: r.keyHint, platform: r.platform, count: r.count, customBaseUrl: r.customBaseUrl });
      setKey('');
      setLabel('');
      setCustomBaseUrl('');
      onAdded();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RevealModal revealed={revealed} onClose={() => setRevealed(null)}>
      <div className="card">
        <h2 className="text-base font-semibold mb-3">{t('keys.add.title')}</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-3">
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.platform')}</label>
              <select
                className="input text-sm w-full"
                value={platform}
                onChange={e => setPlatform(e.target.value)}
              >
                {PROVIDER_OPTIONS.map(p => (
                  <option key={p.value} value={p.value}>{p.value ? p.label : t(p.label)}</option>
                ))}
              </select>
            </div>
            {platform === 'custom' && (
              <div className="md:col-span-6">
                <label className="block text-xs text-text-muted mb-1">{t('keys.add.custom.url')}</label>
                <input
                  className="input text-sm font-mono w-full"
                  placeholder={t('keys.add.custom.placeholder')}
                  value={customBaseUrl}
                  onChange={e => setCustomBaseUrl(e.target.value)}
                />
                <div className="text-xs text-text-muted mt-1">
                  {t('keys.add.custom.hint')}
                </div>
              </div>
            )}
            <div className={platform === 'custom' ? 'md:col-span-3' : 'md:col-span-6'}>
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.key')}</label>
              <input
                className="input text-sm font-mono w-full"
                placeholder={t('keys.add.key.placeholder.alt')}
                value={key}
                onChange={e => setKey(e.target.value)}
              />
            </div>
            <div className="md:col-span-3">
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.label')}</label>
              <input
                className="input text-sm w-full"
                placeholder={t('keys.add.label.placeholder')}
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
            </div>
          </div>

          {err && (
            <pre className="text-xs text-danger whitespace-pre-wrap break-words rounded p-2" style={{ backgroundColor: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
              {err}
            </pre>
          )}

          <div className="flex justify-end">
            <button type="submit" className="btn-secondary text-sm" disabled={submitting || !platform || !key}>
              {submitting ? t('keys.add.btn.busy') : t('keys.add.btn')}
            </button>
          </div>
        </form>
      </div>
    </RevealModal>
  );
}

// ============= 卡片 4: 自定义提供商密钥 (独立卡片,4 个自定义字段) =============
function CustomProviderKeyCard({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModels, setCustomModels] = useState('');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [revealed, setRevealed] = useState<{ keyPlain: string; keyHint: string; platform: string; count: number; customBaseUrl?: string | null } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customBaseUrl.trim()) { setErr(t('keys.add.custom.baseUrl.req')); return; }
    if (!key.trim()) { setErr(t('keys.add.custom.key.req')); return; }
    setSubmitting(true);
    setErr('');
    try {
      const r: any = await api.createKey({
        platform: 'custom',
        key: key.trim(),
        label: label.trim() || undefined,
        customBaseUrl: customBaseUrl.trim().replace(/\/+$/, ''),
        customModels: customModels.trim() || undefined,
      });
      setRevealed({ keyPlain: r.keyPlain, keyHint: r.keyHint, platform: r.platform, count: r.count, customBaseUrl: r.customBaseUrl });
      setKey('');
      setLabel('');
      setCustomBaseUrl('');
      setCustomModels('');
      onAdded();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RevealModal revealed={revealed} onClose={() => setRevealed(null)}>
      <div className="card" style={{ borderColor: 'var(--accent-primary)' }}>
        <h2 className="text-base font-semibold mb-1">{t('keys.add.custom.title')}</h2>
        <p className="text-xs text-text-muted mb-3">
          {t('keys.add.custom.desc')}
        </p>
        <form onSubmit={submit} className="space-y-3">
          {/* 第一行: Base URL + 自定义模型 */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-7">
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.custom.baseUrl')}</label>
              <input
                className="input text-sm font-mono w-full"
                placeholder={t('keys.add.custom.placeholder')}
                value={customBaseUrl}
                onChange={e => setCustomBaseUrl(e.target.value)}
              />
              <div className="text-xs text-text-muted mt-1">
                {t('keys.add.custom.hint')}
              </div>
            </div>
            <div className="md:col-span-5">
              <label className="block text-xs text-text-muted mb-1">
                {t('keys.add.custom.models')} <span className="text-text-muted">({t('keys.add.custom.models.hint')})</span>
              </label>
              <input
                className="input text-sm font-mono w-full"
                placeholder="deepseek-chat, deepseek-coder"
                value={customModels}
                onChange={e => setCustomModels(e.target.value)}
              />
              <div className="text-xs text-text-muted mt-1">
                {t('keys.add.custom.models.desc')}
              </div>
            </div>
          </div>

          {/* 第二行: 密钥 + 标签 */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-7">
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.custom.key')}</label>
              <input
                className="input text-sm font-mono w-full"
                placeholder={t('keys.add.key.placeholder.alt')}
                value={key}
                onChange={e => setKey(e.target.value)}
              />
            </div>
            <div className="md:col-span-5">
              <label className="block text-xs text-text-muted mb-1">{t('keys.add.custom.label')}</label>
              <input
                className="input text-sm w-full"
                placeholder={t('keys.add.custom.label.placeholder')}
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
            </div>
          </div>

          {err && (
            <pre className="text-xs text-danger whitespace-pre-wrap break-words rounded p-2" style={{ backgroundColor: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
              {err}
            </pre>
          )}

          <div className="flex justify-end">
            <button type="submit" className="btn-primary text-sm" disabled={submitting || !customBaseUrl || !key}>
              {submitting ? t('keys.add.btn.busy') : t('keys.add.custom.submit')}
            </button>
          </div>
        </form>
      </div>
    </RevealModal>
  );
}

// ============= 密钥添加成功弹窗(复用) =============
function RevealModal({
  revealed,
  onClose,
  children,
}: {
  revealed: { keyPlain: string } | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      {children}
      {revealed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="card max-w-lg w-full">
            <h2 className="text-lg font-semibold mb-2">{t('keys.add.revealed.title')}</h2>
            <p className="text-sm text-text-secondary mb-4">
              {t('keys.add.revealed.warning')}
            </p>
            <div className="rounded-md p-3 text-sm font-mono break-all mb-4" style={{ backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}>
              {revealed.keyPlain}
            </div>
            <div className="flex justify-between items-center">
              <button
                className="btn-secondary"
                onClick={async () => { const ok = await safeCopy(revealed.keyPlain); if (!ok) prompt(t('keys.copy.fail.short'), revealed.keyPlain); }}
              >
                {t('keys.add.revealed.copy')}
              </button>
              <button className="btn-primary" onClick={onClose}>
                {t('keys.add.revealed.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============= 已添加的 keys 列表(精简,保留 👁/🔄/🎮/🗑 四个核心按钮) =============
function KeysListTable({ keys, onChange }: { keys: ApiKey[]; onChange: () => void }) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-text-muted uppercase">
          <tr className="border-b border-border-subtle">
            <th className="text-left py-2 px-2 font-medium">{t('keys.list.col.platform')}</th>
            <th className="text-left py-2 px-2 font-medium">{t('keys.list.col.label')}</th>
            <th className="text-left py-2 px-2 font-medium">{t('keys.list.col.key')}</th>
            <th className="text-left py-2 px-2 font-medium">{t('keys.list.col.status')}</th>
            <th className="text-right py-2 px-2 font-medium">{t('keys.list.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <KeyRowInline key={k.id} apiKey={k} onChange={onChange} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyRowInline({ apiKey, onChange }: { apiKey: ApiKey; onChange: () => void }) {
  const t = useT();
  const [revealing, setRevealing] = useState(false);
  const [plain, setPlain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reveal = async () => {
    if (revealing) { setRevealing(false); setPlain(null); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await api.getKeyPlain(apiKey.id);
      setPlain(r.keyPlain);
      setRevealing(true);
      setTimeout(() => { setRevealing(false); setPlain(null); }, 10_000);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      await api.checkKey(apiKey.id);
      setTimeout(onChange, 3000);
    } catch (e: any) {
      alert(t('common.check.fail', { msg: e.message }));
    } finally {
      setBusy(false);
    }
  };

  const syncModels = async () => {
    setBusy(true);
    try {
      const r = await api.syncModels(apiKey.id);
      alert(t('keys.sync.success', { platform: r.platform, total: r.total, added: r.added, skipped: r.skipped }));
      onChange();
    } catch (e: any) {
      alert(t('keys.sync.fail', { msg: e.message }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(t('common.del.confirm'))) return;
    await api.deleteKey(apiKey.id);
    onChange();
  };

  return (
    <>
      <tr className="border-b border-border-subtle hover:bg-bg-tertiary/30">
        <td className="py-2 px-2"><span className="badge-muted">{apiKey.platform}</span></td>
        <td className="py-2 px-2 text-text-secondary">{apiKey.label || '-'}</td>
        <td className="py-2 px-2 font-mono text-xs">
          {revealing && plain ? <span className="text-accent-primary">{plain}</span> : <span className="text-text-muted">{apiKey.keyHint}</span>}
        </td>
        <td className="py-2 px-2">
          {apiKey.healthStatus === 'healthy' && <span className="badge-healthy">{t('keys.status.healthy')}</span>}
          {apiKey.healthStatus === 'error' && <span className="badge-danger">{t('keys.status.error')}</span>}
          {!['healthy', 'error'].includes(apiKey.healthStatus) && <span className="badge-muted">{apiKey.healthStatus || t('keys.status.unknown')}</span>}
        </td>
        <td className="py-2 px-2 text-right">
          <button className="btn-ghost text-xs p-1" onClick={reveal} disabled={busy} title={t('keys.action.show.short')}>{revealing ? '🙈' : '👁'}</button>
          <button className="btn-ghost text-xs p-1" onClick={syncModels} disabled={busy} title={t('keys.action.sync')}>📥</button>
          <button className="btn-ghost text-xs p-1" onClick={check} disabled={busy} title={t('keys.action.check')}>🔄</button>
          <button className="btn-ghost text-xs p-1" onClick={remove} title={t('keys.action.delete')}>🗑</button>
        </td>
      </tr>
      {err && (
        <tr><td colSpan={5}><pre className="text-xs text-danger p-2">{err}</pre></td></tr>
      )}
    </>
  );
}
