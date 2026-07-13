import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { api, setAuthToken, getAuthToken } from './api';

interface AuthState {
  loading: boolean;
  firstRun: boolean;
  authenticated: boolean;
  account: { accountId: number; email: string } | null;
}

const AuthContext = createContext<{
  state: AuthState;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
} | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    firstRun: false,
    authenticated: false,
    account: null,
  });

  const refresh = async () => {
    try {
      const status = await api.setupStatus();
      if (!status.firstRunCompleted) {
        setState({ loading: false, firstRun: true, authenticated: false, account: null });
        return;
      }
      const me = await api.me();
      setState({ loading: false, firstRun: false, authenticated: true, account: me.account });
    } catch {
      setState({ loading: false, firstRun: false, authenticated: false, account: null });
    }
  };

  const logout = async () => {
    try { await api.logout(); } catch {}
    setAuthToken(null);
    setState({ loading: false, firstRun: false, authenticated: false, account: null });
  };

  useEffect(() => { refresh(); }, []);

  return <AuthContext.Provider value={{ state, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
