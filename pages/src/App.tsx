import { useState } from 'react';
import { useAuth } from './lib/auth';
import { KeysPage } from './pages/Keys';
import { TokensPage } from './pages/Tokens';
import { AnalyticsPage } from './pages/Analytics';
import { SetupPage, LoginPage } from './pages/Login';

export default function App() {
  const { state, refresh, logout } = useAuth();
  const [tab, setTab] = useState<'keys' | 'tokens' | 'analytics'>('keys');

  if (state.loading) {
    return <div className="min-h-screen flex items-center justify-center text-text-secondary">加载中...</div>;
  }

  if (state.firstRun) return <SetupPage />;
  if (!state.authenticated) return <LoginPage />;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border-subtle bg-bg-secondary">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold">freellmapi</span>
            <span className="badge-muted text-xs">CF Workers</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-secondary">{state.account?.email}</span>
            <button className="btn-ghost text-xs" onClick={logout}>登出</button>
          </div>
        </div>
        <nav className="max-w-6xl mx-auto px-6 flex gap-1">
          <TabButton active={tab === 'keys'} onClick={() => setTab('keys')}>🔑 API Keys</TabButton>
          <TabButton active={tab === 'tokens'} onClick={() => setTab('tokens')}>🎫 统一 Key</TabButton>
          <TabButton active={tab === 'analytics'} onClick={() => setTab('analytics')}>📊 Analytics</TabButton>
        </nav>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {tab === 'keys' && <KeysPage />}
        {tab === 'tokens' && <TokensPage />}
        {tab === 'analytics' && <AnalyticsPage />}
      </main>

      <footer className="border-t border-border-subtle bg-bg-secondary py-4">
        <div className="max-w-6xl mx-auto px-6 text-xs text-text-muted text-center">
          freellmapi-cf · 部署在 Cloudflare Workers · 你的 key 用 AES-256-GCM 加密存储
        </div>
      </footer>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-accent-primary text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}
