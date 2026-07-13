import { useState } from 'react';
import { api, UserToken } from '../lib/api';

export function TokensPage() {
  const [tokens, setTokens] = useState<UserToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.listTokens();
      setTokens(r.tokens);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useState(() => { load(); });
  if (loading) return <div>加载中...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">统一 API Key</h1>
          <p className="text-text-secondary text-sm mt-1">
            这是你给客户端 SDK 用的 key。所有请求都通过它路由到上游。
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowNew(true)}>+ 新建 Key</button>
      </div>

      {tokens.length === 0 ? (
        <div className="card text-center py-12 text-text-secondary">还没有 token</div>
      ) : (
        <div className="space-y-2">
          {tokens.map(t => (
            <TokenRow key={t.id} token={t} onChange={load} />
          ))}
        </div>
      )}

      {showNew && <NewTokenModal onClose={() => setShowNew(false)} onCreated={load} />}
    </div>
  );
}

function TokenRow({ token, onChange }: { token: UserToken; onChange: () => void }) {
  const [copied, setCopied] = useState(false);

  const remove = async () => {
    if (!confirm('确定删除这个 token?所有用它的客户端会立即失效。')) return;
    await api.deleteToken(token.id);
    onChange();
  };

  return (
    <div className="card flex items-center justify-between">
      <div className="flex-1">
        <div className="font-mono text-sm text-text-primary">{token.tokenHint}</div>
        <div className="text-xs text-text-muted mt-1">
          {token.label || '无标签'} · 创建于 {new Date(token.createdAt * 1000).toLocaleString()}
          {' · '}调用 {token.requestCount} 次
        </div>
      </div>
      <div className="flex items-center gap-2">
        {token.enabled ? (
          <span className="badge-healthy">启用</span>
        ) : (
          <span className="badge-muted">禁用</span>
        )}
        <button className="btn-ghost text-xs" onClick={remove}>🗑</button>
      </div>
    </div>
  );
}

function NewTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState<UserToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    setSubmitting(true);
    try {
      const t = await api.createToken(label || undefined);
      setToken(t);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (token?.tokenPlain) {
      await navigator.clipboard.writeText(token.tokenPlain);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="card max-w-lg w-full">
        <h2 className="text-lg font-semibold mb-4">新建统一 API Key</h2>
        {!token ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">标签 (可选)</label>
              <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="例如:OpenAI SDK / Claude Code" />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>取消</button>
              <button className="btn-primary" onClick={create} disabled={submitting}>
                {submitting ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-warning/10 border border-warning/30 rounded-md p-3 text-sm">
              ⚠️ 这是唯一一次看到完整 Key。请保存到密码管理器。
            </div>
            <div className="relative">
              <div className="input font-mono text-sm break-all pr-20 bg-bg-tertiary">
                {token.tokenPlain}
              </div>
              <button className="absolute right-2 top-1/2 -translate-y-1/2 btn-secondary py-1 text-xs" onClick={copy}>
                {copied ? '✓ 已复制' : '📋 复制'}
              </button>
            </div>
            <div className="text-xs text-text-muted bg-bg-tertiary p-3 rounded-md">
              <strong>用法:</strong>
              <pre className="mt-2 font-mono">{`curl https://your-worker.workers.dev/v1/chat/completions \\
  -H "Authorization: Bearer ${token.tokenPlain?.slice(0, 20)}..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'`}</pre>
            </div>
            <div className="flex justify-end">
              <button className="btn-primary" onClick={onClose}>已保存,关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
