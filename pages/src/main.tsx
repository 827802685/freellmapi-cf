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
    <div style="max-width:800px;margin:24px auto;padding:24px;font-family:system-ui,sans-serif;background:#1a1a24;color:#e5e5e7;border-radius:12px;border:1px solid #ef4444">
      <h2 style="color:#ef4444;margin:0 0 12px">${t('fatal.title')}</h2>
      <p style="color:#a0a0aa;margin:0 0 12px">${t('fatal.hint')}</p>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#0a0a0f;padding:12px;border-radius:8px;font-size:12px;color:#e5e5e7">${msg.replace(/</g, '&lt;')}</pre>
      <p style="color:#6b6b78;font-size:12px;margin-top:12px">API base: <code>${apiBase}</code></p>
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
