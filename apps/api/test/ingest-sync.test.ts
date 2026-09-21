import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@suiviinvest/connectors';
import { IngestService } from '../src/services/ingest.ts';
import { SyncService } from '../src/services/sync.ts';
import { SecretsStore } from '../src/security/secrets.ts';
import { createSilentLogger } from '../src/logger.ts';
import { createTestApp, createTestConnector } from './helpers.ts';

/**
 * Ingestion et synchronisation : idempotence, isolation des pannes, journalisation.
 */

const baseTransaction = {
  externalAccountId: 'EXT-1',
  externalTransactionId: 'TX-1',
  externalAssetId: null,
  date: '2024-03-01',
  type: 'BUY' as const,
  description: 'Achat titre test',
  quantity: 10,
  unitPrice: 100,
  amount: -1000,
  currency: 'EUR',
  fees: 0,
  taxes: 0,
  rawSourceType: 'TEST',
};

test('la même synchronisation rejouée deux fois ne crée aucun doublon', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const ingest = new IngestService(ctx.db);
  const options = {
    providerId: 'degiro' as const,
    connectionId: null,
    syncRunId: null,
    importId: null,
    baseCurrency: 'EUR',
    trigger: 'MANUAL' as const,
  };
  const batch = {
    accounts: [
      { externalAccountId: 'EXT-1', name: 'Compte-titres', type: 'SECURITIES' as const, currency: 'EUR', rawSourceType: 'TEST' },
    ],
    transactions: [baseTransaction],
  };

  const first = ingest.ingestBatch(batch, options);
  assert.equal(first.created, 1);
  assert.equal(first.skipped, 0);

  const second = ingest.ingestBatch(batch, options);
  assert.equal(second.created, 0, 'aucune création au second passage');
  assert.equal(second.skipped, 1, 'la ligne existante est ignorée');
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 1);
  // Le compte externe n'est pas dupliqué non plus.
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM accounts')?.c, 1);
});

test('une correction côté fournisseur met à jour la ligne au lieu d\'en créer une seconde', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const ingest = new IngestService(ctx.db);
  const options = {
    providerId: 'degiro' as const,
    connectionId: null,
    syncRunId: null,
    importId: null,
    baseCurrency: 'EUR',
    trigger: 'MANUAL' as const,
  };
  const account = {
    externalAccountId: 'EXT-1',
    name: 'Compte-titres',
    type: 'SECURITIES' as const,
    currency: 'EUR',
    rawSourceType: 'TEST',
  };
  ingest.ingestBatch({ accounts: [account], transactions: [baseTransaction] }, options);
  const updated = ingest.ingestBatch(
    { accounts: [account], transactions: [{ ...baseTransaction, amount: -1005, fees: 5 }] },
    options,
  );
  assert.equal(updated.updated, 1);
  assert.equal(updated.created, 0);
  const row = ctx.db.get<{ amount: number; fees: number }>('SELECT amount, fees FROM activities');
  assert.equal(row?.amount, -1005);
  assert.equal(row?.fees, 5);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 1);
});

test('une transaction sans identifiant est dédupliquée par empreinte', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const ingest = new IngestService(ctx.db);
  const options = {
    providerId: 'revolut' as const,
    connectionId: null,
    syncRunId: null,
    importId: null,
    baseCurrency: 'EUR',
    trigger: 'MANUAL' as const,
  };
  const batch = {
    accounts: [
      { externalAccountId: 'REV-1', name: 'Compte Revolut', type: 'CASH' as const, currency: 'EUR', rawSourceType: 'CSV' },
    ],
    transactions: [
      {
        ...baseTransaction,
        externalAccountId: 'REV-1',
        externalTransactionId: null,
        type: 'BANK_EXPENSE' as const,
        quantity: null,
        unitPrice: null,
        amount: -12.5,
        description: 'Carte 01/03 BOULANGERIE',
      },
    ],
  };
  const first = ingest.ingestBatch(batch, options);
  assert.equal(first.created, 1);
  assert.deepEqual(first.warnings, []);
  const second = ingest.ingestBatch(batch, options);
  assert.equal(second.skipped, 1);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 1);
});

test('une transaction rattachée à un compte inconnu est ignorée et signalée', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const ingest = new IngestService(ctx.db);
  const report = ingest.ingestBatch(
    { transactions: [{ ...baseTransaction, externalAccountId: 'INCONNU-42' }] },
    {
      providerId: 'degiro',
      connectionId: null,
      syncRunId: null,
      importId: null,
      baseCurrency: 'EUR',
      trigger: 'MANUAL',
    },
  );
  assert.equal(report.created, 0);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 0);
  assert.ok(
    report.warnings.some((warning) => warning.includes('INCONNU-42')),
    'la raison doit être explicitement remontée, jamais silencieuse',
  );
});

test('une panne DEGIRO n\'empêche pas les autres fournisseurs de se synchroniser', async (t) => {
  const degiroCalls: string[] = [];
  const failing = createTestConnector({
    id: 'degiro',
    displayName: 'DEGIRO',
    failWith: new ConnectorError('degiro', 'PROVIDER_BROKEN', 'endpoint modifié'),
    onAccountsCalled: () => degiroCalls.push('degiro'),
  });
  const working = createTestConnector({
    id: 'trade_republic',
    displayName: 'Trade Republic',
    accounts: [{ externalAccountId: 'TR-1', name: 'Portefeuille TR', type: 'SECURITIES', currency: 'EUR' }],
    transactions: [{ ...baseTransaction, externalAccountId: 'TR-1', externalTransactionId: 'TR-TX-1' }],
  });

  const ctx = await createTestApp({ connectors: [failing, working] });
  t.after(() => ctx.cleanup());

  const secrets = new SecretsStore(ctx.db, 'cle-de-test-suffisamment-longue-pour-hkdf');
  const sync = new SyncService(ctx.db, ctx.registry, secrets, {
    baseCurrency: 'EUR',
    logger: createSilentLogger(),
  });

  // Deux connexions déclarées : une par fournisseur.
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, created_at, updated_at)
     VALUES ('c-degiro','degiro','DEGIRO','2024-01-01','2024-01-01'),
            ('c-tr','trade_republic','Trade Republic','2024-01-01','2024-01-01')`,
  );

  const outcomes = await sync.syncAll('MANUAL');
  assert.equal(outcomes.length, 2);
  const byProvider = new Map(outcomes.map((outcome) => [outcome.providerId, outcome]));
  assert.equal(byProvider.get('degiro')?.status, 'FAILED');
  assert.match(byProvider.get('degiro')?.message ?? '', /endpoint modifié/);
  assert.equal(byProvider.get('trade_republic')?.status, 'SUCCESS');
  assert.equal(byProvider.get('trade_republic')?.created, 1);

  // Les deux essais sont journalisés avec un identifiant de synchronisation.
  const runs = ctx.db.all<{ provider_id: string; status: string; sync_run_id: string }>(
    'SELECT provider_id, status, sync_run_id FROM sync_runs ORDER BY provider_id',
  );
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.sync_run_id.length > 0));
  assert.equal(runs.find((run) => run.provider_id === 'degiro')?.status, 'FAILED');
  assert.equal(runs.find((run) => run.provider_id === 'trade_republic')?.status, 'SUCCESS');

  // Les états de connexion reflètent le résultat, indépendamment l'un de l'autre.
  assert.equal(ctx.db.get<{ status: string }>("SELECT status FROM connections WHERE id='c-degiro'")?.status, 'ERROR');
  assert.equal(ctx.db.get<{ status: string }>("SELECT status FROM connections WHERE id='c-tr'")?.status, 'SYNCED');
  const trConnection = ctx.db.get<{ last_synced_at: string | null }>(
    "SELECT last_synced_at FROM connections WHERE id='c-tr'",
  );
  assert.ok(trConnection?.last_synced_at, 'la date de dernière synchro est enregistrée');
});

test('une authentification expirée donne le statut AUTH_REQUIRED', async (t) => {
  const connector = createTestConnector({
    id: 'credit_agricole',
    failWith: new ConnectorError('credit_agricole', 'MFA_REQUIRED', 'validation sur l\'application mobile requise'),
  });
  const ctx = await createTestApp({ connectors: [connector] });
  t.after(() => ctx.cleanup());
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, created_at, updated_at)
     VALUES ('c-ca','credit_agricole','Crédit Agricole','2024-01-01','2024-01-01')`,
  );
  const secrets = new SecretsStore(ctx.db, 'cle-de-test-suffisamment-longue-pour-hkdf');
  const sync = new SyncService(ctx.db, ctx.registry, secrets, {
    baseCurrency: 'EUR',
    logger: createSilentLogger(),
  });
  const outcome = await sync.syncConnection('c-ca', 'MANUAL');
  assert.equal(outcome.status, 'AUTH_REQUIRED');
  assert.equal(
    ctx.db.get<{ requires_user_action: number }>("SELECT requires_user_action FROM connections WHERE id='c-ca'")
      ?.requires_user_action,
    1,
  );
});

test('la conversion de devise est appliquée et signalée quand le taux manque', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const ingest = new IngestService(ctx.db);
  ctx.db.run(
    `INSERT INTO fx_rates (base, quote, date, rate, source) VALUES ('USD','EUR','2024-03-01',0.9,'test')`,
  );
  const report = ingest.ingestBatch(
    {
      accounts: [
        { externalAccountId: 'US-1', name: 'Compte USD', type: 'CASH', currency: 'USD', rawSourceType: 'TEST' },
        { externalAccountId: 'GB-1', name: 'Compte GBP', type: 'CASH', currency: 'GBP', rawSourceType: 'TEST' },
      ],
      transactions: [
        { ...baseTransaction, externalAccountId: 'US-1', externalTransactionId: 'US-1', currency: 'USD', amount: -100 },
        { ...baseTransaction, externalAccountId: 'GB-1', externalTransactionId: 'GB-1', currency: 'GBP', amount: -100 },
      ],
    },
    {
      providerId: 'manual',
      connectionId: null,
      syncRunId: null,
      importId: null,
      baseCurrency: 'EUR',
      trigger: 'MANUAL',
    },
  );
  assert.equal(report.created, 2);
  const usd = ctx.db.get<{ fx_rate_to_base: number | null }>(
    "SELECT fx_rate_to_base FROM activities WHERE external_transaction_id='US-1'",
  );
  assert.equal(usd?.fx_rate_to_base, 0.9);
  const gbp = ctx.db.get<{ fx_rate_to_base: number | null }>(
    "SELECT fx_rate_to_base FROM activities WHERE external_transaction_id='GB-1'",
  );
  assert.equal(gbp?.fx_rate_to_base, null);
  assert.ok(
    report.warnings.some((warning) => warning.includes('GBP')),
    'un taux manquant doit être signalé explicitement',
  );
});