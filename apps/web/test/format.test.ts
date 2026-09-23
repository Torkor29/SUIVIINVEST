/** Tests des formateurs : montants, pourcentages, dates (aucun DOM requis). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactUnit,
  formatCompactEur,
  formatDate,
  formatDuration,
  formatEur,
  formatMonthLabel,
  formatMoney,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatUptime,
  formatWithEur,
  toneOf,
} from '../src/lib/format.ts';

test('compactUnit place les seuils k / M / Md', () => {
  assert.equal(compactUnit(999), '');
  assert.equal(compactUnit(1_500), 'k');
  assert.equal(compactUnit(2_000_000), 'M');
  assert.equal(compactUnit(-3_400_000_000), 'Md');
});

test('formatCompactEur produit des montants courts', () => {
  assert.equal(formatCompactEur(486_000), '486 k€');
  const million = formatCompactEur(1_250_000);
  assert.ok(million.endsWith(' M€'), `attendu un suffixe M€, reçu ${million}`);
  assert.ok(million.startsWith('1,3'), `attendu 1,3 arrondi, reçu ${million}`);
});

test('formatPercent gère le signe et les décimales', () => {
  assert.equal(formatPercent(2.4), '+2,40 %');
  assert.equal(formatPercent(-1), '-1,00 %');
  assert.equal(formatPercent(0), '0,00 %');
  assert.equal(formatPercent(12.345, { sign: false, digits: 1 }), '12,3 %');
});

test('formatEur et formatMoney respectent la devise', () => {
  const euro = formatEur(1234.5);
  assert.ok(euro.includes('€'));
  assert.ok(euro.includes('234'));
  const usd = formatMoney(1234.5, 'USD');
  assert.ok(usd.includes('$'), `attendu un symbole dollar, reçu ${usd}`);
  assert.ok(formatWithEur(100, 'USD', 92).includes('€'));
  assert.equal(formatWithEur(100, 'EUR', 100), formatEur(100));
});

test('formatNumber et formatQuantity restent localisés', () => {
  assert.equal(formatNumber(1234.567, 2).replace(/[\u202f\u00a0]/g, ' '), '1 234,57');
  assert.equal(formatQuantity(1.8424), '1,8424');
});

test('toneOf classe les variations', () => {
  assert.equal(toneOf(3), 'up');
  assert.equal(toneOf(-0.5), 'down');
  assert.equal(toneOf(0), 'flat');
});

test('formatDate et formatMonthLabel sont en français', () => {
  assert.equal(formatDate('2026-09-21'), '21 sept. 2026');
  assert.equal(formatDate('2026-09-21', 'long'), '21 septembre 2026');
  assert.equal(formatMonthLabel('2026-09'), 'sept. 26');
  assert.equal(formatDate(null), '—');
});

test('formatDuration bascule en minutes au-delà de 60 s', () => {
  assert.equal(formatDuration(950), '950 ms');
  assert.equal(formatDuration(65_000), '1 min 5 s');
  assert.equal(formatDuration(null), '—');
});

test('formatUptime résume une disponibilité serveur', () => {
  assert.equal(formatUptime(486_320), '5 j 15 h');
  assert.equal(formatUptime(3700), '1 h 1 min');
  assert.equal(formatUptime(120), '2 min');
  assert.equal(formatUptime(null), '—');
});

test('formatRelative : durées lisibles', async () => {
  const { formatRelative } = await import('../src/lib/format.ts');
  const now = new Date('2026-09-23T12:00:00Z');
  assert.equal(formatRelative('2026-09-23T11:59:30Z', now), 'à l’instant');
  assert.equal(formatRelative('2026-09-23T11:55:00Z', now), 'il y a 5 min');
  assert.equal(formatRelative('2026-09-23T09:00:00Z', now), 'il y a 3 h');
  assert.equal(formatRelative('2026-09-22T10:00:00Z', now), 'hier');
  assert.equal(formatRelative('2026-09-19T10:00:00Z', now), 'il y a 4 jours');
  assert.equal(formatRelative('2026-09-01T10:00:00Z', now), 'le 1 sept. 2026');
  assert.equal(formatRelative(null, now), '—');
});

test('initialsOf : initiales pour les avatars', async () => {
  const { initialsOf } = await import('../src/lib/initials.ts');
  assert.equal(initialsOf('Julie Martin'), 'JM');
  assert.equal(initialsOf('julie.martin'), 'JM');
  assert.equal(initialsOf('julie'), 'JU');
  assert.equal(initialsOf(''), '•');
  assert.equal(initialsOf(null), '•');
});
