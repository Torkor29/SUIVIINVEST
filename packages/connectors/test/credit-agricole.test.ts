import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry } from '../src/index.ts';
import { creditAgricoleConnector, creditAgricoleInternals } from '../src/providers/credit-agricole.ts';
import { expectConnectorError, fixture, formatOf, makeTestContext } from './helpers.ts';

const OPERATIONS = fixture('credit-agricole-operations.csv');
const TITRES = fixture('credit-agricole-titres.csv');
const OPS_FORMAT = formatOf(creditAgricoleConnector, 'credit-agricole-operations-csv');
const TITRES_FORMAT = formatOf(creditAgricoleConnector, 'credit-agricole-titres-csv');

test('crédit agricole : les deux formats sont déclarés et détectés', () => {
  assert.equal(creditAgricoleConnector.id, 'credit_agricole');
  assert.deepEqual(
    creditAgricoleConnector.importFormats.map((format) => format.id),
    ['credit-agricole-operations-csv', 'credit-agricole-titres-csv'],
  );
  // Signature partielle (Débit/Crédit au lieu de Montant) : détection tolérante.
  assert.ok(OPS_FORMAT.detect(OPERATIONS) >= 0.6);
  assert.equal(TITRES_FORMAT.detect(TITRES), 1);
  assert.equal(OPS_FORMAT.detect(TITRES), 0);
  assert.equal(TITRES_FORMAT.detect(OPERATIONS), 0);
});

test('crédit agricole : opérations de compte, colonnes Débit/Crédit signées', () => {
  const result = OPS_FORMAT.parse(OPERATIONS);

  assert.equal(result.transactions.length, 7);
  assert.equal(result.income.length, 1);
  assert.equal(result.errors.length, 0);

  const byDescription = new Map(result.transactions.map((item) => [item.description, item]));
  assert.equal(byDescription.get('VIREMENT RECU EXEMPLE EMPLOYEUR')?.type, 'TRANSFER_IN');
  assert.equal(byDescription.get('VIREMENT RECU EXEMPLE EMPLOYEUR')?.amount, 2500);
  assert.equal(byDescription.get('VIREMENT EMIS EXEMPLE LOYER')?.type, 'TRANSFER_OUT');
  assert.equal(byDescription.get('VIREMENT EMIS EXEMPLE LOYER')?.amount, -950);
  assert.equal(byDescription.get('PRLV SEPA EXEMPLE ENERGIE')?.type, 'BANK_EXPENSE');
  assert.equal(byDescription.get('PRLV SEPA EXEMPLE ENERGIE')?.amount, -78.4);
  assert.equal(byDescription.get('FACTURE CARTE 12/09 EXEMPLE LIBRAIRIE')?.amount, -24.9);
  assert.equal(byDescription.get('RETRAIT DAB EXEMPLE')?.type, 'WITHDRAWAL');
  assert.equal(byDescription.get('RETRAIT DAB EXEMPLE')?.amount, -60);
  assert.equal(byDescription.get('FRAIS TENUE DE COMPTE')?.type, 'FEE');
  assert.equal(byDescription.get('FRAIS TENUE DE COMPTE')?.fees, 2.5, 'les frais portent leur propre montant');
  assert.equal(byDescription.get('REMISE CHEQUE EXEMPLE')?.type, 'DEPOSIT');
  assert.equal(byDescription.get('REMISE CHEQUE EXEMPLE')?.amount, 150);
  assert.equal(byDescription.get('REMISE CHEQUE EXEMPLE')?.date, '2026-03-25');

  assert.equal(result.income[0]?.type, 'INTEREST');
  assert.equal(result.income[0]?.amount, 12.34);
});

test('crédit agricole : une variante « Montant » unique est acceptée', () => {
  const variant = [
    'Date;Libellé;Montant',
    '02/03/2026;VIREMENT RECU EXEMPLE;2500,00',
    '05/03/2026;PRLV SEPA EXEMPLE;-78,40',
  ].join('\n');
  assert.ok(OPS_FORMAT.detect(variant) >= 0.9);
  const result = OPS_FORMAT.parse(variant);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0]?.amount, 2500);
  assert.equal(result.transactions[1]?.amount, -78.4);
});

test('crédit agricole : une ligne sans montant est rejetée avec sa raison', () => {
  const variant = [
    'Date;Libellé;Montant',
    '02/03/2026;VIREMENT RECU EXEMPLE;2500,00',
    '03/03/2026;LIGNE SANS MONTANT;',
  ].join('\n');
  const result = OPS_FORMAT.parse(variant);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.reason ?? '', /Montant introuvable/);
});

test('crédit agricole : état de portefeuille titres -> positions typées', () => {
  const result = TITRES_FORMAT.parse(TITRES);

  assert.equal(result.positions.length, 4);
  assert.equal(result.transactions.length, 0);
  assert.equal(result.errors.length, 0);

  const byIsin = new Map(result.positions.map((position) => [position.isin, position]));
  assert.deepEqual(
    [byIsin.get('FR0000000001')?.quantity, byIsin.get('FR0000000001')?.unitPrice, byIsin.get('FR0000000001')?.kind],
    [42, 97.42, 'ETF'],
  );
  assert.equal(byIsin.get('US0000000003')?.currency, 'USD');
  assert.equal(byIsin.get('US0000000003')?.kind, 'EQUITY');
  assert.equal(byIsin.get('FR0000000004')?.kind, 'BOND');
  assert.equal(byIsin.get('FR0000000005')?.kind, 'FUND');
  assert.ok(result.positions.every((position) => position.symbol === null));
});

test('crédit agricole : une position sans quantité est rejetée, jamais devinée', () => {
  const variant = ['Code ISIN;Valeur;Quantité;Cours', 'FR0000000001;Exemple;10;97,42', 'FR0000000002;Sans quantité;;10,00'].join('\n');
  const result = TITRES_FORMAT.parse(variant);
  assert.equal(result.positions.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.reason ?? '', /Quantité absente/);
});

test('crédit agricole : le registre choisit le bon format par fixture', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(OPERATIONS)?.format.id, 'credit-agricole-operations-csv');
  assert.equal(registry.detectImportFormat(TITRES)?.format.id, 'credit-agricole-titres-csv');
});

test('crédit agricole : classification des libellés bancaires français', () => {
  const { classifyCreditAgricole, inferAssetKind } = creditAgricoleInternals;
  assert.equal(classifyCreditAgricole('VIREMENT RECU EXEMPLE', 2500), 'TRANSFER_IN');
  assert.equal(classifyCreditAgricole('PRLV SEPA ENERGIE', -78.4), 'BANK_EXPENSE');
  assert.equal(classifyCreditAgricole('RETRAIT DAB', -60), 'WITHDRAWAL');
  assert.equal(classifyCreditAgricole('FRAIS TENUE DE COMPTE', -2.5), 'FEE');
  assert.equal(classifyCreditAgricole('INTERETS LIVRET', 12.34), 'INTEREST');
  assert.equal(inferAssetKind('Action OPCVM'), 'FUND');
  assert.equal(inferAssetKind(null), 'OTHER');
});

test('crédit agricole : connecteur honnêtement limité au fichier', async () => {
  assert.equal(creditAgricoleConnector.capabilities.api, false);
  assert.deepEqual(creditAgricoleConnector.requiredSecrets, []);

  const { ctx } = makeTestContext();
  assert.equal((await creditAgricoleConnector.testConnection(ctx)).ok, true);
  await expectConnectorError(creditAgricoleConnector.syncPositions(ctx, []), 'NOT_SUPPORTED');
  await expectConnectorError(creditAgricoleConnector.syncIncome(ctx, {}), 'NOT_SUPPORTED');
  assert.equal((await creditAgricoleConnector.getSyncStatus(ctx)).status, 'DISCONNECTED');
});