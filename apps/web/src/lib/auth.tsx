import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionResponse } from '@suiviinvest/api-contract';
import { errorMessage, request, setCsrfToken } from './api.ts';

export interface AuthContextValue {
  readonly session: SessionResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly login: (password: string) => Promise<void>;
  readonly setup: (password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Fournit la session (cookie) et le jeton CSRF à toute l'application. */
export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<SessionResponse>('/api/auth/session');
      setCsrfToken(result.csrfToken);
      setSession(result);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const login = useCallback(async (password: string) => {
    const result = await request<SessionResponse>('/api/auth/login', { method: 'POST', json: { password } });
    if (result.csrfToken !== null) setCsrfToken(result.csrfToken);
    setSession(result);
  }, []);

  const setup = useCallback(async (password: string) => {
    const result = await request<SessionResponse>('/api/auth/setup', { method: 'POST', json: { password } });
    if (result.csrfToken !== null) setCsrfToken(result.csrfToken);
    setSession(result);
  }, []);

  const logout = useCallback(async () => {
    try {
      await request<SessionResponse>('/api/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
      setSession(null);
      setError(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ session, loading, error, refresh: () => void load(), login, setup, logout }),
    [session, loading, error, load, login, setup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth doit être utilisé dans <AuthProvider>.');
  return context;
}
