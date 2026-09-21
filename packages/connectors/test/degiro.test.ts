import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry } from '../src/index.ts';
import { degiroConnector, degiroInternals } from '../src/providers/degiro.ts';
import { expectConnectorError, fixture, formatOf, makeTestContext } from './helpers.ts';

const CONTENT = fixture('degiro-account.csv');
const FORMAT = formatOf(degiroConnector, 'degiro-account-csv');
const FIRST_ORDER_ID = 'aaaa1111-0000-4000-8000-000000000001';

test('degiro : le format Account.csv est déclaré et détecté sur une fixture réelle anonymisée', () => {
  assert.equal(degiroConnector.id, 'degiro');
  assert.equal(degiroConnector.importFormats.length, 1);
  assert.ok(FORMAT.detect(CONTENT) >= 0.99, `score ${FORMAT.detect(CONTENT)}`);
  assert.equal(FORMAT.detect('a,b\n1,2\n'), 0);
  assert.equal(FORMAT.detect(''), 0);
});

test('degiro : l\'entête anglaise est reconnue par la même signature', () => {
  const english = CONTENT.replace(
    'Date,Heure,Date de,Produit,Code ISIN,Description,FX,Mouvements,,Solde,,ID Ordre',
    'Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id',
  );
  assert.equal(FORMAT.detect(english), 1);
});

test('degiro : parsing du relevé (débits, crédits, revenus, erreurs non silencieuses)', () => {
  const result = FORMAT.parse(CONTENT);

  assert.equal(result.transactions.length, 6);
  assert.equal(result.income.length, 2);
  assert.equal(result.positions.length, 0);

  const [fee, buy, sell, tax, deposit, sweep] = result.transactions;
  assert.equal(fee?.type, 'FEE');
  assert.equal(fee?.amount, -1.25);
  assert.equal(fee?.currency, 'EUR');

  assert.equal(buy?.type, 'BUY');
  assert.equal(buy?.amount, -1005);
  assert.equal(buy?.quantity, 10);
  assert.equal(buy?.unitPrice, 100.5);
  assert.equal(buy?.externalAssetId, 'FR0000000001');
  assert.equal(buy?.date, '2025-02-01');

  assert.equal(sell?.type, 'SELL');
  assert.equal(sell?.amount, 408);
  assert.equal(sell?.quantity, 4);
  assert.equal(sell?.unitPrice, 102);

  assert.equal(tax?.type, 'TAX', '« Impôts sur dividende » doit être une retenue, pas un dividende');
  assert.equal(tax?.amount, -2.5);

  assert.equal(deposit?.type, 'DEPOSIT');
  assert.equal(deposit?.amount, 2000);

  assert.equal(sweep?.type, 'TRANSFER_OUT');
  assert.equal(sweep?.amount, -2000);

  assert.deepEqual(
    result.income.map((item) => [item.type, item.amount, item.date]),
    [
      ['DIVIDEND', 12.5, '2025-02-10'],
      ['INTEREST', 1.2, '2025-02-20'],
    ],
  );

  // Ligne 11 = date inexistante (31-02-2025) : rejetée avec sa raison.
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.line, 11);
  assert.match(result.errors[0]?.reason ?? '', /31-02-2025/);

  // La ligne « miroir » du cash sweep (solde seul) est signalée, pas transformée en 0.
  assert.ok(result.warnings.some((warning) => /sans montant de mouvement/.test(warning)));
  assert.ok(result.transactions.every((transaction) => transaction.amount !== 0));
});

test('degiro : identifiant de déduplication stable dérivé de l\'ID d\'ordre', () => {
  const result = FORMAT.parse(CONTENT);
  const buy = result.transactions.find((item) => item.type === 'BUY');
  assert.ok(buy?.externalTransactionId);
  assert.ok(buy.externalTransactionId.startsWith(FIRST_ORDER_ID));
  assert.ok(buy.externalTransactionId.includes('achat10exemplemondeucitsetf'));

  // Deux lignes partageant le même ID d'ordre (frais + achat) ne produisent pas
  // la même clé : l'empreinte du libellé et du montant discrimine.
  const fee = result.transactions.find((item) => item.type === 'FEE');
  assert.ok(fee?.externalTransactionId?.includes('fraisdegiro'));
  assert.notEqual(fee?.externalTransactionId, buy.externalTransactionId);

  const ids = result.transactions.map((item) => item.externalTransactionId).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test('degiro : le mapping de colonnes est explicitement ignoré (lecture positionnelle)', () => {
  const result = FORMAT.parse(CONTENT, { columnMap: { description: 'Description' } });
  assert.ok(result.warnings.some((warning) => /lu par POSITION/.test(warning)));
});

test('degiro : le compte externe par défaut est surchargeable', () => {
  const result = FORMAT.parse(CONTENT, { defaultAccountExternalId: 'peu-importe' });
  assert.ok(result.transactions.every((item) => item.externalAccountId === 'peu-importe'));
});

test('degiro : extraction quantité / prix depuis la description d\'ordre', () => {
  const details = degiroInternals.parseTradeDetails(
    'Achat 42 Exemple Monde UCITS ETF@96,11 CHF (FR0000000001)',
  );
  assert.equal(details.quantity, 42);
  assert.equal(details.unitPrice, 96.11);
  assert.equal(details.priceCurrency, 'CHF');
  assert.equal(details.isin, 'FR0000000001');
  assert.equal(details.instrumentName, 'Exemple Monde UCITS ETF');

  const none = degiroInternals.parseTradeDetails('Dividende');
  assert.equal(none.quantity, null);
});

test('degiro : le registre détecte ce format plutôt qu\'un autre', () => {
  const best = createDefaultRegistry().detectImportFormat(CONTENT);
  assert.equal(best?.connector.id, 'degiro');
  assert.equal(best?.format.id, 'degiro-account-csv');
});

test('degiro : connecteur honnêtement limité au fichier (api=false, sync refusée)', async () => {
  assert.equal(degiroConnector.capabilities.api, false);
  assert.deepEqual(degiroConnector.requiredSecrets, []);
  assert.deepEqual(degiroConnector.requiredConfig, []);

  const { ctx } = makeTestContext();
  const test1 = await degiroConnector.testConnection(ctx);
  assert.equal(test1.ok, true);
  assert.equal(test1.status, 'DISCONNECTED');
  assert.equal(test1.requiresUserAction, false);

  const error = await expectConnectorError(degiroConnector.syncAccounts(ctx), 'NOT_SUPPORTED');
  assert.match(error.message, /import de fichier/);

  await expectConnectorError(degiroConnector.syncBalances(ctx, []), 'NOT_SUPPORTED');
  await expectConnectorError(degiroConnector.syncPositions(ctx, []), 'NOT_SUPPORTED');
  await expectConnectorError(degiroConnector.syncTransactions(ctx, {}), 'NOT_SUPPORTED');
  await expectConnectorError(degiroConnector.syncIncome(ctx, {}), 'NOT_SUPPORTED');

  const status = await degiroConnector.getSyncStatus(ctx);
  assert.equal(status.status, 'DISCONNECTED');
  assert.equal(status.requiresUserAction, false);
});
