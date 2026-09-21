/** Tests des fenêtres de période et des variations de patrimoine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeriesPoint } from '@suiviinvest/api-contract';
import {
  buildVariation,
  filterSeriesByPeriod,
  periodStart,
  periodToDays,
  seriesVariation,
  valueAt,
  variationsFromSeries,
} from '../src/lib/period.ts';
import { toIsoDay } from '../src/lib/format.ts';

const NOW = new Date('2026-09-21T12:00:00Z');

function series(days: number): SeriesPoint[] {
  return Array.from({ length: days + 1 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1));
    date.setUTCDate(date.getUTCDate() + index);
    return { date: toIsoDay(date), total: 1000 + index };
  });
}

test('periodToDays couvre toutes les clés du contrat', () => {
  assert.equal(periodToDays('1D'), 1);
  assert.equal(periodToDays('1W'), 7);
  assert.equal(periodToDays('3M'), 92);
  assert.equal(periodToDays('5Y'), 1825);
  assert.equal(periodToDays('MAX'), null);
});

test('periodStart gère YTD et MAX', () => {
  assert.equal(toIsoDay(periodStart('YTD', NOW) ?? NOW), '2026-01-01');
  assert.equal(periodStart('MAX', NOW), null);
  assert.equal(toIsoDay(periodStart('1M', NOW) ?? NOW), '2026-08-21');
});

test('filterSeriesByPeriod restreint la série à la fenêtre', () => {
  const data = series(300);
  const month = filterSeriesByPeriod(data, '1M', NOW);
  assert.ok(month.length > 0, 'aucun point conservé');
  assert.ok(month.every((point) => point.date >= '2026-08-21'), 'point hors fenêtre conservé');
  const ytd = filterSeriesByPeriod(data, 'YTD', NOW);
  assert.ok(ytd.every((point) => point.date >= '2026-01-01'));
  assert.equal(filterSeriesByPeriod(data, 'MAX', NOW).length, data.length);
});

test('buildVariation et seriesVariation calculent absolu et pourcentage', () => {
  assert.deepEqual(buildVariation(110, 100), { absolute: 10, percent: 10 });
  assert.deepEqual(buildVariation(100, 0), { absolute: 100, percent: 0 });
  assert.deepEqual(buildVariation(100, null), { absolute: 0, percent: 0 });
  const variation = seriesVariation([
    { date: '2026-01-01', total: 200 },
    { date: '2026-02-01', total: 250 },
  ]);
  assert.equal(variation.absolute, 50);
  assert.equal(variation.percent, 25);
});

test('valueAt retient le dernier point antérieur à la date demandée', () => {
  const data = series(10);
  assert.equal(valueAt(data, '2026-01-01'), 1000);
  assert.equal(valueAt(data, '2026-01-06'), 1005);
  assert.equal(valueAt([], '2026-01-06'), null);
});

test('variationsFromSeries produit les cinq variations du contrat', () => {
  const data = series(400);
  const variations = variationsFromSeries(data, NOW);
  const last = data[data.length - 1]?.total ?? 0;
  const first = data[0]?.total ?? 0;
  assert.equal(variations.all.absolute, last - first);
  assert.ok(variations.oneMonth.absolute > 0);
  assert.ok(variations.ytd.absolute > 0);
  assert.ok(Number.isFinite(variations.today.percent));
});
