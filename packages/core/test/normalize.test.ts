import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bucketOf,
  detectActivityType,
  foldLabel,
  parseAmount,
  parseCurrency,
  parseDate,
  parseQuantity,
} from '../src/normalize.ts';

test('parseAmount gère les formats FR, US et ALLEMAND', () => {
  assert.equal(parseAmount('1 234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1 234'), 1234);
  assert.equal(parseAmount(42.5), 42.5);
});

test('parseAmount gère les symboles, espaces insécables et négatifs comptables', () => {
  assert.equal(parseAmount('1\u00a0234,56\u00a0€'), 1234.56);
  assert.equal(parseAmount('€1.234,56'), 1234.56);
  assert.equal(parseAmount('(123,45)'), -123.45);
  assert.equal(parseAmount('-1 000,00 EUR'), -1000);
  assert.equal(parseAmount('+250 USD'), 250);
});

test('parseAmount retourne null sur une valeur illisible (jamais 0)', () => {
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('-'), null);
  assert.equal(parseAmount('n/a'), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('12,3,4'), null);
});

test('parseQuantity est toujours positive', () => {
  assert.equal(parseQuantity('-12,5'), 12.5);
  assert.equal(parseQuantity('12.5'), 12.5);
  assert.equal(parseQuantity('abc'), null);
});

test('parseCurrency reconnaît symboles et codes', () => {
  assert.equal(parseCurrency('€'), 'EUR');
  assert.equal(parseCurrency('eur'), 'EUR');
  assert.equal(parseCurrency('USD'), 'USD');
  assert.equal(parseCurrency('CHF'), 'CHF');
  assert.equal(parseCurrency('', 'EUR'), 'EUR');
  assert.equal(parseCurrency('bitcoin'), null);
});

test('parseDate gère JJ/MM/AAAA, l\'ISO et le format US ambigu', () => {
  assert.equal(parseDate('01/03/2024'), '2024-03-01');
  assert.equal(parseDate('2024-03-01'), '2024-03-01');
  assert.equal(parseDate('01/03/24'), '2024-03-01');
  assert.equal(parseDate('03/25/2024'), '2024-03-25'); // mois > 12 => format US
  assert.equal(parseDate('31/02/2024'), null); // date inexistante
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

test('foldLabel normalise les libellés fournisseurs', () => {
  assert.equal(foldLabel('Achat Compte-Titres'), 'achatcomptetitres');
  assert.equal(foldLabel('Prélèvement'), 'prelevement');
});

test('detectActivityType reconnaît les libellés français et étrangers', () => {
  assert.equal(detectActivityType('Achat'), 'BUY');
  assert.equal(detectActivityType('Vente'), 'SELL');
  assert.equal(detectActivityType('Dividende'), 'DIVIDEND');
  assert.equal(detectActivityType('Zinsen'), 'INTEREST');
  assert.equal(detectActivityType('Einzahlung'), 'DEPOSIT');
  assert.equal(detectActivityType('Prélèvement'), 'BANK_EXPENSE');
  assert.equal(detectActivityType('Frais de courtage'), 'FEE');
  assert.equal(detectActivityType('Taxe foncière'), 'REAL_ESTATE_EXPENSE');
  assert.equal(detectActivityType('Loyer'), 'RENT');
});

test('detectActivityType retombe sur le signe du montant', () => {
  assert.equal(detectActivityType('Libellé inconnu', { amount: -100 }), 'WITHDRAWAL');
  assert.equal(detectActivityType('Libellé inconnu', { amount: 100 }), 'DEPOSIT');
  assert.equal(detectActivityType('Libellé inconnu', { amount: -100, hasQuantity: true }), 'BUY');
  assert.equal(detectActivityType('Libellé inconnu', { amount: 100, hasQuantity: true }), 'SELL');
  assert.equal(detectActivityType(null), null);
});

test('bucketOf classe les types en grandes catégories', () => {
  assert.equal(bucketOf('DIVIDEND'), 'INCOME');
  assert.equal(bucketOf('RENT'), 'INCOME');
  assert.equal(bucketOf('FEE'), 'COST');
  assert.equal(bucketOf('REAL_ESTATE_EXPENSE'), 'COST');
  assert.equal(bucketOf('BUY'), 'INVESTMENT');
  assert.equal(bucketOf('TRANSFER_IN'), 'TRANSFER');
  assert.equal(bucketOf('VALUATION_UPDATE'), 'VALUATION');
});
