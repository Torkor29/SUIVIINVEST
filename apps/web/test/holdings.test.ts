import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HoldingDetailResponse, HoldingsHistoryResponse, HoldingsResponse } from '@suiviinvest/api-contract';
import { assetBadge, describePlan, formatPrice, formatShares } from '../src/lib/holdings.ts';
import { mockRequest } from '../src/mock/index.ts';

const nbsp = (text: string): string => text.replace(/[  ]/g, ' ');

test('cours : décimales adaptées au prix', () => {
  assert.equal(nbsp(formatPrice(612.5)), '612,50 €');
  assert.equal(nbsp(formatPrice(0.1234)), '0,1234 €');
  assert.equal(nbsp(formatPrice(0.00001234)), '0,00001234 €');
  assert.equal(formatPrice(null), '—');
});

test('quantités : 4 décimales au-delà d’une unité, 8 en dessous', () => {
  assert.equal(nbsp(formatShares(47.02480718)), '47,0248');
  assert.equal(nbsp(formatShares(0.02861503)), '0,02861503');
});

test('investissement programmé décrit en clair', () => {
  assert.equal(nbsp(describePlan({ amount: 200, currency: 'USD', frequency: 'MONTHLY', dayOfMonth: 10, startDate: '2025-01-10' })), '200 $US chaque mois, le 10');
  assert.equal(nbsp(describePlan({ amount: 50, currency: 'EUR', frequency: 'QUARTERLY', dayOfMonth: 1, startDate: '2025-01-01' })), '50 € chaque trimestre, le 1er');
  assert.equal(assetBadge('NVDA', 'NVIDIA'), 'NV');
  assert.equal(assetBadge(null, 'OAT 3 % 2034'), 'OA');
});

test('démo : portefeuille cohérent (total = somme des lignes), fiche et courbe', () => {
  const overview = mockRequest('/api/holdings', 'GET', null) as HoldingsResponse;
  const sum = overview.positions.reduce((total, position) => total + position.value, 0);
  assert.ok(Math.abs(sum - overview.totals.value) < 0.05);
  assert.equal(overview.plans.length, 1);
  const nvda = overview.positions.find((position) => position.symbol === 'NVDA');
  assert.ok(nvda);
  const detail = mockRequest(`/api/holdings/assets/${nvda.instrumentId}?period=1Y`, 'GET', null) as HoldingDetailResponse;
  assert.equal(detail.asset.name, nvda.name);
  assert.equal(detail.prices.at(-1)?.total, nvda.lastPrice);
  assert.ok(detail.prices.length > 300);
  const history = mockRequest('/api/holdings/history?period=MAX', 'GET', null) as HoldingsHistoryResponse;
  assert.ok(history.points.length > 1000);
  assert.ok(history.points.every((point) => point.value > 0 && point.invested > 0));
});
