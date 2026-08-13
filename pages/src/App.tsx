import { useState, useEffect } from 'react';
import { useAuth } from './lib/auth';
import { KeysPage } from './pages/Keys';
import { AnalyticsPage } from './pages/Analytics';
import { AboutPage } from './pages/About';
import { SettingsPage } from './pages/Settings';
import { ModelsPage } from './pages/Models';
import { PlaygroundPage } from './pages/Playground';
import { SetupPage, LoginPage } from './pages/Login';
import { TopMenu } from './components/TopMenu';
import { initGalaxyTheme } from './components/ThemeCustomizer';
import { t, useT } from './lib/i18n';

// 版本号从后端 /api/about 运行时读取,唯一源头是 wrangler.toml 的 APP_VERSION
const API_ABOUT = '/api/about';

type Tab = 'models' | 'playground' | 'keys' | 'analytics' | 'settings' | 'about' | 'premium';

export default function App() {
  const t = useT();
  const { state, refresh, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('models');
  const [appVersion, setAppVersion] = useState('...');

  // 运行时从后端读取版本号(唯一源头: wrangler.toml APP_VERSION)
  useEffect(() => {
    fetch(API_ABOUT)
      .then((r) => r.json())
      .then((d) => setAppVersion(d.version || 'unknown'))
      .catch(() => setAppVersion('unknown'));
  }, []);

  // 初始化 Galaxy 主题偏好(色彩 + 效果强度)
  useEffect(() => {
    initGalaxyTheme();
  }, []);

  if (state.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="galaxy-spinner mx-auto mb-3" />
          <span className="text-text-secondary text-sm">{t('common.loading')}</span>
        </div>
      </div>
    );
  }
  if (state.firstRun) return <SetupPage />;
  if (!state.authenticated) return <LoginPage />;

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* 玻璃态顶栏 */}
      <header
        className="sticky top-0 z-40 border-b"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur))',
          WebkitBackdropFilter: 'blur(var(--glass-blur))',
        }}
      >
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full galaxy-pulse"
              style={{ background: 'var(--success)', boxShadow: '0 0 8px var(--success)' }}
            ></span>
            <span className="text-lg font-semibold gradient-text">{t('app.title')}</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>- {t('app.subtitle')}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm hidden sm:inline" style={{ color: 'var(--text-secondary)' }}>{state.account?.email}</span>
            <TopMenu />
            <button className="btn-ghost text-xs" onClick={logout}>{t('app.logout')}</button>
          </div>
        </div>
        {/* 导航标签 */}
        <nav className="max-w-6xl mx-auto px-6 flex gap-1 overflow-x-auto">
          <TabButton active={tab === 'models'} onClick={() => setTab('models')}>{t('nav.models')}</TabButton>
          <TabButton active={tab === 'playground'} onClick={() => setTab('playground')}>{t('nav.playground')}</TabButton>
          <TabButton active={tab === 'keys'} onClick={() => setTab('keys')}>{t('nav.keys')}</TabButton>
          <TabButton active={tab === 'analytics'} onClick={() => setTab('analytics')}>{t('nav.analytics')}</TabButton>
          <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>{t('nav.settings')}</TabButton>
          <TabButton active={tab === 'about'} onClick={() => setTab('about')}>{t('nav.about')}</TabButton>
          <TabButton active={tab === 'premium'} onClick={() => setTab('premium')}>{t('nav.premium')}</TabButton>
        </nav>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-6 galaxy-fade-in" key={tab}>
        {tab === 'models' && <ModelsPage />}
        {tab === 'playground' && <PlaygroundPage />}
        {tab === 'keys' && <KeysPage />}
        {tab === 'analytics' && <AnalyticsPage />}
        {tab === 'settings' && <SettingsPage />}
        {tab === 'about' && <AboutPage />}
        {tab === 'premium' && <PremiumPage />}
      </main>

      <footer
        className="border-t py-3"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur))',
          WebkitBackdropFilter: 'blur(var(--glass-blur))',
        }}
      >
        <div className="max-w-6xl mx-auto px-6 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
          {t('app.footer')}
          <span className="ml-2">· v{appVersion}</span>
        </div>
      </footer>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`galaxy-tab px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
        active ? 'active' : ''
      }`}
      style={{
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--text-primary)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'var(--text-secondary)'; }}
    >
      {children}
    </button>
  );
}

function PremiumPage() {
  const t = useT();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold gradient-text">{t('premium.title')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{t('premium.subtitle')}</p>
      </div>
      <div className="card-gradient-border text-center py-12">
        <div className="text-3xl mb-2 galaxy-pulse">✨</div>
        <h2 className="text-lg font-semibold mb-2">{t('premium.title')}</h2>
        <p className="text-sm max-w-md mx-auto" style={{ color: 'var(--text-secondary)' }}>{t('premium.body')}</p>
      </div>
    </div>
  );
}
