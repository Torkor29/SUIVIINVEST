import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry } from '../src/index.ts';
import { tradeRepublicConnector, tradeRepublicInternals } from '../src/providers/trade-republic.ts';
import { expectConnectorError, fixture, formatOf, makeTestContext } from './helpers.ts';

const EN = fixture('trade-republic-en.csv');
const DE = fixture('trade-republic-de.csv');
const EN_FORMAT = formatOf(tradeRepublicConnector, 'trade-republic-csv-en');
const DE_FORMAT = formatOf(tradeRepublicConnector, 'trade-republic-csv-de');

test('trade republic : les deux formats sont déclarés et détectés sur leurs fixtures', () => {
  assert.equal(tradeRepublicConnector.id, 'trade_republic');
  assert.deepEqual(
    tradeRepublicConnector.importFormats.map((format) => format.id),
    ['trade-republic-csv-en', 'trade-republic-csv-de'],
  );
  assert.equal(EN_FORMAT.detect(EN), 1);
  assert.equal(EN_FORMAT.detect(DE), 0);
  assert.equal(DE_FORMAT.detect(DE), 1);
  assert.equal(DE_FORMAT.detect(EN), 0);
});

test('trade republic : export anglais — mouvements, revenus et catégorisation', () => {
  const result = EN_FORMAT.parse(EN);

  assert.equal(result.transactions.length, 6);
  assert.equal(result.income.length, 3);
  assert.equal(result.errors.length, 0);

  const byType = new Map(result.transactions.map((item) => [item.type, item]));
  assert.equal(byType.get('TRANSFER_IN')?.amount, 500);
  assert.equal(byType.get('TRANSFER_OUT')?.amount, -250);
  assert.equal(byType.get('BANK_EXPENSE')?.amount, -12.75);

  const buy = byType.get('BUY');
  assert.equal(buy?.amount, -120.26);
  assert.equal(buy?.quantity, 1.23456789);
  assert.equal(buy?.unitPrice, 97.42);
  assert.equal(buy?.externalAssetId, 'FR0000000001');
  assert.equal(buy?.externalTransactionId, 'aaaa0000-2222-7000-8000-000000000002');

  const sell = byType.get('SELL');
  assert.equal(sell?.amount, 49.55);
  assert.equal(sell?.fees, 0.99, 'les frais Trade Republic sont négatifs dans l\'export, normalisés positifs');

  // Comptes séparés espèces / titres, comme chez Trade Republic.
  assert.equal(byType.get('BUY')?.externalAccountId, 'trade-republic-securities');
  assert.equal(byType.get('BANK_EXPENSE')?.externalAccountId, 'trade-republic-cash');

  const incomeByType = new Map(result.income.map((item) => [item.type, item]));
  assert.equal(incomeByType.get('INTEREST')?.amount, 2.41);
  assert.equal(incomeByType.get('INTEREST')?.withholdingTax, 0.47);
  assert.equal(incomeByType.get('DIVIDEND')?.amount, 4.56);
  assert.equal(incomeByType.get('DIVIDEND')?.withholdingTax, 0.68);
  assert.equal(incomeByType.get('DIVIDEND')?.date, '2026-04-09');
  assert.ok(incomeByType.has('STAKING_REWARD'), 'BENEFITS_SAVEBACK est rangé dans les revenus');

  // Colonnes présentes mais non exploitées : signalées, pas perdues silencieusement.
  assert.deepEqual([...result.unmappedColumns].sort(), ['counterparty_iban', 'payment_reference']);
});

test('trade republic : un type inconnu ne fait pas échouer l\'import (repli documenté)', () => {
  const result = EN_FORMAT.parse(EN);
  const fallback = result.transactions.find((item) => item.description === 'Type non répertorié');
  assert.ok(fallback, 'la ligne au type inconnu est conservée');
  assert.equal(fallback?.type, 'DEPOSIT', 'repli sur le signe du montant (dépôt)');
});

test('trade republic : export local allemand (pytr) — quantité, frais, retenues', () => {
  const result = DE_FORMAT.parse(DE);

  assert.equal(result.transactions.length, 4);
  assert.equal(result.income.length, 2);
  assert.equal(result.errors.length, 0);

  const byType = new Map(result.transactions.map((item) => [item.type, item]));
  assert.equal(byType.get('BUY')?.amount, -3002.8);
  assert.equal(byType.get('BUY')?.quantity, 60);
  assert.equal(byType.get('BUY')?.externalAssetId, 'FR0000000001');
  assert.equal(byType.get('DEPOSIT')?.amount, 200);
  assert.equal(byType.get('SPLIT')?.quantity, 49);
  assert.equal(byType.get('SELL')?.amount, 94.76);
  assert.equal(byType.get('SELL')?.taxes, 3.18);

  const dividend = result.income.find((item) => item.type === 'DIVIDEND');
  assert.equal(dividend?.amount, 2.24);
  assert.equal(dividend?.withholdingTax, 0.78);
  assert.equal(result.income.find((item) => item.type === 'INTEREST')?.amount, 0.42);

  // Devise absente de l'export pytr : hypothèse EUR explicitement signalée.
  assert.ok(result.warnings.some((warning) => /EUR est supposé/.test(warning)));
  assert.ok(result.transactions.every((item) => item.currency === 'EUR'));
});

test('trade republic : le registre choisit le bon format par fixture', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(EN)?.format.id, 'trade-republic-csv-en');
  assert.equal(registry.detectImportFormat(DE)?.format.id, 'trade-republic-csv-de');
});

test('trade republic : classement des libellés', () => {
  const { classifyTradeRepublicEn, classifyTradeRepublicDe } = tradeRepublicInternals;
  assert.equal(classifyTradeRepublicEn('CASH', 'TRANSFER_INSTANT_INBOUND', '', 500, false), 'TRANSFER_IN');
  assert.equal(classifyTradeRepublicEn('CASH', 'CARD_TRANSACTION_INTERNATIONAL', '', -45, false), 'BANK_EXPENSE');
  assert.equal(classifyTradeRepublicEn('CORPORATE_ACTION', 'LIQUIDATION_PROCEEDS', '', 2, true), 'SELL');
  assert.equal(classifyTradeRepublicDe('Kauf', '', -100, true), 'BUY');
  assert.equal(classifyTradeRepublicDe('Übertrag', '', -100, false), 'TRANSFER_OUT');
});

test('trade republic : connecteur honnêtement limité au fichier', async () => {
  assert.equal(tradeRepublicConnector.capabilities.api, false);
  assert.deepEqual(tradeRepublicConnector.requiredSecrets, []);

  const { ctx } = makeTestContext();
  const connection = await tradeRepublicConnector.testConnection(ctx);
  assert.equal(connection.ok, true);
  assert.equal(connection.status, 'DISCONNECTED');

  const error = await expectConnectorError(tradeRepublicConnector.syncAccounts(ctx), 'NOT_SUPPORTED');
  assert.match(error.message, /trade-republic-csv-en/);
  await expectConnectorError(tradeRepublicConnector.syncTransactions(ctx, {}), 'NOT_SUPPORTED');
  assert.equal((await tradeRepublicConnector.getSyncStatus(ctx)).status, 'DISCONNECTED');
});
