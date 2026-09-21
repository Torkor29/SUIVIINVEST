import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annualize,
  buildXirrFlows,
  classifyFlows,
  maxDrawdown,
  modifiedDietz,
  twr,
  xirr,
} from '../src/performance.ts';
import { activity } from './helpers.ts';

test('TWR neutralise un apport : +10% de marché reste +10%', () => {
  // Jour 1 : 1000 €,  apport de 1000 € le jour 2, marché +10% sur le jour 2.
  const values = [
    { date: '2024-01-01', value: 1000 },
    { date: '2024-01-02', value: 2200 },
  ];
  const flows = [{ date: '2024-01-02', amount: 1000 }];
  assert.equal(twr(values, flows), 10);
});

test('TWR chaîne correctement plusieurs périodes', () => {
  const values = [
    { date: '2024-01-01', value: 1000 },
    { date: '2024-01-02', value: 1100 }, // +10%
    { date: '2024-01-03', value: 990 }, // -10%
  ];
  assert.equal(twr(values, []), -1);
});

test('TWR ignore un compte vidé (base nulle)', () => {
  const values = [
    { date: '2024-01-01', value: 100 },
    { date: '2024-01-02', value: 0 },
    { date: '2024-01-03', value: 0 },
  ];
  assert.equal(twr(values, [{ date: '2024-01-02', amount: -100 }]), 0);
});

test('un virement interne entre deux comptes est neutralisé', () => {
  const classification = classifyFlows([
    activity({ id: 'o1', accountId: 'acc-a', type: 'TRANSFER_OUT', date: '2024-03-01', amount: -2500 }),
    activity({ id: 'i1', accountId: 'acc-b', type: 'TRANSFER_IN', date: '2024-03-01', amount: 2500 }),
  ]);
  assert.equal(classification.external.length, 0);
  assert.equal(classification.internal.length, 1);
  assert.deepEqual(classification.internal[0], {
    date: '2024-03-01',
    amount: 2500,
    fromAccountId: 'acc-a',
    toAccountId: 'acc-b',
  });
  assert.equal(classification.unmatchedTransfers.length, 0);
});

test('un transfert sans contrepartie est compté comme externe et signalé', () => {
  const classification = classifyFlows([
    activity({ id: 'o1', accountId: 'acc-a', type: 'TRANSFER_OUT', date: '2024-03-01', amount: -900 }),
  ]);
  assert.equal(classification.external.length, 1);
  assert.equal(classification.unmatchedTransfers.length, 1);
});

test('un transfert vers un montant différent n\'est pas apparié', () => {
  const classification = classifyFlows([
    activity({ id: 'o1', accountId: 'acc-a', type: 'TRANSFER_OUT', date: '2024-03-01', amount: -900 }),
    activity({ id: 'i1', accountId: 'acc-b', type: 'TRANSFER_IN', date: '2024-03-02', amount: 900 }),
  ]);
  assert.equal(classification.internal.length, 0);
  assert.equal(classification.external.length, 2);
});

test('dépôts et retraits sont des flux externes signés', () => {
  const classification = classifyFlows([
    activity({ type: 'DEPOSIT', date: '2024-01-01', amount: 1000 }),
    activity({ type: 'WITHDRAWAL', date: '2024-02-01', amount: -400 }),
  ]);
  assert.deepEqual(classification.external, [
    { date: '2024-01-01', amount: 1000 },
    { date: '2024-02-01', amount: -400 },
  ]);
});

test('Modified Dietz pondère les flux par leur date', () => {
  // 1000 au départ, apport de 1000 à mi-période (30 jours), valeur finale 2100.
  const flows = [{ date: '2024-01-16', amount: 1000 }];
  const result = modifiedDietz(1000, 2100, flows, '2024-01-01', '2024-01-31');
  // Capital moyen = 1000 + 1000*(15/30) = 1500 ; gain net = 2100-1000-1000 = 100
  assert.equal(result, 6.6667);
});

test('XIRR retrouve un taux connu sur flux irréguliers', () => {
  // -1000 aujourd'hui, +1100 dans un an => 10%
  const rate = xirr([
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-12-31', amount: 1100 },
  ]);
  assert.ok(rate !== null);
  assert.ok(Math.abs((rate as number) - 9.86) < 0.5, `taux inattendu: ${rate}`);
});

test('XIRR sur flux multiples reste cohérent', () => {
  const flows = [
    { date: '2020-01-01', amount: -10000 },
    { date: '2021-01-01', amount: -5000 },
    { date: '2022-01-01', amount: 2000 },
    { date: '2024-01-01', amount: 16000 },
  ];
  const rate = xirr(flows);
  assert.ok(rate !== null);
  assert.ok((rate as number) > 0 && (rate as number) < 30, `taux inattendu: ${rate}`);
});

test('XIRR retourne null quand aucun taux ne peut être trouvé', () => {
  assert.equal(xirr([{ date: '2024-01-01', amount: 100 }]), null);
  assert.equal(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-01-02', amount: -100 }]), null);
});

test('buildXirrFlows inverse les apports et ajoute la valeur finale', () => {
  const flows = buildXirrFlows([{ date: '2024-01-01', amount: 1000 }], '2024-06-01', 1200);
  assert.deepEqual(flows, [
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-06-01', amount: 1200 },
  ]);
});

test('maxDrawdown mesure la pire baisse depuis un sommet', () => {
  const values = [
    { date: '2024-01-01', value: 100 },
    { date: '2024-01-02', value: 120 },
    { date: '2024-01-03', value: 90 },
    { date: '2024-01-04', value: 130 },
  ];
  assert.equal(maxDrawdown(values), -25);
});

test('annualize convertit un rendement cumulé en rendement annuel', () => {
  assert.equal(annualize(21, 730), 10);
  assert.equal(annualize(0, 0), null);
});
