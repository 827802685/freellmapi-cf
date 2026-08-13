import { useEffect, useRef, useState } from 'react';
import { api, setAuthToken } from '../lib/api';
import { useT } from '../lib/i18n';
import { IconSync, IconClock, IconEraser, IconImage, IconBrain, IconClose, IconEye } from '../components/Icons';

const TOKEN_HINT = (() => {
  if (typeof localStorage === 'undefined') return false;
  return !!localStorage.getItem('fl_token');
})();

type RoutingMode = 'auto' | 'fastest' | 'manual';
// label / desc 存放 i18n key,渲染时用 t() 翻译
const ROUTING_MODES: { id: RoutingMode; label: string; desc: string }[] = [
  { id: 'auto', label: 'mode.auto', desc: 'mode.desc.auto' },
  { id: 'fastest', label: 'mode.fastest', desc: 'mode.desc.fastest' },
  { id: 'manual', label: 'mode.manual', desc: 'mode.desc.manual' },
];

// 推理强度选项
type ReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high';
const REASONING_EFFORTS: { id: ReasoningEffort; label: string }[] = [
  { id: 'auto', label: '推理: 自动' },
  { id: 'minimal', label: '推理: 关闭' },
  { id: 'low', label: '推理: 低' },
  { id: 'medium', label: '推理: 中' },
  { id: 'high', label: '推理: 高' },
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

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  error?: string;
  reasoning?: string;
  images?: string[]; // data URL 数组,用户上传的图片
}

// ---- 聊天记录本地持久化 ----
const CHAT_STORAGE_KEY = 'fl_playground_chat';
const MODE_STORAGE_KEY = 'fl_playground_mode';
const REASONING_STORAGE_KEY = 'fl_playground_reasoning';
const MAX_TOKENS_STORAGE_KEY = 'fl_playground_max_tokens';

function loadMessages(): Msg[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveMessages(msgs: Msg[]) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(msgs));
  } catch {
    // 超限(图片 data URL 太大):去掉图片只存文本
    try {
      const stripped = msgs.map(m => ({ ...m, images: undefined }));
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(stripped));
    } catch {
      try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* ignore */ }
    }
  }
}

export function PlaygroundPage() {
  const t = useT();
  const [mode, setMode] = useState<RoutingMode>(() => {
    try { return (localStorage.getItem(MODE_STORAGE_KEY) as RoutingMode) || 'auto'; } catch { return 'auto'; }
  });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    try { return (localStorage.getItem(REASONING_STORAGE_KEY) as ReasoningEffort) || 'auto'; } catch { return 'auto'; }
  });
  const [provider, setProvider] = useState<string>('groq');
  const [availableProviders, setAvailableProviders] = useState<{ platform: string; label: string }[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<string>('');
  const [stream] = useState(true);
  const [maxTokens, setMaxTokens] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(MAX_TOKENS_STORAGE_KEY) || '') || 8192; } catch { return 8192; }
  });
  const [messages, setMessages] = useState<Msg[]>(() => loadMessages());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]); // 待发送的图片 data URL
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [usage, setUsage] = useState<{ latency?: number; platform?: string; model?: string; actualModel?: string } | null>(null);
  const [abort, setAbort] = useState<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // 聊天记录 & 用户偏好自动持久化到 localStorage
  useEffect(() => { saveMessages(messages); }, [messages]);
  useEffect(() => { try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* ignore */ } }, [mode]);
  useEffect(() => { try { localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort); } catch { /* ignore */ } }, [reasoningEffort]);
  useEffect(() => { try { localStorage.setItem(MAX_TOKENS_STORAGE_KEY, String(maxTokens)); } catch { /* ignore */ } }, [maxTokens]);

  // 加载提供商列表:从后端 /api/settings/providers 获取(跟随设置页面的增删同步)
  // 优先显示有 key 的平台,然后是其他启用的平台
  const [providersInitialized, setProvidersInitialized] = useState(false);
  useEffect(() => {
    if (providersInitialized) return;
    Promise.all([
      api.getProviders().catch(() => ({ platforms: [] })),
      api.listKeys().catch(() => ({ keys: [] })),
    ]).then(([providerRes, keyRes]: [any, any]) => {
      const platforms: Array<{ platform: string; label: string; enabled: number; keyInfo?: { total: number; enabled: number } }> = providerRes.platforms || [];
      const keys: any[] = keyRes.keys || [];
      const keyPlatforms = new Set(keys.map((k: any) => k.platform));

      // 过滤:只保留 enabled 的平台(设置里删除的不会出现)
      const active = platforms.filter(p => p.enabled !== 0);
      // 排序:有 key 的排前面,然后按字母序
      active.sort((a, b) => {
        const aHasKey = keyPlatforms.has(a.platform) ? 0 : 1;
        const bHasKey = keyPlatforms.has(b.platform) ? 0 : 1;
        if (aHasKey !== bHasKey) return aHasKey - bHasKey;
        return a.platform.localeCompare(b.platform);
      });

      const ordered = active.map(p => ({ platform: p.platform, label: p.label || p.platform }));
      setAvailableProviders(ordered);
      const platformIds = ordered.map(o => o.platform);
      if (platformIds.length > 0 && !platformIds.includes(provider)) {
        setProvider(platformIds[0]); // 当前选的 provider 不在列表里,切到第一个
      }
      setProvidersInitialized(true);
    }).catch(() => {
      setProvidersInitialized(true);
    });
  }, [providersInitialized]);

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

  // 图片处理:File → data URL
  const fileToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // 压缩图片(避免超大 base64 爆 Workers 请求体限制)
  const compressImage = async (dataUrl: string, maxDim = 1024, quality = 0.85): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl); // 压缩失败用原图
      img.src = dataUrl;
    });
  };

  // 处理文件选择
  const handleFiles = async (files: File[] | FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    const imageFiles = fileArray.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const dataUrls = await Promise.all(
      imageFiles.map(async f => compressImage(await fileToDataUrl(f)))
    );
    setPendingImages(prev => [...prev, ...dataUrls]);
  };

  // 粘贴图片
  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    imageItems.forEach(item => {
      const file = item.getAsFile();
      if (file) handleFiles([file]);
    });
  };

  // 拖拽图片
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer?.files || null);
  };

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };

  // 移除待发送图片
  const removeImage = (idx: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== idx));
  };

  const clearChat = () => {
    setMessages([]);
    setErr('');
    setUsage(null);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* ignore */ }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || busy) return;
    setBusy(true);
    setErr('');
    setUsage(null);

    // 构造消息(如有图片,用 OpenAI 多模态 content 格式)
    const images = [...pendingImages];
    const userMsg: Msg = { role: 'user', content: text || '请描述这张图片', images: images.length > 0 ? images : undefined };
    const newMsgs: Msg[] = [...messages, userMsg];
    setMessages(newMsgs);
    setInput('');
    setPendingImages([]);

    // 构造 OpenAI 格式的 messages(把图片转成 content 数组)
    const openaiMessages = newMsgs.map(m => {
      if (m.images && m.images.length > 0) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          content.push({ type: 'image_url', image_url: { url: img } });
        }
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    const ac = new AbortController();
    setAbort(ac);
    const API_BASE = (import.meta.env.VITE_API_BASE as string) || '';
    const FULL_URL = API_BASE + '/v1/chat/completions';
    try {
      const token = localStorage.getItem('fl_token');
      // 手动模式发送用户选择的 model,其他模式让后端自动选
      const requestModel = mode === 'manual' ? model : 'auto';
      console.log('[freellmapi] request URL:', FULL_URL, 'token:', token ? token.slice(0, 20) + '...' : 'NONE', 'mode:', mode, 'model:', requestModel);
      const r = await fetch(FULL_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Route-Mode': mode, // 传递路由策略给后端
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model: requestModel,
          stream,
          max_tokens: maxTokens,
          messages: openaiMessages,
          ...(reasoningEffort !== 'auto' ? { reasoning_effort: reasoningEffort } : {}),
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const latency = Math.max(0, parseInt(r.headers.get('X-Latency') || r.headers.get('X-Latency-Ms') || '0') || 0) || undefined;
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
                const reasoningDelta = j.choices?.[0]?.delta?.reasoning_content || '';
                if (delta || reasoningDelta) {
                  setMessages(m => {
                    const last = m[m.length - 1];
                    if (last?.role === 'assistant') {
                      return [...m.slice(0, -1), {
                        ...last,
                        content: last.content + delta,
                        reasoning: (last.reasoning || '') + reasoningDelta,
                      }];
                    }
                    return m;
                  });
                }
              } catch (e) {
                console.warn('[SSE parse fail]', data?.slice(0, 200), e);
              }
            }
          }
        }
        setUsage({ latency, platform, model: usedModel, actualModel: requestModel });
      } else {
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content || JSON.stringify(j);
        const reasoning = j.choices?.[0]?.message?.reasoning_content || '';
        setMessages(m => [...m, { role: 'assistant', content: text, reasoning: reasoning || undefined }]);
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

  // 同步模型(触发后端更新 vision/tools 标记 + 拉取最新模型列表)
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const syncModels = async () => {
    const token = localStorage.getItem('fl_token');
    if (!token) return;
    setSyncing(true);
    setSyncResult('');
    try {
      const API_BASE = (import.meta.env.VITE_API_BASE as string) || '';
      const r = await fetch(API_BASE + '/__update-model-flags', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const j = await r.json();
      if (j.ok) {
        setSyncResult(`✓ 同步完成: ${j.totalModels} 模型, ${j.flagsUpdated} 更新, ${j.visionModels} 个 vision 模型`);
        // 刷新模型列表
        if (mode === 'manual') {
          api.listModels(provider).then(jj => {
            const list: ModelInfo[] = (jj.models || []).map((m: any) => ({
              id: m.id, name: m.model_name || m.name, displayName: m.display_name || m.displayName,
              platform: m.platform, family: m.family, context: m.context_window || m.context,
              enabled: m.enabled === 1 || m.enabled === true,
              supportsTools: m.supports_tools === 1 || m.supportsTools === true,
              supportsVision: m.supports_vision === 1 || m.supportsVision === true,
              freeTier: m.freeTier || { rpm: m.free_tier_rpm, rpd: m.free_tier_rpd, tpm: m.free_tier_tpm, tpd: m.free_tier_tpd },
              activeKeys: m.activeKeys || 0,
            }));
            setModels(list);
          });
        }
      } else {
        setSyncResult('✗ 同步失败: ' + (j.error || 'unknown'));
      }
    } catch (e: any) {
      setSyncResult('✗ 同步失败: ' + e.message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(''), 8000);
    }
  };

  return (
    <div className="space-y-4 galaxy-fade-in">
      {/* 顶部一行:路由策略 + 推理强度 + (手动模式时)provider + 模型下拉 */}
      <div className="card-gradient-border">
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

          {/* 推理强度选择器 + 最大 token 数 + 模型同步 */}
          <div className="ml-auto flex items-center gap-1">
            <select
              className="input text-sm py-1.5 px-2"
              value={maxTokens}
              onChange={e => setMaxTokens(parseInt(e.target.value))}
              title="最大输出 token 数 (max_tokens)"
            >
              <option value={2048}>2048 tokens</option>
              <option value={4096}>4096 tokens</option>
              <option value={8192}>8192 tokens</option>
              <option value={16384}>16384 tokens</option>
              <option value={32768}>32768 tokens</option>
              <option value={65536}>65536 tokens</option>
            </select>
            <select
              className="input text-sm py-1.5 px-2"
              value={reasoningEffort}
              onChange={e => setReasoningEffort(e.target.value as ReasoningEffort)}
              title="推理模式 (reasoning_effort)"
            >
              {REASONING_EFFORTS.map(r => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            <button
              className="btn-secondary px-2 py-1.5 text-xs flex items-center justify-center"
              onClick={syncModels}
              disabled={syncing}
              title="同步模型列表(更新 vision/tools 标记)"
            >{syncing ? <IconClock size={14} /> : <IconSync size={14} />}</button>
          </div>
        </div>

        {/* 同步结果提示 */}
        {syncResult && (
          <div className="mt-2 text-xs rounded p-2" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            {syncResult}
          </div>
        )}

        {/* 手动模式:显示 provider + model 选择器 */}
        {mode === 'manual' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              className="input text-sm py-1.5 px-2"
              value={provider}
              onChange={e => setProvider(e.target.value)}
              disabled={modelsLoading}
            >
              {availableProviders.map(p => (
                <option key={p.platform} value={p.platform}>{p.label}</option>
              ))}
            </select>
            <select
              className="input text-sm py-1.5 px-2 flex-1 min-w-[200px]"
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={modelsLoading || models.length === 0}
            >
              {modelsLoading && <option>加载中...</option>}
              {!modelsLoading && models.length === 0 && <option value="">无可用模型</option>}
              {models.map(m => (
                <option key={m.id} value={m.name}>
                  {m.displayName || m.name}{m.supportsVision ? ' [V]' : ''}{m.context ? ` (${m.context >= 1000 ? `${(m.context / 1000).toFixed(0)}K` : m.context} ctx)` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {messages.some(m => m.error?.includes('Invalid API key') || m.error?.includes('Pass a Bearer')) && (
          <div className="mt-3 text-xs rounded p-2 alert-warning" style={{ color: 'var(--text-primary)' }}>
            <b>{t('play.warn.noToken.title')}</b>{t('play.warn.noToken.body')}
            <div className="mt-1 text-text-muted">{t('play.warn.noToken.hint')}</div>
          </div>
        )}

        {messages.some(m => m.error) && !messages.some(m => m.error?.includes('Invalid API key') || m.error?.includes('Pass a Bearer')) && (
          <div className="mt-3 text-xs rounded p-2 alert-danger">
            {t('play.warn.upstream401')}
          </div>
        )}

        {!hasUnifiedToken && (
          <div className="mt-3 text-xs text-text-primary rounded p-2 alert-warning">
            {t('play.warn.noUnifiedToken')}
          </div>
        )}
      </div>

      {/* 对话区 */}
      <div className="card min-h-[360px] flex flex-col transition-all">
        {/* 对话区头部:清空按钮 */}
        {messages.length > 0 && (
          <div className="flex justify-end mb-2">
            <button
              onClick={clearChat}
              className="text-xs px-2 py-1 rounded transition-all flex items-center gap-1.5 hover:opacity-70"
              style={{ color: 'var(--text-muted)' }}
              title="清空聊天记录"
            >
              <IconEraser size={14} />
              {t('play.clear') || '清空'}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="text-text-muted text-sm mb-1 galaxy-pulse">{t('play.empty.title')}</div>
            <div className="text-text-muted text-xs">
              {mode === 'auto' ? t('play.empty.autoHint') : t(ROUTING_MODES.find(m => m.id === mode)?.desc || '')}
            </div>
          </div>
        ) : (
          <div className="space-y-3 flex-1 overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'text-on-accent'
                      : 'bg-bg-tertiary text-text-primary'
                  }`}
                  style={m.role === 'user' ? { background: 'var(--accent-gradient)', boxShadow: '0 2px 8px var(--accent-glow)' } : undefined}
                >
                  <div className="text-xs mb-0.5" style={{ color: m.role === 'user' ? 'var(--on-accent)' : 'var(--text-muted)' }}>{m.role === 'user' ? t('play.you') : t('play.assistant')}</div>
                  {/* 用户消息中的图片 */}
                  {m.images && m.images.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {m.images.map((img, idx) => (
                        <img key={idx} src={img} alt={`图片${idx+1}`} className="max-w-[200px] max-h-[200px] rounded-lg object-cover" />
                      ))}
                    </div>
                  )}
                  {/* 推理内容(可折叠) */}
                  {m.reasoning && (
                    <details className="mb-1.5 text-xs opacity-70">
                      <summary className="cursor-pointer select-none flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <IconBrain size={14} />
                        推理过程
                      </summary>
                      <div className="mt-1 p-2 rounded whitespace-pre-wrap break-words opacity-80" style={{ background: 'var(--bg-secondary)' }}>{m.reasoning}</div>
                    </details>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.content || (busy ? '...' : '')}</div>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        )}
      </div>

      {/* 底部输入框 */}
      <div className="card-gradient-border" onDrop={onDrop} onDragOver={onDragOver}>
        {/* 待发送图片预览 */}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingImages.map((img, idx) => (
              <div key={idx} className="relative group">
                <img src={img} alt="待发送" className="w-20 h-20 object-cover rounded-lg border" />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="移除"
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          {/* 图片上传按钮 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            className="btn-secondary px-3 py-2 text-sm flex items-center justify-center"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="上传图片 (支持粘贴/拖拽)"
          >
            <IconImage size={18} />
          </button>
          <textarea
            className="input flex-1 text-sm resize-none"
            rows={2}
            placeholder={busy ? t('play.placeholder.busy') : (pendingImages.length > 0 ? '描述图片或直接发送...' : t('play.placeholder'))}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={busy}
          />
          {busy ? (
            <button className="btn-secondary" onClick={stop}>{t('play.btn.stop')}</button>
          ) : (
            <button className="btn-primary" onClick={send} disabled={!input.trim() && pendingImages.length === 0}>
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
        <pre className="text-xs text-danger whitespace-pre-wrap break-words rounded p-3 max-h-40 overflow-auto alert-danger">
          {err}
        </pre>
      )}
    </div>
  );
}
