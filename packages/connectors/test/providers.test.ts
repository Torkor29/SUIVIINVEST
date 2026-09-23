import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  builtInConnectors,
  ConnectorRegistry,
  createDefaultRegistry,
  type Connector,
} from '../src/index.ts';
import { fixture } from './helpers.ts';

const PROVIDER_DIR = new URL('../src/providers/', import.meta.url);

/** Toutes les fixtures et le format/connecteur attendus par le registre. */
const DETECTION_CASES: readonly { readonly file: string; readonly connector: string; readonly format: string }[] = [
  { file: 'degiro-account.csv', connector: 'degiro', format: 'degiro-account-csv' },
  { file: 'trade-republic-en.csv', connector: 'trade_republic', format: 'trade-republic-csv-en' },
  { file: 'trade-republic-de.csv', connector: 'trade_republic', format: 'trade-republic-csv-de' },
  { file: 'credit-agricole-operations.csv', connector: 'credit_agricole', format: 'credit-agricole-operations-csv' },
  { file: 'credit-agricole-titres.csv', connector: 'credit_agricole', format: 'credit-agricole-titres-csv' },
  { file: 'revolut-account-statement.csv', connector: 'revolut', format: 'revolut-account-statement-csv' },
  { file: 'revolut-trading-statement.csv', connector: 'revolut', format: 'revolut-trading-statement-csv' },
  { file: 'metamask-address.json', connector: 'metamask', format: 'metamask-address-json' },
  { file: 'manual-activities.csv', connector: 'manual', format: 'manual-activities-csv' },
  { file: 'manual-activities.json', connector: 'manual', format: 'manual-activities-json' },
];

test('registre : rejette un identifiant de connecteur en doublon', () => {
  const duplicate: Connector = { ...builtInConnectors[0]! };
  assert.throws(
    () => new ConnectorRegistry([builtInConnectors[0]!, duplicate]),
    /[Dd]oublon/,
  );
  assert.throws(() => createDefaultRegistry([{ ...builtInConnectors[0]! }]), /doublon/);
  assert.doesNotThrow(() => createDefaultRegistry([]));
});

/** Sources à API officielle ou publique : pas de repli fichier requis. */
const OFFICIAL_API_SOURCES: ReadonlySet<string> = new Set([
  'enable_banking',
  'bitcoin',
  'solana',
  'binance',
  'kraken',
  'coinbase',
  'bitpanda',
]);

test('registre : résolution par identifiant et erreur explicite si absent', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.list().length, 13);
  for (const id of ['enable_banking', 'bitcoin', 'solana', 'binance', 'kraken', 'coinbase', 'bitpanda'] as const) {
    assert.equal(registry.get(id)?.id, id);
  }
  assert.equal(registry.get('degiro')?.displayName, 'DEGIRO');
  assert.equal(registry.get('trade_republic')?.id, 'trade_republic');
  assert.equal(registry.get('credit_agricole')?.id, 'credit_agricole');
  assert.equal(registry.get('revolut')?.id, 'revolut');
  assert.equal(registry.get('metamask')?.id, 'metamask');
  assert.equal(registry.get('manual')?.id, 'manual');
  assert.equal(registry.get('csv'), null);

  assert.throws(
    () => registry.require('csv'),
    (error: unknown) =>
      error instanceof Error && 'kind' in error && (error as { kind: string }).kind === 'NOT_SUPPORTED',
  );
});

test('registre : detectImportFormat choisit le bon connecteur et le bon format par fixture', () => {
  const registry = createDefaultRegistry();
  for (const testCase of DETECTION_CASES) {
    const content = fixture(testCase.file);
    const best = registry.detectImportFormat(content);
    assert.ok(best, `aucun format détecté pour ${testCase.file}`);
    assert.equal(best.connector.id, testCase.connector, `${testCase.file} -> mauvais connecteur`);
    assert.equal(best.format.id, testCase.format, `${testCase.file} -> mauvais format`);
    assert.ok(best.score > 0 && best.score <= 1, `score hors bornes pour ${testCase.file}: ${best.score}`);
  }
});

test('registre : un contenu inconnu ne déclenche aucune détection', () => {
  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(''), null);
  assert.equal(registry.detectImportFormat('bonjour\nle monde\n'), null);
  assert.equal(registry.detectImportFormat('{"autre": "document"}'), null);
});

test('registre : chaque connecteur déclare des formats uniques et non vides', () => {
  const seenFormats = new Set<string>();
  const seenConnectors = new Set<string>();
  for (const connector of builtInConnectors) {
    assert.equal(seenConnectors.has(connector.id), false, `connecteur en doublon : ${connector.id}`);
    seenConnectors.add(connector.id);

    assert.ok(connector.displayName.length > 0);
    // Le repli par fichier est obligatoire pour les sources à API privée ou
    // fragile. Les sources à API officielle (open banking, plateformes) ou
    // publique (blockchains) n'en ont pas besoin : elles ne peuvent pas « casser ».
    if (!OFFICIAL_API_SOURCES.has(connector.id)) {
      assert.ok(connector.importFormats.length > 0, `${connector.id} n'a aucun format d'import`);
    } else {
      assert.equal(connector.capabilities.api, true, `${connector.id} sans fichier doit avoir une API`);
    }
    for (const format of connector.importFormats) {
      assert.equal(seenFormats.has(format.id), false, `format d'import en doublon : ${format.id}`);
      seenFormats.add(format.id);
      assert.ok(format.label.length > 0);
      assert.ok(format.kind === 'CSV' || format.kind === 'JSON');
    }
  }
  assert.equal(seenFormats.size, DETECTION_CASES.length, 'chaque format déclaré doit être couvert par une fixture');
});

test('registre : la détection est défensive (aucune exception, score borné)', () => {
  const registry = createDefaultRegistry();
  const payloads = ['', '\uFEFF', 'a,b,c', '"non fermé', '\u0000\u0001\u0002', '{]', '; ; ;', 'Datum;Typ'];
  for (const connector of registry.list()) {
    for (const format of connector.importFormats) {
      for (const payload of payloads) {
        const score = format.detect(payload);
        assert.equal(typeof score, 'number');
        assert.ok(Number.isFinite(score));
        assert.ok(score >= 0 && score <= 1, `score ${score} hors bornes pour ${format.id}`);
      }
    }
  }
});

test('sécurité : le socle des providers ne contient aucune primitive d\'écriture ni de signature', () => {
  const files = [
    'degiro.ts',
    'trade-republic.ts',
    'credit-agricole.ts',
    'revolut.ts',
    'metamask.ts',
    'manual.ts',
    'shared.ts',
  ];
  const forbidden = [
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_sign',
    'personal_sign',
    'signTransaction',
    'sendRawTransaction',
    'createOrder',
    'placeOrder',
    'submitOrder',
    'deleteOrder',
    'withdraw(',
    'approve(',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, PROVIDER_DIR), 'utf8');
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} contient une primitive d'écriture interdite : ${token}`);
    }
  }
});

test('sécurité : aucun connecteur n\'exige un secret de type clé privée', () => {
  // Autorisés : identifiants d'API explicitement nommés (clé de lecture d'une
  // plateforme, session d'accès bancaire). Interdits : phrase de récupération,
  // clé privée de wallet, mot de passe ou PIN exigés d'office.
  const apiCredential = /_api_(key|secret|key_name|private_key)$|_session_id$/;
  for (const connector of builtInConnectors) {
    for (const secret of connector.requiredSecrets) {
      assert.equal(/seed|mnemonic/i.test(secret), false, `${connector.id} exige une phrase de récupération : ${secret}`);
      if (apiCredential.test(secret)) continue;
      assert.equal(
        /private|password|pin|key/i.test(secret),
        false,
        `${connector.id} exige un secret sensible : ${secret}`,
      );
    }
    for (const field of connector.requiredConfig) {
      assert.equal(
        /private|seed|mnemonic|password|pin/i.test(field),
        false,
        `${connector.id} attend un champ de configuration sensible : ${field}`,
      );
    }
  }
});

test('capacités : `api` est déclaré honnêtement pour chaque connecteur', () => {
  const expectations: Readonly<Record<string, boolean>> = {
    degiro: false,
    trade_republic: false,
    credit_agricole: false,
    revolut: false,
    metamask: true,
    enable_banking: true,
    bitcoin: true,
    solana: true,
    binance: true,
    kraken: true,
    coinbase: true,
    bitpanda: true,
    manual: false,
  };
  for (const connector of builtInConnectors) {
    assert.equal(connector.capabilities.api, expectations[connector.id], `capacité api incorrecte pour ${connector.id}`);
  }
});

test('contrat : chaque connecteur expose l\'intégralité de la surface en LECTURE SEULE', () => {
  const readOnlySurface = [
    'testConnection',
    'syncAccounts',
    'syncBalances',
    'syncPositions',
    'syncTransactions',
    'syncIncome',
    'getSyncStatus',
  ];
  for (const connector of builtInConnectors) {
    for (const method of readOnlySurface) {
      assert.equal(typeof (connector as unknown as Record<string, unknown>)[method], 'function', `${connector.id}.${method} manquant`);
    }
    // Aucune méthode d'écriture ne doit être exposée par un connecteur.
    const keys = Object.keys(connector);
    const writeLike = keys.filter((key) =>
      /^(create|place|submit|cancel|delete|update|send|buy|sell|withdraw|deposit|sign|approve|transfer)(Order|Money|Funds|Transaction|Message|Typed|Asset)?$/i.test(key),
    );
    assert.deepEqual(writeLike, [], `${connector.id} expose une méthode d'écriture : ${writeLike.join(', ')}`);
  }
});
