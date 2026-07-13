import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { api, setAuthToken } from '../lib/api';

export function SetupPage() {
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
      setError('请输入启动码');
      return;
    }
    setStep('credentials');
  };

  const handleFinal = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.setup(code, email, password);
      if (r?.token) setAuthToken(r.token);
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
          <p className="text-text-secondary text-sm mt-1">首次设置 - 创建管理员账号</p>
        </div>

        {step === 'code' ? (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">启动码</label>
              <input
                type="password"
                className="input"
                placeholder="wrangler secret 里的 ADMIN_BOOTSTRAP_CODE"
                value={code}
                onChange={e => setCode(e.target.value)}
                autoFocus
                required
              />
              <p className="text-xs text-text-muted mt-1.5">
                防止别人随便注册管理员。启动码在你部署时设置。
              </p>
            </div>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn-primary w-full">下一步</button>
          </form>
        ) : (
          <form onSubmit={handleFinal} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">邮箱</label>
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
              <label className="block text-sm font-medium mb-1.5">密码</label>
              <input
                type="password"
                className="input"
                placeholder="至少 8 位"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">确认密码</label>
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
                上一步
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={submitting}>
                {submitting ? '创建中...' : '创建账号'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function LoginPage() {
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
      if (r?.token) setAuthToken(r.token);
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
          <p className="text-text-secondary text-sm mt-1">登录管理面板</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">邮箱</label>
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
            <label className="block text-sm font-medium mb-1.5">密码</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="text-sm text-danger">{error}</div>}
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
