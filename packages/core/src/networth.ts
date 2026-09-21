import { round, variation } from './money.ts';
import type { NetWorthPoint, NetWorthSummary, WealthClass } from './types.ts';

/**
 * Patrimoine net : construction de la série historique et calcul des variations.
 *
 * Invariants :
 *  - les dettes entrent en NÉGATIF dans le total (`byClass.LIABILITIES <= 0`) ;
 *  - un point manquant n'est pas extrapolé : on prend le point connu le plus
 *    proche antérieur, ce qui est le comportement attendu d'une courbe de
 *    patrimoine (les valorisations ne bougent pas tous les jours).
 */

export const WEALTH_CLASSES: readonly WealthClass[] = [
  'EQUITIES',
  'CRYPTO',
  'REAL_ESTATE',
  'CASH',
  'OTHER_ASSETS',
  'LIABILITIES',
];

export type PeriodKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | '5Y' | 'MAX';

/** Nombre de jours couverts par chaque période (YTD et MAX sont calculés à part). */
export const PERIOD_DAYS: Readonly<Record<Exclude<PeriodKey, 'YTD' | 'MAX'>, number>> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 91,
  '1Y': 365,
  '5Y': 1826,
};

export function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Point connu le plus récent à une date donnée (ou avant). */
export function pointAt(points: readonly NetWorthPoint[], date: string): NetWorthPoint | null {
  let best: NetWorthPoint | null = null;
  for (const point of points) {
    if (point.date <= date && (!best || point.date > best.date)) best = point;
  }
  return best;
}

export function startOfPeriod(reference: string, period: PeriodKey, firstDate: string): string {
  switch (period) {
    case 'YTD':
      return `${reference.slice(0, 4)}-01-01`;
    case 'MAX':
      return firstDate;
    default:
      return addDays(reference, -PERIOD_DAYS[period]);
  }
}

export function emptyClassRecord(): Record<WealthClass, number> {
  return { EQUITIES: 0, CRYPTO: 0, REAL_ESTATE: 0, CASH: 0, OTHER_ASSETS: 0, LIABILITIES: 0 };
}

export function totalOf(byClass: Readonly<Record<WealthClass, number>>): number {
  return round(WEALTH_CLASSES.reduce((acc, key) => acc + (byClass[key] ?? 0), 0));
}

/** Répartition en pourcentage de la valeur absolue (les dettes comptent en positif ici). */
export function allocation(
  byClass: Readonly<Record<WealthClass, number>>,
): Record<WealthClass, number> {
  const absolute = WEALTH_CLASSES.map((key) => Math.abs(byClass[key] ?? 0));
  const total = absolute.reduce((acc, value) => acc + value, 0);
  const result = emptyClassRecord();
  if (total === 0) return result;
  WEALTH_CLASSES.forEach((key, index) => {
    result[key] = round(((absolute[index] as number) / total) * 100, 2);
  });
  return result;
}

export function buildSummary(points: readonly NetWorthPoint[], currency = 'EUR'): NetWorthSummary {
  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = ordered[ordered.length - 1] ?? null;
  const first = ordered[0] ?? null;

  if (!last) {
    return {
      asOf: new Date().toISOString().slice(0, 10),
      currency,
      total: 0,
      byClass: emptyClassRecord(),
      byProvider: {},
      variationToday: { absolute: 0, percent: 0 },
      variation1M: { absolute: 0, percent: 0 },
      variationYtd: { absolute: 0, percent: 0 },
      variation1Y: { absolute: 0, percent: 0 },
      variationAll: { absolute: 0, percent: 0 },
    };
  }

  const delta = (period: PeriodKey) => {
    const start = startOfPeriod(last.date, period, first?.date ?? last.date);
    const base = pointAt(ordered, start);
    const baseValue = base ? base.total : last.total;
    return variation(baseValue, last.total);
  };

  return {
    asOf: last.date,
    currency,
    total: last.total,
    byClass: { ...emptyClassRecord(), ...last.byClass },
    byProvider: { ...last.byProvider },
    variationToday: delta('1D'),
    variation1M: delta('1M'),
    variationYtd: delta('YTD'),
    variation1Y: delta('1Y'),
    variationAll: delta('MAX'),
  };
}

/** Série lissée pour un graphique : une valeur par jour, sans trou. */
export function densify(points: readonly NetWorthPoint[], from: string, to: string): NetWorthPoint[] {
  const ordered = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: NetWorthPoint[] = [];
  let cursor = from;
  while (cursor <= to) {
    const point = pointAt(ordered, cursor);
    if (point) {
      out.push({ ...point, date: cursor });
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Total d'un ensemble d'actifs/passifs, par classe et par établissement.
 * Retourne aussi les lignes non convertibles (taux de change indisponible) afin
 * que l'UI puisse afficher un avertissement au lieu d'un total silencieusement faux.
 */
export interface ClassTotalInput {
  readonly class: WealthClass;
  readonly providerId: string;
  readonly accountId: string;
  readonly valueBaseCurrency: number | null;
}

export interface ClassTotals {
  readonly byClass: Record<WealthClass, number>;
  readonly byProvider: Record<string, number>;
  readonly excluedBecauseNoFxRate: readonly { accountId: string; providerId: string }[];
}

export function aggregateClassTotals(items: readonly ClassTotalInput[]): ClassTotals {
  const byClass = emptyClassRecord();
  const byProvider: Record<string, number> = {};
  const excluded: { accountId: string; providerId: string }[] = [];

  for (const item of items) {
    if (item.valueBaseCurrency === null) {
      excluded.push({ accountId: item.accountId, providerId: item.providerId });
      continue;
    }
    byClass[item.class] = round((byClass[item.class] ?? 0) + item.valueBaseCurrency);
    byProvider[item.providerId] = round((byProvider[item.providerId] ?? 0) + item.valueBaseCurrency);
  }
  return { byClass, byProvider, excluedBecauseNoFxRate: excluded };
}