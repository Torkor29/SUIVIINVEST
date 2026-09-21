/** Thème clair/sombre : helpers purs + application sur <html data-theme>. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'suiviinvest:theme';

/** Résout le choix utilisateur en thème effectif selon la préférence système. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

export function readStoredTheme(): ThemeChoice {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function storeTheme(choice: ThemeChoice): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_STORAGE_KEY, choice);
}

/** Applique le thème résolu sur l'élément racine (attribut lu par la feuille de style). */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (root === null) return;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
