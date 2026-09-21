import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry } from '../src/index.ts';
import { revolutConnector, revolutInternals } from '../src/providers/revolut.ts';
import { expectConnectorError, fixture, formatOf, makeTestContext } from './helpers.ts';

const ACCOUNT = fixture('revolut-account-statement.csv');
const TRADING = fixture('revolut-trading-statement.csv');
const ACCOUNT_FORMAT = formatOf(revolutConnector, 'revolut-account-statement-csv');
const TRADING_FORMAT = formatOf(revolutConnector, 'revolut-trading-statement-csv');

test('revolut : les deux formats sont déclarés et détectés', () => {
  assert.equal(revolutConnector.id, 'revolut');
  assert.deepEqual(
    revolutConnector.importFormats.map((format) => format.id),
    ['revolut-account-statement-csv', 'revolut-trading-statement-csv'],
  );
  assert.equal(ACCOUNT_FORMAT.detect(ACCOUNT), 1);
  assert.equal(TRADING_FORMAT.detect(TRADING), 1);
  assert.equal(ACCOUNT_FORMAT.detect(TRADING), 0);
  assert.equal(TRADING_FORMAT.detect(ACCOUNT), 0);
});

test('revolut : relevé de compte — transferts signés, revenus, états non finaux écartés', () => {
  const result = ACCOUNT_FORMAT.parse(ACCOUNT);

  assert.equal(result.transactions.length, 5);
  assert.equal(result.income.length, 2);
  assert.equal(result.errors.length, 0);

  const transfers = result.transactions.filter((item) => item.type.startsWith('TRANSFER'));
  assert.deepEqual(transfers.map((item) => item.amount), [-50, 25]);
  assert.deepEqual(transfers.map((item) => item.type), ['TRANSFER_OUT', 'TRANSFER_IN']);

  const byType = new Map(result.transactions.map((item) => [item.type, item]));
  assert.equal(byType.get('BANK_EXPENSE')?.amount, -12.75);
  assert.equal(byType.get('DEPOSIT')?.amount, 200);
  assert.equal(byType.get('FEE')?.amount, -5);

  const incomeTypes = result.income.map((item) => item.type).sort();
  assert.deepEqual(incomeTypes, ['INTEREST', 'STAKING_REWARD']);

  // L'opération PENDING est écartée et signalée.
  assert.ok(result.warnings.some((warning) => /COMPLETED/.test(warning)));
  assert.ok(result.transactions.every((item) => item.description.includes('PENDING') === false));
  assert.equal(result.transactions.some((item) => item.amount === -19.99), false);
});

test('revolut : relevé de trading — montant dérivé quand Total Amount manque', () => {
  const result = TRADING_FORMAT.parse(TRADING);

  assert.equal(result.transactions.length, 3);
  assert.equal(result.income.length, 1);
  assert.equal(result.errors.length, 0);

  const byType = new Map(result.transactions.map((item) => [item.type, item]));
  assert.equal(byType.get('BUY')?.amount, -381);
  assert.equal(byType.get('BUY')?.quantity, 2);
  assert.equal(byType.get('BUY')?.currency, 'USD');
  assert.equal(byType.get('BUY')?.unitPrice, 190.5);
  assert.equal(byType.get('SELL')?.amount, 195, 'montant recalculé : quantité x prix, signe positif en vente');
  assert.equal(byType.get('FEE')?.amount, -0.5);

  assert.equal(result.income[0]?.type, 'DIVIDEND');
  assert.equal(result.income[0]?.amount, 0.42);

  assert.ok(result.warnings.some((warning) => /Total Amount/.test(warning)));
  assert.ok(result.warnings.some((warning) => /ne contient pas d'ISIN/.test(warning)));
});

test('revolut : le registre choisit le bon format par fixture', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(ACCOUNT)?.format.id, 'revolut-account-statement-csv');
  assert.equal(registry.detectImportFormat(TRADING)?.format.id, 'revolut-trading-statement-csv');
});

test('revolut : classement des libellés', () => {
  const { classifyRevolut, classifyTrading } = revolutInternals;
  assert.equal(classifyRevolut('Topup', '', 200), 'DEPOSIT');
  assert.equal(classifyRevolut('Transfer', '', -50), 'TRANSFER_OUT');
  assert.equal(classifyRevolut('Transfer', '', 50), 'TRANSFER_IN');
  assert.equal(classifyRevolut('Card Payment', '', -12.75), 'BANK_EXPENSE');
  assert.equal(classifyRevolut('Interest', '', 1.23), 'INTEREST');
  assert.equal(classifyTrading('Sell', 'AAPL', null), 'SELL');
  assert.equal(classifyTrading('Dividend', 'AAPL', 0.42), 'DIVIDEND');
  assert.equal(classifyTrading('Custody fee', 'AAPL', -0.5), 'FEE');
});

test('revolut : connecteur honnêtement limité au fichier', async () => {
  assert.equal(revolutConnector.capabilities.api, false);
  assert.deepEqual(revolutConnector.requiredSecrets, []);

  const { ctx } = makeTestContext();
  assert.equal((await revolutConnector.testConnection(ctx)).ok, true);
  await expectConnectorError(revolutConnector.syncAccounts(ctx), 'NOT_SUPPORTED');
  await expectConnectorError(revolutConnector.syncTransactions(ctx, {}), 'NOT_SUPPORTED');
  assert.equal((await revolutConnector.getSyncStatus(ctx)).status, 'DISCONNECTED');
});