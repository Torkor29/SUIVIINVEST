import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionResponse } from '@suiviinvest/api-contract';
import { errorMessage, request, setCsrfToken } from './api.ts';

export interface AuthContextValue {
  readonly session: SessionResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly login: (password: string, username?: string | null) => Promise<void>;
  readonly setup: (input: SetupInput) => Promise<{ recoveryCode: string }>;
  readonly logout: () => Promise<void>;
}

export interface SetupInput {
  readonly password: string;
  readonly username?: string | null;
  readonly displayName?: string | null;
  readonly email?: string | null;
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

  const login = useCallback(async (password: string, username?: string | null) => {
    const result = await request<SessionResponse>('/api/auth/login', {
      method: 'POST',
      json: { password, ...(username ? { username } : {}) },
    });
    if (result.csrfToken !== null) setCsrfToken(result.csrfToken);
    setSession(result);
  }, []);

  /**
   * Création du premier compte.
   *
   * La session n'est PAS ouverte ici, volontairement : le code de récupération
   * n'est renvoyé qu'à cet instant et l'écran qui l'affiche doit rester visible.
   * C'est `refresh()` (au clic sur « Continuer ») qui ouvre la session — sans
   * quoi l'application basculerait sur le tableau de bord et le code serait
   * définitivement perdu.
   */
  const setup = useCallback(
    async (input: SetupInput): Promise<{ recoveryCode: string }> => {
      const result = await request<SessionResponse & { recoveryCode: string }>('/api/auth/setup', {
        method: 'POST',
        json: {
          password: input.password,
          ...(input.username ? { username: input.username } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.email ? { email: input.email } : {}),
        },
      });
      if (result.csrfToken !== null) setCsrfToken(result.csrfToken);
      return { recoveryCode: result.recoveryCode };
    },
    [],
  );

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
