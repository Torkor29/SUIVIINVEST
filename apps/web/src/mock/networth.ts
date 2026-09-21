/** Série historique de patrimoine net (maquette), calée sur le total courant. */
import type { SeriesPoint } from '@suiviinvest/api-contract';
import { buildAccounts, accountValueEur } from './accounts.ts';
import { buildProperties } from './realestate.ts';
import { mulberry32, round2, seedFrom } from './random.ts';
import { toIsoDay } from '../lib/format.ts';

/** Actifs bruts : comptes d'investissement et de trésorerie + biens immobiliers. */
export function grossAssetsEur(now: Date = new Date()): number {
  const accountsTotal = buildAccounts(now).reduce((sum, account) => sum + (accountValueEur(account) ?? 0), 0);
  const propertiesTotal = buildProperties(now).reduce((sum, property) => sum + property.currentValue, 0);
  return round2(accountsTotal + propertiesTotal);
}

/** Dettes : capital restant dû sur les crédits immobiliers. */
export function debtsEur(now: Date = new Date()): number {
  return round2(buildProperties(now).reduce((sum, property) => sum + property.metrics.loanBalance, 0));
}

/** Patrimoine net courant (actifs − dettes). */
export function currentNetWorthEur(now: Date = new Date()): number {
  return round2(grossAssetsEur(now) - debtsEur());
}

const SERIES_START = '2019-01-01';

/**
 * Série quotidienne depuis 2019, déterministe, dont la dernière valeur vaut
 * exactement le patrimoine net courant : la maquette reste cohérente.
 */
export function buildNetWorthSeries(now: Date = new Date()): SeriesPoint[] {
  const target = currentNetWorthEur(now);
  const start = new Date(`${SERIES_START}T00:00:00Z`);
  const days = Math.max(Math.round((now.getTime() - start.getTime()) / 86_400_000), 1);
  const rng = mulberry32(seedFrom('suiviinvest-networth'));
  const shaped: number[] = [];
  const initial = target * 0.54;
  const monthlyContribution = (target - initial) / Math.max(days / 30, 1);
  let value = initial;
  for (let index = 0; index <= days; index += 1) {
    const seasonal = Math.sin(index / 97) * target * 0.006 + Math.sin(index / 411) * target * 0.012;
    const shock = (rng() - 0.5) * target * 0.0022;
    value = value + monthlyContribution + seasonal * 0.02 + shock;
    shaped.push(value);
  }
  const scale = shaped[shaped.length - 1] === undefined || shaped[shaped.length - 1] === 0 ? 1 : target / (shaped[shaped.length - 1] ?? 1);
  return shaped.map((raw, index) => {
    const date = new Date(start.getTime() + index * 86_400_000);
    return { date: toIsoDay(date), total: round2(Math.max(raw * scale, 0)) };
  });
}

/** Dernière date de la série (aujourd'hui). */
export function seriesAsOf(now: Date = new Date()): string {
  return toIsoDay(now);
}
