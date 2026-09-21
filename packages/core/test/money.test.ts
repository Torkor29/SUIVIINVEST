import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  add,
  convert,
  findRate,
  invertRate,
  money,
  round,
  sub,
  sum,
  variation,
} from '../src/money.ts';
import type { FxRate } from '../src/types.ts';

const rates: FxRate[] = [
  { base: 'USD', quote: 'EUR', date: '2024-01-01', rate: 0.9, source: 'test' },
  { base: 'USD', quote: 'EUR', date: '2024-06-01', rate: 0.92, source: 'test' },
  { base: 'GBP', quote: 'EUR', date: '2024-06-01', rate: 1.17, source: 'test' },
];

test('round borne la précision et neutralise les artefacts flottants', () => {
  assert.equal(round(0.1 + 0.2), 0.3);
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(1 / 3, 4), 0.3333);
  assert.equal(round(Number.NaN), 0);
  assert.equal(round(Infinity), 0);
});

test('sum est stable sur de longues séries (Kahan)', () => {
  const values = Array.from({ length: 10_000 }, () => 0.01);
  assert.equal(sum(values), 100);
  assert.equal(sum([0.1, 0.2, 0.3]), 0.6);
});

test('arithmétique Money : devises identiques obligatoires', () => {
  const a = money(10, 'EUR');
  const b = money(2.5, 'EUR');
  assert.equal(add(a, b).amount, 12.5);
  assert.equal(sub(a, b).amount, 7.5);
  assert.throws(() => add(a, money(1, 'USD')), /Devises incompatibles/);
});

test('findRate prend le taux connu le plus récent antérieur à la date', () => {
  const rate = findRate(rates, 'USD', 'EUR', '2024-03-15', 'latest-on-or-before');
  assert.equal(rate?.rate, 0.9);
  const later = findRate(rates, 'USD', 'EUR', '2024-07-01', 'latest-on-or-before');
  assert.equal(later?.rate, 0.92);
});

test('findRate respecte le mode exact et retourne null sans taux', () => {
  assert.equal(findRate(rates, 'USD', 'EUR', '2024-03-15', 'exact'), null);
  assert.notEqual(findRate(rates, 'USD', 'EUR', '2024-06-01', 'exact'), null);
  assert.equal(findRate(rates, 'JPY', 'EUR', '2024-06-01'), null);
});

test('les taux inversés sont utilisés pour la paire inverse', () => {
  const inverted = invertRate({ base: 'USD', quote: 'EUR', date: '2024-01-01', rate: 0.9, source: 't' });
  assert.equal(inverted.base, 'EUR');
  assert.equal(inverted.quote, 'USD');
  assert.equal(inverted.rate, round(1 / 0.9, 12));
  const parsed = findRate(rates, 'EUR', 'USD', '2024-06-01');
  assert.equal(parsed?.rate, round(1 / 0.92, 12));
});

test('convert retourne null plutôt qu\'un taux inventé', () => {
  const result = convert(100, 'USD', 'EUR', rates, '2024-06-15');
  assert.deepEqual(result, { amount: 92, rate: 0.92 });
  assert.equal(convert(100, 'JPY', 'EUR', rates, '2024-06-15'), null);
});

test('convert identité sans taux stocké', () => {
  assert.deepEqual(convert(42, 'EUR', 'EUR', [], '2024-06-15'), { amount: 42, rate: 1 });
});

test('variation gère les bases nulles et négatives', () => {
  assert.deepEqual(variation(100, 110), { absolute: 10, percent: 10 });
  assert.deepEqual(variation(0, 10), { absolute: 10, percent: 0 });
  assert.deepEqual(variation(-100, -50), { absolute: 50, percent: 50 });
});
