/**
 * Portefeuille saisi à la main : libellés et formats (module pur, testable).
 */
import type { DcaPlanDto, HoldingKind, PeriodKey } from '@suiviinvest/api-contract';
import { formatMoney } from './format.ts';

export const HOLDING_KIND_LABELS: Readonly<Record<HoldingKind, string>> = {
  EQUITY: 'Action',
  ETF: 'ETF',
  FUND: 'Fonds',
  BOND: 'Obligation',
  CRYPTO: 'Crypto',
  OTHER: 'Autre',
};

export const FREQUENCY_LABELS: Readonly<Record<DcaPlanDto['frequency'], string>> = {
  WEEKLY: 'Chaque semaine',
  MONTHLY: 'Chaque mois',
  QUARTERLY: 'Chaque trimestre',
};

/** Périodes proposées sur les courbes de cours et de portefeuille. */
export const HOLDING_PERIODS: readonly PeriodKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'MAX'];

export const PLAN_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;

/**
 * Cours unitaire : assez de décimales pour une crypto à quelques centimes,
 * mais pas de bruit pour un titre à 600 €.
 */
export function formatPrice(value: number | null | undefined, currency = 'EUR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return formatMoney(value, currency, digits);
}

/** « 200 $ chaque mois, le 10 » */
export function describePlan(plan: Pick<DcaPlanDto, 'amount' | 'currency' | 'frequency' | 'dayOfMonth' | 'startDate'>): string {
  const amount = formatMoney(plan.amount, plan.currency, plan.amount % 1 === 0 ? 0 : 2);
  if (plan.frequency === 'WEEKLY') return `${amount} chaque semaine`;
  const day = plan.dayOfMonth === 1 ? '1er' : String(plan.dayOfMonth);
  return plan.frequency === 'QUARTERLY'
    ? `${amount} chaque trimestre, le ${day}`
    : `${amount} chaque mois, le ${day}`;
}

/** Initiales pour la pastille d'un actif (« NVDA » -> « NV », « Bitcoin » -> « BI »). */
export function assetBadge(symbol: string | null, name: string): string {
  const base = (symbol ?? name).replace(/[^A-Za-z0-9]/g, '');
  return (base.slice(0, 2) || '?').toUpperCase();
}

/** Date du jour au format AAAA-MM-JJ (fuseau local). */
export function todayIso(now: Date = new Date()): string {
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** Quantité lisible : 4 décimales au-delà d'une unité, 8 en dessous (cryptos). */
export function formatShares(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 1 ? 4 : 8;
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(value);
}
