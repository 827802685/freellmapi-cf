import { useEffect, useRef, useState } from 'react';
import { api, setAuthToken } from '../lib/api';
import { useT } from '../lib/i18n';

const TOKEN_HINT = (() => {
  if (typeof localStorage === 'undefined') return false;
  return !!localStorage.getItem('fl_token');
})();

type RoutingMode = 'auto' | 'fusion' | 'fastest' | 'smartest' | 'manual';
// label / desc 存放 i18n key,渲染时用 t() 翻译
const ROUTING_MODES: { id: RoutingMode; label: string; desc: string }[] = [
  { id: 'auto', label: 'mode.auto', desc: 'mode.desc.auto' },
  { id: 'fusion', label: 'mode.fusion', desc: 'mode.desc.fusion' },
  { id: 'fastest', label: 'mode.fastest', desc: 'mode.desc.fastest' },
  { id: 'smartest', label: 'mode.smartest', desc: 'mode.desc.smartest' },
  { id: 'manual', label: 'mode.manual', desc: 'mode.desc.manual' },
];

// 哪些平台是有 seed 模型的(由后端 /api/models 返回)
const PROVIDER_PRESETS = [
  { value: 'groq', label: 'Groq' },
  { value: 'google', label: 'Google' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'pollinations', label: 'Pollinations' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'opencode', label: 'OpenCode Zen' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'nvidia', label: 'NVIDIA' },
  { value: 'huggingface', label: 'HuggingFace' },
];

interface ModelInfo {
  id: number;
  name: string;
  displayName: string | null;
  platform: string;
  family: string | null;
  context: number | null;
  enabled: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  freeTier: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  activeKeys: number;
}

interface Msg { role: 'user' | 'assistant'; content: string; error?: string; }

export function PlaygroundPage() {
  const t = useT();
  const [mode, setMode] = useState<RoutingMode>('auto');
  const [provider, setProvider] = useState<string>('groq');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<string>('');
  const [stream] = useState(true);
  const [maxTokens] = useState(500);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [usage, setUsage] = useState<{ latency?: number; platform?: string; model?: string; actualModel?: string } | null>(null);
  const [abort, setAbort] = useState<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // 加载当前账号配了 key 的平台列表(优先显示"我有 key 的"),仅初始化一次
  const [providersInitialized, setProvidersInitialized] = useState(false);
  useEffect(() => {
    if (mode !== 'manual' || providersInitialized) return;
    api.listKeys()
      .then((j: any) => {
        const myPlatforms: string[] = Array.from(new Set((j.keys || []).map((k: any) => k.platform))) as string[];
        const presetSet = new Set(PROVIDER_PRESETS.map(p => p.value));
        const ordered: string[] = [
          ...myPlatforms,
          ...PROVIDER_PRESETS.map(p => p.value).filter((v: string) => !myPlatforms.includes(v)),
        ].filter((v: string) => presetSet.has(v) || myPlatforms.includes(v));
        setAvailableProviders(ordered);
        if (ordered.length > 0) {
          setProvider(ordered[0]); // 只在首次加载时自动选第一个
        }
        setProvidersInitialized(true);
      })
      .catch(() => setAvailableProviders(PROVIDER_PRESETS.map(p => p.value)));
  }, [mode, providersInitialized]);

  // 检测统一 token (每次挂载都重新读)
  const [hasUnifiedToken, setHasUnifiedToken] = useState(true);
  useEffect(() => {
    const tk = typeof localStorage !== 'undefined' ? localStorage.getItem('fl_token') : null;
    setHasUnifiedToken(!!tk);
  }, []);

  // 如果没 token 但后端有 user_token,自动重新生成一个 → 存到 localStorage
  useEffect(() => {
    if (hasUnifiedToken) return;
    (async () => {
      try {
        const j: any = await api.listTokens();
        const list: any[] = j.tokens || [];
        if (list.length === 0) return;
        const r: any = await api.regenerateToken(list[0].id);
        if (r?.tokenPlain) {
          setAuthToken(r.tokenPlain);
          setHasUnifiedToken(true);
        }
      } catch { /* 静默 */ }
    })();
  }, [hasUnifiedToken]);

  // 切 provider 或 mode 时拉模型列表(所有模式都拉,只是发送时格式不同)
  useEffect(() => {
    let cancelled = false; // 防止竞态:provider 切换后旧请求返回时丢弃
    setModelsLoading(true);
    setModels([]); // 先清空,避免显示上一个 provider 的模型
    setModel('');
    api.listModels(provider)
      .then(j => {
        if (cancelled) return; // 已经切到别的 provider 了,丢弃
        const list: ModelInfo[] = (j.models || []).map((m: any) => ({
          id: m.id,
          name: m.model_name || m.name,
          displayName: m.display_name || m.displayName,
          platform: m.platform,
          family: m.family,
          context: m.context_window || m.context,
          enabled: m.enabled === 1 || m.enabled === true,
          supportsTools: m.supports_tools === 1 || m.supportsTools === true,
          supportsVision: m.supports_vision === 1 || m.supportsVision === true,
          freeTier: m.freeTier || {
            rpm: m.free_tier_rpm, rpd: m.free_tier_rpd,
            tpm: m.free_tier_tpm, tpd: m.free_tier_tpd,
          },
          activeKeys: m.activeKeys || 0,
        }));
        setModels(list);
        if (list.length > 0) {
          setModel(list[0].name);
        }
      })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; }; // cleanup:下次 effect 运行时标记上一次为 cancelled
  }, [provider, mode]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr('');
    setUsage(null);
    setInput('');

    const newMsgs: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(newMsgs);

    const ac = new AbortController();
    setAbort(ac);
    const API_BASE = (import.meta.env.VITE_API_BASE as string) || '';
    const FULL_URL = API_BASE + '/v1/chat/completions';
    try {
      const token = localStorage.getItem('fl_token');
      // auto 模式让后端自动选,manual 模式发 provider:model 格式
      const requestModel = mode === 'manual' ? `${provider}:${model}` : 'auto';
      console.log('[freellmapi] request URL:', FULL_URL, 'token:', token ? token.slice(0, 20) + '...' : 'NONE', 'mode:', mode);
      const r = await fetch(FULL_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Route-Mode': mode, // 传递路由策略给后端
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ model: requestModel, stream, max_tokens: maxTokens, messages: newMsgs }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const latency = parseInt(r.headers.get('X-Latency-Ms') || '0') || undefined;
      const platform = r.headers.get('X-Platform') || undefined;
      const usedModel = r.headers.get('X-Model') || model;

      if (stream && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        setMessages(m => [...m, { role: 'assistant', content: '' }]);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const j = JSON.parse(data);
                const delta = j.choices?.[0]?.delta?.content || '';
                if (delta) {
                  setMessages(m => {
                    const last = m[m.length - 1];
                    if (last?.role === 'assistant') {
                      return [...m.slice(0, -1), { ...last, content: last.content + delta }];
                    }
                    return m;
                  });
                }
              } catch {}
            }
          }
        }
        setUsage({ latency, platform, model: usedModel, actualModel: requestModel });
      } else {
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content || JSON.stringify(j);
        setMessages(m => [...m, { role: 'assistant', content: text }]);
        setUsage({ latency, platform, model: usedModel, actualModel: requestModel });
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setErr(t('play.error.cancel'));
      } else if (e.message === 'Failed to fetch' || e.message?.includes('NetworkError') || e.message?.includes('fetch')) {
        setErr(t('play.error.network', { url: FULL_URL }));
      } else {
        setErr(e?.message || String(e));
      }
    } finally {
      setBusy(false);
      setAbort(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const stop = () => abort?.abort();

  const selectedModel = models.find(m => m.name === model);

  return (
    <div className="space-y-4">
      {/* 顶部一行:路由策略 + (手动模式时)provider + 模型下拉 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          {ROUTING_MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                mode === m.id ? 'chip-selected font-medium' : 'chip-default hover:opacity-80'
              }`}
              title={t(m.desc)}
            >
              {t(m.label)}
            </button>
          ))}
          {mode === 'manual' && (
            <>
              <select
                className="input text-sm py-1 ml-2 w-auto"
                value={provider}
                onChange={e => setProvider(e.target.value)}
              >
                {(availableProviders.length > 0 ? availableProviders : PROVIDER_PRESETS.map(p => p.value)).map(p => {
                  const preset = PROVIDER_PRESETS.find(x => x.value === p);
                  return <option key={p} value={p}>{preset?.label || p}</option>;
                })}
              </select>
              {models.length > 0 ? (
                <select
                  className="input text-sm py-1 w-auto"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  disabled={modelsLoading}
                >
                  {modelsLoading && <option>{t('common.loading')}</option>}
                  {models.map(m => (
                    <option key={m.id} value={m.name}>
                      {m.displayName || m.name}{!m.enabled ? ` (${t('play.model.disabled')})` : ''}{m.activeKeys === 0 ? ` ⚠️ ${t('play.model.nokey')}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    className="input text-sm py-1 w-64 font-mono"
                    placeholder={modelsLoading ? t('common.loading') : t('play.model.input.placeholder')}
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    disabled={modelsLoading}
                  />
                  {!modelsLoading && (
                    <span className="text-xs text-text-muted">
                      {t('play.model.noseed')}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 选中模型的额度信息 */}
        {mode === 'manual' && selectedModel && (
          <div className="mt-2 text-xs text-text-muted flex flex-wrap gap-x-4">
            <span>{t('play.meta.platform')}: <span className="text-text-secondary">{selectedModel.platform}</span></span>
            {selectedModel.context && <span>{t('play.meta.context')}: <span className="text-text-secondary">{selectedModel.context.toLocaleString()} tokens</span></span>}
            {selectedModel.freeTier.rpm && <span>RPM: <span className="text-text-secondary">{selectedModel.freeTier.rpm}</span></span>}
            {selectedModel.freeTier.rpd && <span>RPD: <span className="text-text-secondary">{selectedModel.freeTier.rpd.toLocaleString()}</span></span>}
            {selectedModel.freeTier.tpm && <span>TPM: <span className="text-text-secondary">{selectedModel.freeTier.tpm.toLocaleString()}</span></span>}
            {selectedModel.freeTier.tpd && <span>TPD: <span className="text-text-secondary">{selectedModel.freeTier.tpd.toLocaleString()}</span></span>}
            {selectedModel.supportsTools && <span>{t('play.meta.tools')}</span>}
            {selectedModel.supportsVision && <span>{t('play.meta.vision')}</span>}
            <span className={selectedModel.activeKeys > 0 ? 'text-success' : 'text-warning'}>
              ● {t('play.meta.activekeys', { n: selectedModel.activeKeys })}
            </span>
          </div>
        )}

        {messages.some(m => m.error?.includes('Invalid API key') || m.error?.includes('Pass a Bearer')) && (
          <div className="mt-3 text-xs rounded p-2" style={{ backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--text-primary)' }}>
            <b>{t('play.warn.noToken.title')}</b>{t('play.warn.noToken.body')}
            <div className="mt-1 text-text-muted">{t('play.warn.noToken.hint')}</div>
          </div>
        )}

        {messages.some(m => m.error) && !messages.some(m => m.error?.includes('Invalid API key') || m.error?.includes('Pass a Bearer')) && (
          <div className="mt-3 text-xs rounded p-2" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
            {t('play.warn.upstream401')}
          </div>
        )}

        {!hasUnifiedToken && (
          <div className="mt-3 text-xs text-warning rounded p-2" style={{ backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}>
            {t('play.warn.noUnifiedToken')}
          </div>
        )}
      </div>

      {/* 对话区 */}
      <div className="card min-h-[360px] flex flex-col">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="text-text-muted text-sm mb-1">{t('play.empty.title')}</div>
            <div className="text-text-muted text-xs">
              {mode === 'auto' ? t('play.empty.autoHint') : t(ROUTING_MODES.find(m => m.id === mode)?.desc || '')}
            </div>
          </div>
        ) : (
          <div className="space-y-3 flex-1 overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-accent-primary text-on-accent'
                    : 'bg-bg-tertiary text-text-primary'
                }`}>
                  <div className="text-xs mb-0.5" style={{ color: m.role === 'user' ? 'var(--on-accent)' : 'var(--text-muted)' }}>{m.role === 'user' ? t('play.you') : t('play.assistant')}</div>
                  <div className="whitespace-pre-wrap break-words">{m.content || (busy ? '...' : '')}</div>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        )}
      </div>

      {/* 底部输入框 */}
      <div className="card">
        <div className="flex gap-2 items-end">
          <textarea
            className="input flex-1 text-sm resize-none"
            rows={2}
            placeholder={busy ? t('play.placeholder.busy') : t('play.placeholder')}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          {busy ? (
            <button className="btn-secondary" onClick={stop}>{t('play.btn.stop')}</button>
          ) : (
            <button className="btn-primary" onClick={send} disabled={!input.trim()}>
              {t('play.btn.send')}
            </button>
          )}
        </div>
        {usage && (
          <div className="text-xs text-text-muted mt-2">
            {usage.actualModel && <span>{t('play.usage.request')}: {usage.actualModel} · </span>}
            {usage.model && usage.model !== usage.actualModel && <span>{t('play.usage.actual')}: {usage.model} · </span>}
            {usage.platform && <span>{usage.platform} · </span>}
            {usage.latency && <span>{usage.latency}ms</span>}
          </div>
        )}
      </div>

      {err && (
        <pre className="text-xs text-danger whitespace-pre-wrap break-words rounded p-3 max-h-40 overflow-auto" style={{ backgroundColor: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          {err}
        </pre>
      )}
    </div>
  );
}
