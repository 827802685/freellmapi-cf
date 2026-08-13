import { useState, useEffect, useRef } from 'react';
import { t, setLang as setI18nLang, getLang, type Lang, useT } from '../lib/i18n';
import { ThemeCustomizer } from './ThemeCustomizer';
import {
  IconMoreHorizontal, IconPalette, IconSun, IconMoon, IconGlobe,
  IconChevronDown, IconChevronRight, IconCheck, IconClose, IconMonitor,
} from './Icons';

type Theme = 'dark' | 'light' | 'system';

export function TopMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'theme' | 'lang' | null>(null);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  const [lang, setLang] = useState<Lang>('zh');
  const [, force] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t0 = (localStorage.getItem('fl_theme') as Theme) || 'dark';
    const l = (getLang()) || 'zh';
    setTheme(t0);
    setLang(l);
    applyTheme(t0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const applyTheme = (t: Theme) => {
    const root = document.documentElement;
    if (t === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else if (t === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
      root.classList.toggle('light', !prefersDark);
    }
  };

  const pickTheme = (tt: Theme) => {
    setTheme(tt);
    localStorage.setItem('fl_theme', tt);
    applyTheme(tt);
    setSubmenu(null);
  };

  const pickLang = (l: Lang) => {
    setI18nLang(l);
    setLang(l);
    setSubmenu(null);
    force(x => x + 1);
    window.dispatchEvent(new Event('fl-lang-change'));
  };

  const openCustomizer = () => {
    setOpen(false);
    setSubmenu(null);
    setCustomizerOpen(true);
  };

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          className="p-1.5 rounded-lg transition-all hover:bg-bg-tertiary"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => { setOpen(v => !v); setSubmenu(null); }}
          title={t('menu.more')}
        >
          <IconMoreHorizontal size={20} />
        </button>

        {open && (
          <div
            className="absolute right-0 top-full mt-1 z-50 galaxy-fade-in"
            style={{
              minWidth: '200px',
              background: 'var(--glass-bg)',
              backdropFilter: 'blur(var(--glass-blur))',
              WebkitBackdropFilter: 'blur(var(--glass-blur))',
              border: '1px solid var(--glass-border)',
              borderRadius: '12px',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
            }}
          >
            {/* 主题定制器 — 点击打开独立浮层 */}
            <button
              className="w-full px-3 py-2.5 text-left text-sm transition-all flex items-center justify-between gap-2"
              style={{ color: 'var(--text-primary)' }}
              onClick={openCustomizer}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent-soft)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <span className="flex items-center gap-2.5">
                <IconPalette size={16} className="text-text-muted" />
                <span>{t('theme.customizer')}</span>
              </span>
              <IconChevronRight size={14} className="text-text-muted" />
            </button>

            <div className="galaxy-divider" />

            {/* 主题切换 */}
            <button
              className="w-full px-3 py-2.5 text-left text-sm transition-all flex items-center justify-between gap-2"
              style={{ color: 'var(--text-primary)' }}
              onClick={() => setSubmenu(submenu === 'theme' ? null : 'theme')}
              onMouseEnter={(e) => { if (submenu !== 'theme') e.currentTarget.style.background = 'var(--accent-soft)'; }}
              onMouseLeave={(e) => { if (submenu !== 'theme') e.currentTarget.style.background = 'transparent'; }}
            >
              <span className="flex items-center gap-2.5">
                {theme === 'light' ? <IconSun size={16} className="text-text-muted" /> : <IconMoon size={16} className="text-text-muted" />}
                <span>{t('menu.theme')}</span>
              </span>
              {submenu === 'theme'
                ? <IconChevronDown size={14} className="text-text-muted" />
                : <IconChevronRight size={14} className="text-text-muted" />}
            </button>
            {submenu === 'theme' && (
              <div className="px-1 pb-1">
                {(['light', 'dark', 'system'] as Theme[]).map(tt => (
                  <button
                    key={tt}
                    onClick={() => pickTheme(tt)}
                    className="w-full px-3 py-2 text-left text-sm rounded-lg transition-all flex items-center gap-2.5"
                    style={{ color: 'var(--text-primary)' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent-soft)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    {tt === 'light' && <IconSun size={14} className="text-text-muted" />}
                    {tt === 'dark' && <IconMoon size={14} className="text-text-muted" />}
                    {tt === 'system' && <IconMonitor size={14} className="text-text-muted" />}
                    <span>{t(`theme.${tt}`)}</span>
                    {theme === tt && <span className="ml-auto" style={{ color: 'var(--accent-primary)' }}><IconCheck size={14} /></span>}
                  </button>
                ))}
              </div>
            )}

            <div className="galaxy-divider" />

            {/* 语言切换 */}
            <button
              className="w-full px-3 py-2.5 text-left text-sm transition-all flex items-center justify-between gap-2"
              style={{
                color: 'var(--text-primary)',
                borderRadius: submenu === 'theme' ? '0' : '0 0 12px 12px',
              }}
              onClick={() => setSubmenu(submenu === 'lang' ? null : 'lang')}
              onMouseEnter={(e) => { if (submenu !== 'lang') e.currentTarget.style.background = 'var(--accent-soft)'; }}
              onMouseLeave={(e) => { if (submenu !== 'lang') e.currentTarget.style.background = 'transparent'; }}
            >
              <span className="flex items-center gap-2.5">
                <IconGlobe size={16} className="text-text-muted" />
                <span>{t('menu.lang')}</span>
              </span>
              {submenu === 'lang'
                ? <IconChevronDown size={14} className="text-text-muted" />
                : <IconChevronRight size={14} className="text-text-muted" />}
            </button>
            {submenu === 'lang' && (
              <div className="px-1 pb-1">
                {(['zh', 'en'] as Lang[]).map(l => (
                  <button
                    key={l}
                    onClick={() => pickLang(l)}
                    className="w-full px-3 py-2 text-left text-sm rounded-lg transition-all flex items-center justify-between"
                    style={{ color: 'var(--text-primary)' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent-soft)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <span>{l === 'zh' ? '中文 (简体)' : 'English'}</span>
                    {lang === l && <span style={{ color: 'var(--accent-primary)' }}><IconCheck size={14} /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 主题定制器 — 独立浮层(不嵌入下拉菜单,避免事件/溢出问题) */}
      {customizerOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-end pt-16 pr-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setCustomizerOpen(false)}
        >
          <div
            className="galaxy-fade-in"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--glass-border)',
              borderRadius: '16px',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
              maxWidth: '320px',
              width: '100%',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* 头部 */}
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur))',
                WebkitBackdropFilter: 'blur(var(--glass-blur))',
                borderBottom: '1px solid var(--glass-border)',
              }}
            >
              <h3 className="text-sm font-semibold gradient-text flex items-center gap-2">
                <IconPalette size={16} />
                {t('theme.customizer')}
              </h3>
              <button
                className="icon-btn icon-btn-sm"
                onClick={() => setCustomizerOpen(false)}
                title={t('common.close') || 'Close'}
              >
                <IconClose size={14} />
              </button>
            </div>
            {/* 面板内容 */}
            <div style={{ background: 'var(--bg-secondary)' }}>
              <ThemeCustomizer onClose={() => setCustomizerOpen(false)} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
