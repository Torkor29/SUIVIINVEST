/** Tests des calculs immobiliers et du thème. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceAt, buildAmortization, computePropertyMetrics, monthlyPaymentFor, ratio, sumUntil } from '../src/lib/property.ts';
import { resolveTheme } from '../src/lib/theme.ts';

test('monthlyPaymentFor calcule une mensualité constante', () => {
  const payment = monthlyPaymentFor(200_000, 0.02, 240);
  assert.ok(payment > 1000 && payment < 1025, `mensualité inattendue ${payment}`);
  assert.equal(monthlyPaymentFor(12_000, 0, 12), 1000);
  assert.equal(monthlyPaymentFor(1000, 0.01, 0), 0);
});

test('buildAmortization désendette totalement le capital', () => {
  const rows = buildAmortization({ principal: 50_000, annualRate: 0.03, months: 60, startDate: '2025-01-01', insuranceMonthly: 10 });
  assert.equal(rows.length, 60);
  assert.equal(rows[0]?.date, '2025-01-01');
  assert.ok((rows[0]?.interest ?? 0) > (rows[rows.length - 1]?.interest ?? 0));
  const principalRepaid = rows.reduce((sum, row) => sum + row.principal, 0);
  assert.ok(Math.abs(principalRepaid - 50_000) < 5);
});

test('computePropertyMetrics produit des rendements cohérents', () => {
  const metrics = computePropertyMetrics({
    purchasePrice: 268_000,
    notaryFees: 20_100,
    agencyFees: 0,
    initialWorks: 12_500,
    currentValue: 341_000,
    monthlyIncome: 1150,
    monthlyExpenses: 156,
    loanPayment: 1014.2,
    loanInsurance: 38.5,
    loanBalance: 168_000,
    principalRepaid: 46_000,
    interestPaid: 28_000,
    occupancyRate: 1,
  });
  assert.equal(metrics.totalCost, 300_600);
  assert.equal(metrics.equity, 173_000);
  assert.equal(metrics.annualIncome, 13_800);
  assert.equal(metrics.monthlyCashFlow, 994);
  assert.equal(metrics.monthlyCashFlowAfterLoan, -58.7);
  assert.ok(metrics.grossYield > 4 && metrics.grossYield < 4.1);
  assert.equal(ratio(1, 0), 0);
});

test('balanceAt et sumUntil évaluent le prêt à une date donnée', () => {
  const rows = buildAmortization({ principal: 100_000, annualRate: 0.02, months: 120, startDate: '2020-01-01', insuranceMonthly: 20 });
  const current = balanceAt(rows, '2026-09-21');
  assert.ok(current > 0 && current < 100_000, `solde inattendu ${current}`);
  assert.ok(balanceAt(rows, '2019-01-01') === rows[0]?.remaining);
  const paid = sumUntil(rows, '2026-09-21', (row) => row.principal);
  assert.ok(Math.abs(paid - (100_000 - current)) < 1, `capital remboursé ${paid}`);
  assert.equal(balanceAt(rows, '2050-01-01'), 0);
});

test('resolveTheme suit le choix utilisateur puis le système', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});
