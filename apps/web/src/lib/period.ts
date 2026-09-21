/**
 * Fenêtres temporelles du sélecteur de période (1D → MAX) et calculs de variation.
 * Module pur, sans dépendance DOM.
 */
import type { PeriodKey, SeriesPoint, VariationDto } from '@suiviinvest/api-contract';
import { parseIsoDate, toIsoDay } from './format.ts';

export const PERIOD_KEYS: readonly PeriodKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'MAX'];

export const PERIOD_LABELS: Readonly<Record<PeriodKey, string>> = {
  '1D': "Aujourd'hui",
  '1W': '1 semaine',
  '1M': '1 mois',
  '3M': '3 mois',
  YTD: 'Depuis janvier',
  '1Y': '1 an',
  '5Y': '5 ans',
  MAX: 'Depuis l’origine',
};

export const PERIOD_SHORT_LABELS: Readonly<Record<PeriodKey, string>> = {
  '1D': '1 J',
  '1W': '1 S',
  '1M': '1 M',
  '3M': '3 M',
  YTD: 'YTD',
  '1Y': '1 A',
  '5Y': '5 A',
  MAX: 'MAX',
};

/** Nombre de jours couverts par la période (`null` = depuis l'origine). */
export function periodToDays(period: PeriodKey): number | null {
  switch (period) {
    case '1D':
      return 1;
    case '1W':
      return 7;
    case '1M':
      return 31;
    case '3M':
      return 92;
    case 'YTD':
      return null;
    case '1Y':
      return 365;
    case '5Y':
      return 365 * 5;
    case 'MAX':
      return null;
    default:
      return 365;
  }
}

/** Début de fenêtre, `null` quand la période remonte à l'origine. */
export function periodStart(period: PeriodKey, now: Date): Date | null {
  if (period === 'MAX') return null;
  if (period === 'YTD') return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = periodToDays(period);
  if (days === null) return null;
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - days);
  return start;
}

/** Ne conserve que les points de la série couverts par la période. */
export function filterSeriesByPeriod<T extends { readonly date: string }>(
  series: readonly T[],
  period: PeriodKey,
  now: Date,
): readonly T[] {
  const start = periodStart(period, now);
  if (start === null) return series;
  const startIso = toIsoDay(start);
  return series.filter((point) => (point.date.length <= 10 ? point.date : toIsoDay(parseIsoDate(point.date) ?? start)) >= startIso);
}

/** Variation entre deux valeurs (protégée contre la division par zéro). */
export function buildVariation(current: number, previous: number | undefined | null): VariationDto {
  if (previous === undefined || previous === null || !Number.isFinite(previous)) {
    return { absolute: 0, percent: 0 };
  }
  const absolute = current - previous;
  const percent = previous === 0 ? 0 : (absolute / Math.abs(previous)) * 100;
  return { absolute, percent };
}

/** Variation entre le premier et le dernier point d'une série. */
export function seriesVariation(series: readonly SeriesPoint[]): VariationDto {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined) return { absolute: 0, percent: 0 };
  return buildVariation(last.total, first.total);
}

/** Valeur d'un point à une date donnée (ou la plus proche antérieure). */
export function valueAt(series: readonly SeriesPoint[], isoDay: string): number | null {
  let candidate: number | null = null;
  for (const point of series) {
    if (point.date.slice(0, 10) <= isoDay) candidate = point.total;
  }
  return candidate ?? series[0]?.total ?? null;
}

/** Variations affichées sur la tuile principale du tableau de bord. */
export interface NetWorthVariations {
  readonly today: VariationDto;
  readonly oneMonth: VariationDto;
  readonly ytd: VariationDto;
  readonly oneYear: VariationDto;
  readonly all: VariationDto;
}

/** Recalcule les variations en se basant sur la série (utilisable côté maquette). */
export function variationsFromSeries(series: readonly SeriesPoint[], now: Date): NetWorthVariations {
  const last = series[series.length - 1];
  const total = last?.total ?? 0;
  const from = (period: PeriodKey): VariationDto => {
    const start = periodStart(period, now);
    if (start === null) return seriesVariation(series);
    const startIso = toIsoDay(start);
    const base = valueAt(series, startIso);
    return buildVariation(total, base);
  };
  return {
    today: from('1D'),
    oneMonth: from('1M'),
    ytd: from('YTD'),
    oneYear: from('1Y'),
    all: seriesVariation(series),
  };
}
