import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePositions, mergePositions } from '../src/positions.ts';
import { activity } from './helpers.ts';

test('PRU par coût moyen pondéré : deux achats à des prix différents', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
      activity({ type: 'BUY', date: '2024-02-10', instrumentId: 'i1', quantity: 10, unitPrice: 200 }),
    ],
    lastPrices: { i1: 180 },
  });
  const position = result.positions[0];
  assert.ok(position);
  assert.equal(position.quantity, 20);
  assert.equal(position.costBasis, 3000);
  assert.equal(position.averageCost, 150);
  assert.equal(position.marketValue, 3600);
  assert.equal(position.unrealizedPnl, 600);
  assert.equal(position.firstActivityDate, '2024-01-10');
});

test('les frais d\'achat entrent dans le prix de revient', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100, fees: 10 }),
    ],
  });
  const position = result.positions[0];
  assert.equal(position?.costBasis, 1010);
  assert.equal(position?.averageCost, 101);
});

test('vente partielle : plus-value réalisée et PRU inchangé', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
      activity({ type: 'BUY', date: '2024-02-10', instrumentId: 'i1', quantity: 10, unitPrice: 200 }),
      activity({ type: 'SELL', date: '2024-03-10', instrumentId: 'i1', quantity: 5, unitPrice: 250, fees: 5 }),
    ],
    lastPrices: { i1: 250 },
  });
  const position = result.positions[0];
  assert.ok(position);
  assert.equal(position.quantity, 15);
  assert.equal(position.averageCost, 150);
  assert.equal(position.costBasis, 2250);
  assert.equal(position.realizedPnl, 495); // 1245 encaissés - 750 de coût de revient
  assert.equal(result.realizedPnl, 495);
});

test('vente totale : position soldée sans résidu', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
      activity({ type: 'SELL', date: '2024-02-10', instrumentId: 'i1', quantity: 10, unitPrice: 120 }),
    ],
  });
  const position = result.positions.find((p) => p.instrumentId === 'i1');
  assert.equal(position?.quantity, 0);
  assert.equal(position?.costBasis, 0);
  assert.equal(position?.realizedPnl, 200);
});

test('une vente supérieure à la position est une erreur de données explicite', () => {
  assert.throws(
    () =>
      computePositions({
        activities: [
          activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 5, unitPrice: 100 }),
          activity({ type: 'SELL', date: '2024-02-10', instrumentId: 'i1', quantity: 6, unitPrice: 120 }),
        ],
      }),
    /Vente de 6 > position 5/,
  );
});

test('les ventes d\'un jour sont traitées après les achats du même jour', () => {
  const result = computePositions({
    activities: [
      activity({ id: 'a2', type: 'SELL', date: '2024-01-10', instrumentId: 'i1', quantity: 1, unitPrice: 120 }),
      activity({ id: 'a1', type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 1, unitPrice: 100 }),
    ],
  });
  assert.equal(result.positions[0]?.realizedPnl, 20);
});

test('dividendes, intérêts, frais et taxes sont agrégés séparément', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
      activity({ type: 'DIVIDEND', date: '2024-03-01', instrumentId: 'i1', amount: 45 }),
      activity({ type: 'INTEREST', date: '2024-04-01', accountId: 'acc-1', amount: 12 }),
      activity({ type: 'STAKING_REWARD', date: '2024-04-02', instrumentId: 'i1', amount: 3 }),
      activity({ type: 'FEE', date: '2024-05-01', accountId: 'acc-1', amount: -7 }),
      activity({ type: 'TAX', date: '2024-05-02', accountId: 'acc-1', amount: -30 }),
    ],
  });
  assert.equal(result.dividends, 45);
  assert.equal(result.interest, 15);
  assert.equal(result.fees, 7);
  assert.equal(result.taxes, 30);
});

test('un split multiplie la quantité sans changer le coût total', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
      activity({ type: 'SPLIT', date: '2024-06-01', instrumentId: 'i1', quantity: 2 }),
    ],
  });
  const position = result.positions[0];
  assert.equal(position?.quantity, 20);
  assert.equal(position?.costBasis, 1000);
  assert.equal(position?.averageCost, 50);
});

test('un transfert entrant conserve le coût de revient transféré', () => {
  const result = computePositions({
    activities: [
      activity({
        type: 'TRANSFER_IN',
        date: '2024-01-10',
        accountId: 'acc-a',
        instrumentId: 'i1',
        quantity: 10,
        unitPrice: 100,
      }),
    ],
  });
  assert.equal(result.positions[0]?.costBasis, 1000);
  assert.equal(result.positions[0]?.averageCost, 100);
});

test('mergePositions consolide un instrument détenu sur deux comptes', () => {
  const first = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', accountId: 'acc-a', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
    ],
    lastPrices: { i1: 150 },
  });
  const second = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-02-10', accountId: 'acc-b', instrumentId: 'i1', quantity: 5, unitPrice: 200 }),
    ],
    lastPrices: { i1: 150 },
  });
  const merged = mergePositions([first, second]);
  const position = merged.positions[0];
  assert.equal(position?.quantity, 15);
  assert.equal(position?.costBasis, 2000);
  assert.equal(position?.averageCost, 133.33333333);
  assert.equal(position?.marketValue, 2250);
});

test('un transfert crypto entrant crée la position, un sortant la réduit', () => {
  const result = computePositions({
    activities: [
      // Entrant : 2 ETH valorisés 3 000 € au moment de la réception.
      activity({
        type: 'CRYPTO_TRANSFER',
        date: '2024-01-10',
        instrumentId: 'eth',
        quantity: 2,
        unitPrice: 3000,
        amount: 6000,
      }),
      // Sortant : 0,5 ETH envoyés ailleurs (aucune plus-value réalisée).
      activity({
        type: 'CRYPTO_TRANSFER',
        date: '2024-02-10',
        instrumentId: 'eth',
        quantity: 0.5,
        unitPrice: 3500,
        amount: -1750,
      }),
    ],
    lastPrices: { eth: 3500 },
  });
  const position = result.positions[0];
  assert.ok(position);
  assert.equal(position.quantity, 1.5);
  assert.equal(position.costBasis, 4500); // 6000 - 0,5 × 3000
  assert.equal(position.averageCost, 3000);
  assert.equal(position.marketValue, 5250);
  assert.equal(position.realizedPnl, 0, 'un transfert sortant ne réalise pas de plus-value');
});

test('un reward de staking versé en token augmente la quantité et le revenu', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'CRYPTO_TRANSFER', date: '2024-01-10', instrumentId: 'eth', quantity: 10, amount: 30000 }),
      activity({ type: 'STAKING_REWARD', date: '2024-03-01', instrumentId: 'eth', quantity: 0.05, amount: 150 }),
    ],
    lastPrices: { eth: 3000 },
  });
  const position = result.positions[0];
  assert.equal(position?.quantity, 10.05);
  assert.equal(result.interest, 150, 'le reward est aussi un revenu');
  assert.equal(position?.dividends, 0);
});

test('un instrument sans prix connu est valorisé à son coût (pas à zéro)', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 10, unitPrice: 100 }),
    ],
  });
  assert.equal(result.positions[0]?.marketValue, 1000);
  assert.equal(result.positions[0]?.unrealizedPnl, 0);
});

test('les activités en devise étrangère sont signalées', () => {
  const result = computePositions({
    activities: [
      activity({ type: 'BUY', date: '2024-01-10', instrumentId: 'i1', quantity: 1, unitPrice: 100, currency: 'USD' }),
    ],
    currency: 'EUR',
  });
  assert.deepEqual(result.mixedCurrencyInstruments, ['i1']);
});
