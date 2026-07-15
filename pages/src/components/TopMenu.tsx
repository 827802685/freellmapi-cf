import { useState, useEffect, useRef } from 'react';
import { t, setLang as setI18nLang, getLang, type Lang, useT } from '../lib/i18n';

type Theme = 'dark' | 'light' | 'system';

export function TopMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'theme' | 'lang' | null>(null);
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
    setOpen(false);
    setSubmenu(null);
  };

  const pickLang = (l: Lang) => {
    setI18nLang(l);
    setLang(l);
    setOpen(false);
    setSubmenu(null);
    force(x => x + 1);
    // 让其它组件也重渲染
    window.dispatchEvent(new Event('fl-lang-change'));
  };

  return (
    <div className="relative" ref={ref}>
      <button
        className="px-2 py-1.5 rounded hover:opacity-80 text-lg leading-none"
        onClick={() => { setOpen(v => !v); setSubmenu(null); }}
        title={t('menu.more')}
      >
        ⋯
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 min-w-[180px] card !p-1 shadow-xl"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="relative" onMouseEnter={() => setSubmenu('theme')}>
            <button className="w-full px-3 py-2 text-left text-sm hover:opacity-80 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span>{theme === 'light' ? '☀️' : '🌙'}</span>
                <span>{t('menu.theme')}</span>
              </span>
              <span>▸</span>
            </button>
            {submenu === 'theme' && (
              <div
                className="absolute right-full top-0 mr-1 min-w-[140px] card !p-1 shadow-xl"
                onMouseLeave={() => setSubmenu(null)}
                style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
              >
                {(['light', 'dark', 'system'] as Theme[]).map(tt => (
                  <button
                    key={tt}
                    onClick={() => pickTheme(tt)}
                    className="w-full px-3 py-1.5 text-left text-sm hover:opacity-80 flex items-center justify-between"
                  >
                    <span>{t(`theme.${tt}`)}</span>
                    {theme === tt && <span style={{ color: 'var(--accent-primary)' }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative" onMouseEnter={() => setSubmenu('lang')}>
            <button className="w-full px-3 py-2 text-left text-sm hover:opacity-80 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span>🌐</span>
                <span>{t('menu.lang')}</span>
              </span>
              <span>▸</span>
            </button>
            {submenu === 'lang' && (
              <div
                className="absolute right-full top-0 mr-1 min-w-[180px] card !p-1 shadow-xl"
                onMouseLeave={() => setSubmenu(null)}
                style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
              >
                {(['zh', 'en'] as Lang[]).map(l => (
                  <button
                    key={l}
                    onClick={() => pickLang(l)}
                    className="w-full px-3 py-1.5 text-left text-sm hover:opacity-80 flex items-center justify-between"
                  >
                    <span>{l === 'zh' ? '中文 (简体)' : 'English'}</span>
                    {lang === l && <span style={{ color: 'var(--accent-primary)' }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
