import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DedupIndex,
  externalDedupKey,
  fingerprint,
  normalizeDate,
  normalizeDescription,
} from '../src/dedup.ts';
import { activity } from './helpers.ts';

const base = {
  providerId: 'revolut',
  accountId: 'acc-1',
  type: 'BANK_EXPENSE' as const,
  date: '2024-03-01',
  amount: -12.5,
  currency: 'EUR',
};

test('l\'empreinte est déterministe', () => {
  assert.equal(fingerprint(base), fingerprint({ ...base }));
  assert.equal(fingerprint(base).length, 64);
});

test('l\'empreinte ne dépend pas de la casse de la devise ni du libellé', () => {
  assert.equal(
    fingerprint({ ...base, currency: 'eur' }),
    fingerprint({ ...base, currency: 'EUR' }),
  );
});

test('l\'empreinte est insensible au formatage de la date', () => {
  assert.equal(fingerprint({ ...base, date: '2024-03-01T14:22:00Z' }), fingerprint(base));
});

test('l\'empreinte change avec le montant, la date ou le type', () => {
  assert.notEqual(fingerprint({ ...base, amount: -12.51 }), fingerprint(base));
  assert.notEqual(fingerprint({ ...base, date: '2024-03-02' }), fingerprint(base));
  assert.notEqual(fingerprint({ ...base, type: 'BUY' }), fingerprint(base));
});

test('l\'empreinte ignore les variations de libellé cosmétiques', () => {
  const a = fingerprint({ ...base, description: 'CARTE 01/03/2024 BOULANGERIE' });
  const b = fingerprint({ ...base, description: 'carte 01 03 2024 boulangerie' });
  assert.equal(a, b);
});

test('la clé externe prime sur l\'empreinte', () => {
  const index = new DedupIndex();
  const input = {
    ...base,
    externalTransactionId: 'TX-1',
    externalAccountId: 'EXT-1',
  };
  assert.equal(index.check(input).decision, 'NEW');
  index.commit(input);
  // Même identifiant externe mais montant modifié : c'est une mise à jour, pas un doublon.
  const updated = { ...input, amount: -99 };
  assert.equal(index.check(updated).decision, 'DUPLICATE_EXTERNAL_ID');
});

test('deux imports du même CSV ne créent pas de doublon', () => {
  const index = new DedupIndex();
  const rows = [
    { ...base, date: '2024-03-01', amount: -12.5 },
    { ...base, date: '2024-03-02', amount: -34.9 },
    { ...base, date: '2024-03-03', amount: -8 },
  ];
  for (const row of rows) index.commit(row);
  let duplicates = 0;
  for (const row of rows) {
    if (index.check(row).decision !== 'NEW') duplicates++;
  }
  assert.equal(duplicates, 3);
  assert.equal(index.size, 3);
});

test('deux dépenses identiques le même jour sont vues comme un doublon (comportement documenté)', () => {
  const index = new DedupIndex();
  const row = { ...base, date: '2024-03-05', amount: -3.4 };
  index.commit(row);
  assert.equal(index.check(row).decision, 'DUPLICATE_FINGERPRINT');
});

test('seedFromActivity reconstitue l\'index depuis la base', () => {
  const index = new DedupIndex();
  const stored = activity({
    id: 'a1',
    type: 'BUY',
    date: '2024-01-10',
    instrumentId: 'i1',
    quantity: 10,
    unitPrice: 100,
    externalTransactionId: 'ORD-42',
    providerId: 'degiro',
  });
  index.seedFromActivity(stored);
  const decision = index.check({
    providerId: 'degiro',
    accountId: 'acc-1',
    type: 'BUY',
    date: '2024-01-10',
    instrumentId: 'i1',
    quantity: 10,
    unitPrice: 100,
    amount: -1000,
    currency: 'EUR',
    externalTransactionId: 'ORD-42',
  });
  assert.equal(decision.decision, 'DUPLICATE_EXTERNAL_ID');
});

test('externalDedupKey retourne null sans identifiant externe', () => {
  assert.equal(externalDedupKey({ providerId: 'degiro' }), null);
  assert.equal(
    externalDedupKey({ providerId: 'degiro', externalTransactionId: 'X' }),
    'ext:degiro:-:X',
  );
});

test('normalizeDate accepte ISO et rejette le texte libre', () => {
  assert.equal(normalizeDate('2024-03-01'), '2024-03-01');
  assert.equal(normalizeDate('2024-03-01T10:00:00Z'), '2024-03-01');
  assert.throws(() => normalizeDate('pas une date'), /Date invalide/);
});

test('normalizeDescription compacte et retire les accents', () => {
  assert.equal(normalizeDescription('  Café  de   LYON !!! '), 'cafe de lyon');
  assert.equal(normalizeDescription(null), '');
});
