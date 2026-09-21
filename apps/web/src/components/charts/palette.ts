/** Palette catégorielle des graphiques (stable et lisible en clair comme en sombre). */
export const CATEGORY_COLORS: readonly string[] = [
  '#4f7cff',
  '#22b8a0',
  '#f2a93b',
  '#a855f7',
  '#ef5da8',
  '#38bdf8',
  '#94a3b8',
  '#10b981',
  '#f97316',
  '#6366f1',
];

/** Couleur du poste selon son libellé (les grandes classes gardent une couleur fixe). */
const CLASS_COLORS: Readonly<Record<string, string>> = {
  'Actions-ETF': '#4f7cff',
  Crypto: '#a855f7',
  Immobilier: '#22b8a0',
  Cash: '#38bdf8',
  'Autres actifs': '#f2a93b',
  Dettes: '#ef4444',
};

export const NEGATIVE_COLOR = '#ef4444';
export const POSITIVE_COLOR = '#22b8a0';

export function sliceColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length] ?? '#94a3b8';
}

export function classColor(label: string): string {
  return CLASS_COLORS[label] ?? CATEGORY_COLORS[0] ?? '#4f7cff';
}

/** Couleur d'une série positive/négative (barres de flux de trésorerie). */
export function signColor(value: number): string {
  return value < 0 ? NEGATIVE_COLOR : POSITIVE_COLOR;
}
