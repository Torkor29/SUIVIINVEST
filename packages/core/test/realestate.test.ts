import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMonths,
  amortizationSchedule,
  computePropertyMetrics,
  expandRecurring,
  monthlyPayment,
  monthlyPropertyCashFlow,
} from '../src/realestate.ts';
import type { PropertyCashFlowEntry, PropertyDetails } from '../src/types.ts';

const property: PropertyDetails = {
  id: 'prop-1',
  accountId: 'acc-immo',
  name: 'Appartement Lyon 3e',
  kind: 'APPARTEMENT',
  address: null,
  purchaseDate: '2020-01-01',
  purchasePrice: 200_000,
  notaryFees: 15_000,
  agencyFees: 0,
  initialWorks: 10_000,
  surfaceM2: 45,
  currentValue: 260_000,
  appreciationHistory: [],
  notes: null,
  loan: {
    loanType: 'AMORTIZABLE',
    principal: 160_000,
    remainingPrincipal: 0,
    annualRate: 3.5,
    months: 240,
    startDate: '2020-01-01',
    monthlyPayment: 0, // recalculé
    insuranceMonthly: 30,
    interestPaid: 0,
    principalRepaid: 0,
  },
};

const cashFlows: PropertyCashFlowEntry[] = [
  {
    id: 'cf-1',
    accountId: 'acc-immo',
    direction: 'INCOME',
    category: 'RENT',
    label: 'Loyer',
    amount: 900,
    currency: 'EUR',
    date: '2020-01-01',
    recurrence: 'MONTHLY',
    received: true,
  },
  {
    id: 'cf-2',
    accountId: 'acc-immo',
    direction: 'EXPENSE',
    category: 'CONDO_FEES',
    label: 'Charges de copropriété',
    amount: 120,
    currency: 'EUR',
    date: '2020-01-01',
    recurrence: 'MONTHLY',
    received: true,
  },
  {
    id: 'cf-3',
    accountId: 'acc-immo',
    direction: 'EXPENSE',
    category: 'PROPERTY_TAX',
    label: 'Taxe foncière',
    amount: 800,
    currency: 'EUR',
    date: '2024-10-15',
    recurrence: 'ONE_OFF',
    received: true,
  },
];

test('addMonths gère les fins de mois et les années bissextiles', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addMonths('2024-03-15', -1), '2024-02-15');
  assert.equal(addMonths('2024-12-15', 1), '2025-01-15');
});

test('mensualité : formule d\'annuité connue (200 000 € à 3,5% sur 20 ans)', () => {
  assert.ok(Math.abs(monthlyPayment(200_000, 3.5, 240) - 1159.92) < 0.05);
  assert.equal(monthlyPayment(12_000, 0, 12), 1000);
  assert.equal(monthlyPayment(1000, 3, 0), 0);
});

test('échéancier : le capital remboursé reconstitue exactement le capital emprunté', () => {
  const schedule = amortizationSchedule({
    principal: 160_000,
    annualRate: 3.5,
    months: 240,
    startDate: '2020-01-01',
    insuranceMonthly: 30,
    asOf: '2025-01-15',
  });
  const principalSum = schedule.rows.reduce((acc, row) => acc + row.principal, 0);
  assert.ok(Math.abs(principalSum - 160_000) < 1, `somme du capital: ${principalSum}`);
  assert.equal(schedule.rows.length, 240);
  assert.equal((schedule.rows[schedule.rows.length - 1] as { remaining: number }).remaining, 0);
  assert.ok(schedule.interestPaidToDate > 0);
  assert.ok(schedule.principalRepaidToDate > 0);
  assert.ok(
    Math.abs(schedule.remainingPrincipal - (160_000 - schedule.principalRepaidToDate)) < 1,
    'capital restant dû = capital initial - capital remboursé',
  );
  assert.equal(schedule.endDate, '2040-01-01');
});

test('expandRecurring déploie les loyers mensuels sur la fenêtre demandée', () => {
  const occurrences = expandRecurring(cashFlows, '2024-02-01', '2025-01-31');
  const rents = occurrences.filter((o) => o.category === 'RENT');
  assert.equal(rents.length, 12);
  assert.equal(rents[0]?.date, '2024-02-01');
  assert.equal(rents[11]?.date, '2025-01-01');
  const taxes = occurrences.filter((o) => o.category === 'PROPERTY_TAX');
  assert.equal(taxes.length, 1);
});

test('les ponctuels hors fenêtre sont exclus', () => {
  const occurrences = expandRecurring(cashFlows, '2023-02-01', '2024-01-31');
  assert.equal(occurrences.filter((o) => o.category === 'PROPERTY_TAX').length, 0);
});

test('métriques immobilières : rendements, equity et cash-flow', () => {
  const metrics = computePropertyMetrics({ property, cashFlows, asOf: '2025-01-15' });

  assert.equal(metrics.currentValue, 260_000);
  assert.equal(metrics.totalCost, 225_000);
  // 12 loyers de 900 € sur les 12 derniers mois
  assert.equal(metrics.annualIncome, 10_800);
  assert.equal(metrics.grossYield, 4.1538);
  // charges = 12*120 de copro + 1 taxe foncière de 800 + intérêts + assurance emprunteur
  assert.ok(metrics.annualExpenses > 12 * 120 + 800, `charges: ${metrics.annualExpenses}`);
  assert.equal(metrics.annualCashFlow, metrics.annualIncome - metrics.annualExpenses);
  assert.ok(
    Math.abs(metrics.annualCashFlowAfterLoan - (metrics.annualCashFlow - metrics.loanYearlyPrincipal)) < 0.01,
    'cash-flow après crédit = cash-flow - capital remboursé',
  );
  assert.equal(metrics.equity, 260_000 - metrics.loanBalance);
  assert.ok(metrics.loanBalance < 160_000);
  assert.ok(metrics.unrealizedGain > 0);
  assert.equal(metrics.downPayment, 65_000); // 225 000 - 160 000
  assert.ok(
    Math.abs(metrics.yieldOnEquity - (metrics.annualCashFlow / 65_000) * 100) < 0.0001,
    'rendement sur apport = cash-flow / apport',
  );
});

test('le taux d\'occupation reflète une mise en location partielle', () => {
  // Le bien n'est loué que depuis septembre : 5 mois sur 12.
  const lateStart: PropertyCashFlowEntry[] = [{ ...cashFlows[0]!, date: '2024-09-01' }];
  const metrics = computePropertyMetrics({ property, cashFlows: lateStart, asOf: '2025-01-15' });
  assert.equal(metrics.annualIncome, 4500); // 5 loyers de 900 €
  assert.equal(metrics.occupancyRate, 41.67);
});

test('un loyer non encaissé ne compte pas dans les revenus', () => {
  const unpaid: PropertyCashFlowEntry[] = [{ ...cashFlows[0]!, received: false }];
  const metrics = computePropertyMetrics({ property, cashFlows: unpaid, asOf: '2025-01-15' });
  assert.equal(metrics.annualIncome, 0);
  assert.equal(metrics.occupancyRate, 0);
});

test('un bien sans crédit a un equity égal à sa valeur', () => {
  const metrics = computePropertyMetrics({
    property: { ...property, loan: null },
    cashFlows,
    asOf: '2025-01-15',
  });
  assert.equal(metrics.loanBalance, 0);
  assert.equal(metrics.equity, 260_000);
  assert.equal(metrics.interestPaid, 0);
  assert.equal(metrics.principalRepaid, 0);
});

test('cash-flow mensuel : loyer encaissé moins charges moins échéance', () => {
  const june = monthlyPropertyCashFlow(property, cashFlows, '2024-06');
  assert.equal(june.income, 900);
  assert.equal(june.expenses, 120);
  assert.ok(june.loanPayment > 900);
  assert.ok(Math.abs(june.net - (june.income - june.expenses - june.loanPayment)) < 0.01);
});
