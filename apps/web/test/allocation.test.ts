/** Tests des calculs d'allocation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concentration, dominantSlice, groupSmallSlices, percentOf, slicesFromValues, sliceKeyOf, sliceTotal, topSlices } from '../src/lib/allocation.ts';

const SLICES = slicesFromValues([
  { key: 'actions', label: 'Actions-ETF', value: 60 },
  { key: 'immo', label: 'Immobilier', value: 30 },
  { key: 'crypto', label: 'Crypto', value: 8 },
  { key: 'divers', label: 'Autres actifs', value: 1 },
  { key: 'cash', label: 'Cash', value: 1 },
]);

test('percentOf protège la division par zéro', () => {
  assert.equal(percentOf(25, 100), 25);
  assert.equal(percentOf(5, 0), 0);
  assert.equal(percentOf(Number.NaN, 100), 0);
});

test('slicesFromValues trie par valeur décroissante et calcule les pourcentages', () => {
  assert.deepEqual(
    SLICES.map((slice) => slice.key),
    ['actions', 'immo', 'crypto', 'divers', 'cash'],
  );
  assert.equal(SLICES[0]?.percent, 60);
  assert.equal(Math.round(sliceTotal(SLICES) * 100) / 100, 100);
});

test('groupSmallSlices agrège les postes marginaux', () => {
  const grouped = groupSmallSlices(SLICES, 5, 'Autres');
  assert.equal(grouped.length, 4);
  const last = grouped[grouped.length - 1];
  assert.equal(last?.key, 'autres');
  assert.equal(last?.value, 2);
  assert.equal(last?.label, 'Autres');
});

test('groupSmallSlices laisse la liste intacte si rien à regrouper', () => {
  const grouped = groupSmallSlices(SLICES, 0.5);
  assert.equal(grouped.length, SLICES.length);
});

test('topSlices, dominantSlice et concentration', () => {
  assert.equal(topSlices(SLICES, 2).length, 2);
  assert.equal(dominantSlice(SLICES)?.key, 'actions');
  assert.equal(dominantSlice([]), null);
  assert.equal(concentration(SLICES), 98);
});

test('sliceKeyOf normalise les accents et la casse', () => {
  assert.equal(sliceKeyOf('Actions-ETF'), 'actions-etf');
  assert.equal(sliceKeyOf('Autres actifs'), 'autres-actifs');
  assert.equal(sliceKeyOf('Épargne réglementée'), 'epargne-reglementee');
});
