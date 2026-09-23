/** Palette catégorielle des graphiques (stable et lisible en clair comme en sombre). */
export const CATEGORY_COLORS: readonly string[] = [
  '#5b7cfa',
  '#1fbf8f',
  '#f5a524',
  '#9b6cf6',
  '#f2668b',
  '#38b6e8',
  '#9a9aa0',
  '#34c759',
  '#ff8a3d',
  '#7a82ff',
];

/** Couleur du poste selon son libellé (les grandes classes gardent une couleur fixe). */
const CLASS_COLORS: Readonly<Record<string, string>> = {
  'Actions-ETF': '#5b7cfa',
  'Actions / ETF': '#5b7cfa',
  Crypto: '#9b6cf6',
  Immobilier: '#1fbf8f',
  Cash: '#38b6e8',
  'Autres actifs': '#f5a524',
  Dettes: '#e5373f',
};

export const NEGATIVE_COLOR = '#e5373f';
export const POSITIVE_COLOR = '#00a86b';

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
