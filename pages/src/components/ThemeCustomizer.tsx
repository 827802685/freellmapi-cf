import { useState, useEffect, useCallback } from 'react';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';

/**
 * Galaxy 主题定制器 — 高度可调色系
 *
 * 通过 data-accent / data-glow / data-glass / data-gradient 属性
 * 控制全局 CSS 变量,实现实时色系切换 + 效果强度控制。
 * 偏好持久化到 localStorage。
 *
 * 注意: 本组件是内联面板,不做 absolute 定位,由父容器控制位置。
 */

export type AccentColor = 'violet' | 'blue' | 'emerald' | 'rose' | 'amber' | 'cyan' | 'pink';

interface ThemePrefs {
  accent: AccentColor;
  glow: 0 | 1;
  glass: 0 | 1;
  gradient: 0 | 1;
}

const STORAGE_KEY = 'fl_galaxy_theme';

const DEFAULT_PREFS: ThemePrefs = {
  accent: 'violet',
  glow: 1,
  glass: 1,
  gradient: 1,
};

/** 色彩预设展示数据 — 名称 + 色板 */
const ACCENT_PRESETS: { id: AccentColor; swatch: string; gradient: string }[] = [
  { id: 'violet',  swatch: '#7c3aed', gradient: 'linear-gradient(135deg, #7c3aed, #a78bfa)' },
  { id: 'blue',    swatch: '#2563eb', gradient: 'linear-gradient(135deg, #2563eb, #60a5fa)' },
  { id: 'emerald', swatch: '#059669', gradient: 'linear-gradient(135deg, #059669, #34d399)' },
  { id: 'rose',    swatch: '#e11d48', gradient: 'linear-gradient(135deg, #e11d48, #fb7185)' },
  { id: 'amber',   swatch: '#d97706', gradient: 'linear-gradient(135deg, #d97706, #fbbf24)' },
  { id: 'cyan',    swatch: '#0891b2', gradient: 'linear-gradient(135deg, #0891b2, #22d3ee)' },
  { id: 'pink',    swatch: '#db2777', gradient: 'linear-gradient(135deg, #db2777, #f472b6)' },
];

/** 读取已保存的偏好 */
function loadPrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 应用偏好到 document root */
function applyPrefs(prefs: ThemePrefs) {
  const root = document.documentElement;
  root.setAttribute('data-accent', prefs.accent);
  root.setAttribute('data-glow', String(prefs.glow));
  root.setAttribute('data-glass', String(prefs.glass));
  root.setAttribute('data-gradient', String(prefs.gradient));
}

/** 保存偏好 */
function savePrefs(prefs: ThemePrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

/**
 * 初始化函数 — 在 App 挂载时调用一次。
 * 先从 localStorage 立即应用(防闪烁),再从后端获取全局主题(权威来源)。
 */
export async function initGalaxyTheme() {
  // 1. 立即从 localStorage 应用(避免等待网络时的闪烁)
  applyPrefs(loadPrefs());

  // 2. 从后端获取全局持久化主题(权威来源)
  try {
    const theme = await api.getTheme();
    const prefs: ThemePrefs = {
      accent: (theme.accent as AccentColor) || 'violet',
      glow: (theme.glow ?? 1) as 0 | 1,
      glass: (theme.glass ?? 1) as 0 | 1,
      gradient: (theme.gradient ?? 1) as 0 | 1,
    };
    applyPrefs(prefs);
    savePrefs(prefs); // 同步到 localStorage,保持一致
  } catch {
    // 后端不可用,保持 localStorage 版本
  }
}

export function ThemeCustomizer({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const [prefs, setPrefs] = useState<ThemePrefs>(() => loadPrefs());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // 偏好变化 → 应用 + 持久化(localStorage 即时生效)
  useEffect(() => {
    applyPrefs(prefs);
    savePrefs(prefs);
  }, [prefs]);

  const setAccent = useCallback((accent: AccentColor) => {
    setPrefs(prev => ({ ...prev, accent }));
    setSaveStatus('idle');
  }, []);

  const toggleEffect = useCallback((key: 'glow' | 'glass' | 'gradient') => {
    setPrefs(prev => ({ ...prev, [key]: prev[key] === 1 ? 0 : 1 }));
    setSaveStatus('idle');
  }, []);

  const reset = useCallback(() => {
    setPrefs(DEFAULT_PREFS);
    setSaveStatus('idle');
  }, []);

  // 确认 → 保存到后端 D1(全局持久化,所有页面 + landing page 共享)
  const confirmTheme = useCallback(async () => {
    setSaveStatus('saving');
    try {
      await api.setTheme(prefs);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [prefs]);

  return (
    <div className="p-3 galaxy-fade-in" style={{ minWidth: '260px' }}>
      {/* 标题 */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold gradient-text">{t('theme.customizer')}</h3>
        <button
          className="icon-btn"
          onClick={reset}
          title={t('theme.reset')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>

      {/* 强调色选择 */}
      <div className="mb-4">
        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
          {t('theme.accent')}
        </label>
        <div className="grid grid-cols-4 gap-2">
          {ACCENT_PRESETS.map(preset => (
            <button
              key={preset.id}
              onClick={() => setAccent(preset.id)}
              className="relative aspect-square rounded-lg transition-all"
              style={{
                background: preset.gradient,
                boxShadow: prefs.accent === preset.id
                  ? `0 0 0 2px var(--bg-primary), 0 0 0 4px ${preset.swatch}, 0 4px 12px ${preset.swatch}55`
                  : 'none',
                transform: prefs.accent === preset.id ? 'scale(1.08)' : 'scale(1)',
              }}
              title={t(`theme.accent.${preset.id}`)}
            >
              {prefs.accent === preset.id && (
                <span
                  className="absolute inset-0 flex items-center justify-center text-white"
                  style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 分隔线 */}
      <div className="galaxy-divider mb-3" />

      {/* 效果强度 */}
      <div>
        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
          {t('theme.effects')}
        </label>
        <div className="space-y-1">
          <EffectToggle
            label={t('theme.effects.glow')}
            on={prefs.glow === 1}
            onToggle={() => toggleEffect('glow')}
          />
          <EffectToggle
            label={t('theme.effects.glass')}
            on={prefs.glass === 1}
            onToggle={() => toggleEffect('glass')}
          />
          <EffectToggle
            label={t('theme.effects.gradient')}
            on={prefs.gradient === 1}
            onToggle={() => toggleEffect('gradient')}
          />
        </div>
      </div>

      {/* 分隔线 */}
      <div className="galaxy-divider mb-3" />

      {/* 确认按钮 — 保存到后端,全局永久应用 */}
      <button
        onClick={confirmTheme}
        disabled={saveStatus === 'saving'}
        className="w-full py-2.5 rounded-lg font-medium text-sm transition-all"
        style={{
          background: saveStatus === 'saving'
            ? 'var(--bg-tertiary)'
            : saveStatus === 'saved'
            ? 'var(--success)'
            : saveStatus === 'error'
            ? 'var(--danger)'
            : 'var(--accent-gradient)',
          color: saveStatus === 'saving' ? 'var(--text-muted)' : '#fff',
          boxShadow: saveStatus === 'saving' || saveStatus !== 'idle' ? 'none' : '0 4px 14px var(--accent-glow)',
          cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
          opacity: saveStatus === 'saving' ? 0.7 : 1,
        }}
      >
        {saveStatus === 'saving' && t('theme.saving')}
        {saveStatus === 'saved' && `✓ ${t('theme.saved')}`}
        {saveStatus === 'error' && t('theme.saveFailed')}
        {saveStatus === 'idle' && t('theme.confirm')}
      </button>
    </div>
  );
}

/** 效果开关行 */
function EffectToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <button
        onClick={onToggle}
        className={`galaxy-toggle ${on ? 'on' : ''}`}
        role="switch"
        aria-checked={on}
        title={on ? t('theme.effects.on') : t('theme.effects.off')}
      >
        <span className="knob" />
      </button>
    </div>
  );
}
