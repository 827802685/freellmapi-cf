import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import Root from './Root';
import { t } from './lib/i18n';
import './index.css';

// 全局错误兜底 — 出现任何未捕获错误都显示在页面上
function showFatal(err: unknown) {
  const root = document.getElementById('root');
  if (!root) return;
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n\n${err.stack || ''}` : String(err);
  const apiBase =
    (import.meta.env.VITE_API_BASE as string | undefined) || '(empty / same-origin)';
  root.innerHTML = `
    <div style="max-width:800px;margin:24px auto;padding:24px;font-family:system-ui,sans-serif;background:var(--bg-secondary,#f5f5f7);color:var(--text-primary,#09090b);border-radius:12px;border:1px solid var(--danger,#ef4444)">
      <h2 style="color:var(--danger,#ef4444);margin:0 0 12px">${t('fatal.title')}</h2>
      <p style="color:var(--text-secondary,#3f3f46);margin:0 0 12px">${t('fatal.hint')}</p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:var(--bg-tertiary,#e8e8ec);padding:12px;border-radius:8px;font-size:12px;color:var(--text-primary,#09090b)">${msg.replace(/</g, '&lt;')}</pre>
      <p style="color:var(--text-muted,#52525b);font-size:12px;margin-top:12px">API base: <code>${apiBase}</code></p>
    </div>
  `;
}

window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </React.StrictMode>
  );
} catch (e) {
  showFatal(e);
}
