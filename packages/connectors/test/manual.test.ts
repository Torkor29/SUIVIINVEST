import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry } from '../src/index.ts';
import { manualConnector, manualInternals } from '../src/providers/manual.ts';
import { expectConnectorError, fixture, formatOf, makeTestContext } from './helpers.ts';

const CSV = fixture('manual-activities.csv');
const JSON_DOC = fixture('manual-activities.json');
const CSV_FORMAT = formatOf(manualConnector, 'manual-activities-csv');
const JSON_FORMAT = formatOf(manualConnector, 'manual-activities-json');

test('manual : les deux formats sont déclarés et détectés', () => {
  assert.equal(manualConnector.id, 'manual');
  assert.deepEqual(
    manualConnector.importFormats.map((format) => format.id),
    ['manual-activities-csv', 'manual-activities-json'],
  );
  assert.equal(CSV_FORMAT.detect(CSV), 1);
  assert.equal(JSON_FORMAT.detect(JSON_DOC), 1);
  assert.equal(CSV_FORMAT.detect(JSON_DOC), 0);
  assert.equal(JSON_FORMAT.detect(CSV), 0);
});

test('manual : CSV — activités, revenus et positions explicites', () => {
  const result = CSV_FORMAT.parse(CSV);

  assert.equal(result.transactions.length, 2);
  assert.equal(result.income.length, 1);
  assert.equal(result.positions.length, 1);
  assert.equal(result.errors.length, 0);

  const buy = result.transactions.find((item) => item.type === 'BUY');
  assert.equal(buy?.amount, -1005);
  assert.equal(buy?.quantity, 10);
  assert.equal(buy?.unitPrice, 100.5);
  assert.equal(buy?.fees, 1.25);
  assert.equal(buy?.externalAssetId, 'FR0000000001');
  assert.equal(buy?.externalTransactionId, 'manual:tx-001');
  assert.equal(buy?.externalAccountId, 'manual-pea');

  const deposit = result.transactions.find((item) => item.type === 'DEPOSIT');
  assert.equal(deposit?.amount, 1500);
  assert.equal(deposit?.externalAccountId, 'manual-livret');

  const dividend = result.income[0];
  assert.equal(dividend?.type, 'DIVIDEND');
  assert.equal(dividend?.amount, 12.5);
  assert.equal(dividend?.withholdingTax, 2.5);

  const position = result.positions[0];
  assert.equal(position?.isin, 'FR0000000001');
  assert.equal(position?.quantity, 10);
  assert.equal(position?.unitPrice, 101);
  assert.equal(position?.kind, 'ETF');
});

test('manual : une ligne CSV sans montant est rejetée avec sa raison', () => {
  const broken = [
    'date,type,account,description,amount,currency',
    '2026-01-15,BUY,manual-pea,Achat,abc,EUR',
  ].join('\n');
  const result = CSV_FORMAT.parse(broken);
  assert.equal(result.transactions.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.reason ?? '', /Montant absent ou illisible/);
});

test('manual : JSON — document structuré et document « compte » ignoré proprement', () => {
  const result = JSON_FORMAT.parse(JSON_DOC);

  assert.equal(result.transactions.length, 2);
  assert.equal(result.income.length, 1);
  assert.equal(result.positions.length, 1);
  assert.equal(result.errors.length, 0);

  assert.equal(result.income[0]?.type, 'RENT');
  assert.equal(result.income[0]?.amount, 850);
  assert.equal(result.transactions.find((item) => item.type === 'REAL_ESTATE_EXPENSE')?.amount, -120);
  assert.equal(result.transactions.find((item) => item.type === 'DEPOSIT')?.amount, 1000);

  const position = result.positions[0];
  assert.equal(position?.kind, 'REAL_ESTATE');
  assert.equal(position?.unitPrice, 240000);
  // Compte par défaut pris dans le document.
  assert.ok(result.transactions.every((item) => item.externalAccountId === 'manual-immobilier'));
});

test('manual : JSON — tableau nu accepté, entrées invalides rejetées', () => {
  const array = JSON.stringify([
    { date: '2026-01-05', type: 'DEPOSIT', amount: 100 },
    { date: 'pas-une-date', type: 'DEPOSIT', amount: 50 },
    { date: '2026-01-07', type: 'DEPOSIT' },
  ]);
  const result = JSON_FORMAT.parse(array);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0]?.reason ?? '', /date absente ou illisible/);
  assert.match(result.errors[1]?.reason ?? '', /montant absent ou illisible/);
});

test('manual : JSON — le compte externe par défaut est surchargeable', () => {
  const result = JSON_FORMAT.parse(JSON_DOC, { defaultAccountExternalId: 'sur- mesure' });
  assert.ok(result.positions.every((position) => position.externalAccountId === 'sur- mesure'));
  assert.ok(result.transactions.every((transaction) => transaction.externalAccountId === 'sur- mesure'));
});

test('manual : le registre choisit le bon format par fixture', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(CSV)?.format.id, 'manual-activities-csv');
  assert.equal(registry.detectImportFormat(JSON_DOC)?.format.id, 'manual-activities-json');
});

test('manual : normalisation des types d\'actif et du compte', () => {
  const { toAssetKind, manualAccount } = manualInternals;
  assert.equal(toAssetKind('etf'), 'ETF');
  assert.equal(toAssetKind('REAL_ESTATE'), 'REAL_ESTATE');
  assert.equal(toAssetKind('n\'importe quoi'), 'OTHER');
  assert.equal(toAssetKind(null), 'OTHER');

  assert.deepEqual(manualAccount({ externalAccountId: 'x', name: 'Livret', type: 'CASH', currency: 'eur' }), {
    externalAccountId: 'x',
    name: 'Livret',
    type: 'CASH',
    currency: 'EUR',
    rawSourceType: 'manual.account',
    balance: null,
    isActive: true,
  });
});

test('manual : connecteur hors ligne, aucun réseau possible', async () => {
  assert.equal(manualConnector.capabilities.api, false);
  assert.deepEqual(manualConnector.requiredConfig, []);
  assert.deepEqual(manualConnector.requiredSecrets, []);

  const { ctx, http } = makeTestContext();
  assert.equal((await manualConnector.testConnection(ctx)).ok, true);
  await expectConnectorError(manualConnector.syncAccounts(ctx), 'NOT_SUPPORTED');
  await expectConnectorError(manualConnector.syncPositions(ctx, []), 'NOT_SUPPORTED');
  await expectConnectorError(manualConnector.syncTransactions(ctx, {}), 'NOT_SUPPORTED');
  await expectConnectorError(manualConnector.syncIncome(ctx, {}), 'NOT_SUPPORTED');
  assert.equal(http.requests.length, 0, 'aucune requête réseau ne doit être émise');
  assert.equal((await manualConnector.getSyncStatus(ctx)).status, 'DISCONNECTED');
});