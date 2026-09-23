/**
 * Formatage des montants, pourcentages et dates.
 * Module pur (aucun import React/DOM) : directement testable avec `node --test`.
 */

export type Tone = 'up' | 'down' | 'flat';

const LOCALE = 'fr-FR';

const MONTHS_FR = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
] as const;

const formatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(digits: number, style: 'decimal' | 'currency', currency: string): Intl.NumberFormat {
  const key = `${style}|${currency}|${digits}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  const created =
    style === 'currency'
      ? new Intl.NumberFormat(LOCALE, {
          style: 'currency',
          currency,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: digits });
  formatters.set(key, created);
  return created;
}

/** Nombre décimal localisé (fr-FR), `digits` chiffres maximum après la virgule. */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter(digits, 'decimal', 'EUR').format(value);
}

/** Nombre localisé à décimales fixes (utilisé pour les pourcentages). */
export function formatFixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Montant dans sa devise d'origine (code ISO 4217). */
export function formatMoney(value: number, currency = 'EUR', digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  try {
    return numberFormatter(digits, 'currency', currency).format(value);
  } catch {
    return `${formatNumber(value, digits)} ${currency}`;
  }
}

/** Montant en euros — devise d'affichage par défaut. */
export function formatEur(value: number, digits = 2): string {
  return formatMoney(value, 'EUR', digits);
}

/** Montant signé (les gains positifs portent un « + »). */
export function formatSignedEur(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatEur(value, digits)}`;
}

/** Unité compacte : Md / M / k / '' (utile pour les axes de graphiques). */
export function compactUnit(value: number): '' | 'k' | 'M' | 'Md' {
  const abs = Math.abs(value);
  if (abs >= 1e9) return 'Md';
  if (abs >= 1e6) return 'M';
  if (abs >= 1e3) return 'k';
  return '';
}

/** Montant compact en euros : « 1,2 M€ », « 486 k€ ». */
export function formatCompactEur(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const unit = compactUnit(value);
  const divisor = unit === 'Md' ? 1e9 : unit === 'M' ? 1e6 : unit === 'k' ? 1e3 : 1;
  const scaled = value / divisor;
  const digits = unit === '' ? 0 : Math.abs(scaled) < 10 ? 1 : 0;
  return `${numberFormatter(digits, 'decimal', 'EUR').format(scaled)}${unit ? ` ${unit}` : ''}€`;
}

export interface PercentOptions {
  readonly digits?: number;
  readonly sign?: boolean;
}

/** Pourcentage : la valeur est déjà exprimée en points de pourcentage (2.4 -> « +2,40 % »). */
export function formatPercent(value: number, options: PercentOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  const digits = options.digits ?? 2;
  const sign = options.sign === false ? '' : value > 0 ? '+' : '';
  return `${sign}${formatFixed(value, digits)} %`;
}

/** Tendance associée à une variation (pour la couleur des tuiles). */
export function toneOf(value: number, epsilon = 1e-9): Tone {
  if (value > epsilon) return 'up';
  if (value < -epsilon) return 'down';
  return 'flat';
}

/** Quantité d'instruments (0 à 8 décimales, sans zéros inutiles). */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 8 }).format(value);
}

/** Date ISO -> « 21 sept. 2026 » (court) ou « 21 septembre 2026 » (long). */
export function formatDate(iso: string | null | undefined, style: 'short' | 'long' = 'short'): string {
  const date = parseIsoDate(iso);
  if (date === null) return '—';
  const month = style === 'long' ? longMonth(date.getUTCMonth()) : MONTHS_FR[date.getUTCMonth()] ?? '';
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

function longMonth(index: number): string {
  const long = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ] as const;
  return long[index] ?? '';
}

/** Étiquette de mois courte : « 2026-09 » -> « sept. 26 ». */
export function formatMonthLabel(month: string, withYear = true): string {
  const parts = month.split('-');
  const year = parts[0] ?? '';
  const index = Number.parseInt(parts[1] ?? '1', 10) - 1;
  const label = MONTHS_FR[Number.isFinite(index) ? Math.min(Math.max(index, 0), 11) : 0] ?? '';
  return withYear ? `${label} ${year.slice(2)}` : label;
}

/** ISO -> Date (UTC), `null` si la valeur est inexploitable. */
export function parseIsoDate(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date -> « YYYY-MM-DD » (heure UTC). */
export function toIsoDay(date: Date): string {
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Date relative lisible : « à l’instant », « il y a 5 min », « il y a 3 h »,
 * « hier », puis la date courte au-delà d'une semaine.
 */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  const date = parseIsoDate(iso);
  if (date === null) return '—';
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return 'à l’instant';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  return `le ${formatDate(iso)}`;
}

/** Durée lisible : 950 -> « 950 ms », 65 000 -> « 1 min 5 s ». */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

/** Taux en pourcentage simple (0.042 -> « 4,20 % »). */
export function formatRate(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${formatFixed(ratio * 100, digits)} %`;
}

/** Disponibilité serveur : 486320 s -> « 5 j 15 h ». */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Adresse de portefeuille tronquée : 0x1234…abcd. */
export function shortenAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Montant en devise d'origine + contre-valeur EUR si la devise diffère. */
export function formatWithEur(value: number, currency: string, valueEur: number): string {
  const native = formatMoney(value, currency);
  if (currency.toUpperCase() === 'EUR') return native;
  return `${native} · ${formatEur(valueEur)}`;
}
