import { useCallback, useState } from 'react';
import { errorMessage } from './api.ts';

export interface ActionState {
  readonly pending: boolean;
  readonly error: string | null;
  readonly message: string | null;
  readonly run: (task: () => Promise<string | null>) => Promise<void>;
  readonly reset: () => void;
}

/** Exécute une action ponctuelle (synchronisation, import, export…) et expose son état. */
export function useAction(): ActionState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async (task: () => Promise<string | null>) => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await task();
      setMessage(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  return { pending, error, message, run, reset };
}
