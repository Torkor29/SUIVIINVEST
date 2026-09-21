import { useCallback, useEffect, useState } from 'react';
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, systemPrefersDark, type ResolvedTheme, type ThemeChoice } from './theme.ts';

export interface ThemeControls {
  readonly choice: ThemeChoice;
  readonly resolved: ResolvedTheme;
  readonly setChoice: (choice: ThemeChoice) => void;
  readonly toggle: () => void;
}

/** Hook de thème : applique et mémorise le choix, suit la préférence système. */
export function useTheme(): ThemeControls {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());
  const resolved = resolveTheme(choice, prefersDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next);
    setChoiceState(next);
  }, []);

  const toggle = useCallback(() => {
    const next: ThemeChoice = resolved === 'dark' ? 'light' : 'dark';
    storeTheme(next);
    setChoiceState(next);
  }, [resolved]);

  return { choice, resolved, setChoice, toggle };
}
