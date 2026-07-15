import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { api, setSessionToken } from '../lib/api';
import { useT } from '../lib/i18n';

export function SetupPage() {
  const t = useT();
  const { refresh } = useAuth();
  const [step, setStep] = useState<'code' | 'credentials'>('code');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (code.length < 4) {
      setError(t('setup.code.req'));
      return;
    }
    setStep('credentials');
  };

  const handleFinal = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError(t('setup.password.req'));
      return;
    }
    if (password !== confirm) {
      setError(t('setup.password.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.setup(code, email, password);
      if (r?.token) setSessionToken(r.token);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">freellmapi-cf</h1>
          <p className="text-text-secondary text-sm mt-1">{t('setup.title')}</p>
        </div>

        {step === 'code' ? (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">{t('setup.code')}</label>
              <input
                type="password"
                className="input"
                placeholder={t('setup.code.placeholder')}
                value={code}
                onChange={e => setCode(e.target.value)}
                autoFocus
                required
              />
              <p className="text-xs text-text-muted mt-1.5">
                {t('setup.code.hint')}
              </p>
            </div>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn-primary w-full">{t('setup.next')}</button>
          </form>
        ) : (
          <form onSubmit={handleFinal} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">{t('setup.email')}</label>
              <input
                type="email"
                className="input"
                placeholder="admin@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">{t('setup.password')}</label>
              <input
                type="password"
                className="input"
                placeholder={t('setup.password.placeholder')}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">{t('setup.confirm')}</label>
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error && <div className="text-sm text-danger">{error}</div>}
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setStep('code')}>
                {t('setup.prev')}
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={submitting}>
                {submitting ? t('setup.creating') : t('setup.create')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function LoginPage() {
  const t = useT();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const r = await api.login(email, password);
      // r.token 是 dashboard session(用来调 /api/*);统一 user token 要去密钥页创建
      if (r?.token) setSessionToken(r.token);
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">freellmapi-cf</h1>
          <p className="text-text-secondary text-sm mt-1">{t('login.title')}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">{t('login.email')}</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">{t('login.password')}</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <pre className="text-xs text-danger whitespace-pre-wrap break-words rounded p-2 max-h-48 overflow-auto" style={{ backgroundColor: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
            </pre>
          )}
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
