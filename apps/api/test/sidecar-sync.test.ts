import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { degiroConnector, tradeRepublicConnector, type SidecarTransport } from '@suiviinvest/connectors';
import { createSilentLogger } from '../src/logger.ts';
import { SecretsStore } from '../src/security/secrets.ts';
import { createSidecarTransport } from '../src/services/sidecar.ts';
import { createSidecarTransports } from '../src/services/sidecar-registry.ts';
import { SyncService } from '../src/services/sync.ts';
import { createTestApp } from './helpers.ts';

/**
 * Intégration : SyncService + vrais connecteurs DEGIRO/Trade Republic + FAUX
 * sidecar scripté. Aucun appel réseau réel, aucun identifiant réel.
 *
 * La déduplication est celle de la couche d'ingestion existante : rejouer une
 * synchronisation identique ne doit produire aucun doublon (compteur `skipped`).
 */

const FAKE_SIDECAR = fileURLToPath(
  new URL('../../../packages/connectors/test/fixtures/sidecar/fake-sidecar.mjs', import.meta.url),
);

function sidecarTransport(
  name: string,
  provider: string,
  env: Readonly<Record<string, string>> = {},
  command: string = process.execPath,
): SidecarTransport {
  return createSidecarTransport(name, {
    command,
    ...(command === process.execPath ? { args: [FAKE_SIDECAR] } : {}),
    env: { SUIVIINVEST_FAKE_SIDECAR_PROVIDER: provider, ...env },
  });
}

async function setup(connection: { id: string; provider: string }, sidecars: Record<string, SidecarTransport>) {
  const ctx = await createTestApp({ connectors: [degiroConnector, tradeRepublicConnector] });
  // Déclare les sidecars aux connecteurs pour que `capabilities.api`/`positions`
  // reflètent la réalité (comme le ferait `createSidecarTransports`).
  (degiroConnector as unknown as { configureSidecar(t: SidecarTransport | null): void }).configureSidecar(
    sidecars.degiro ?? null,
  );
  (tradeRepublicConnector as unknown as { configureSidecar(t: SidecarTransport | null): void }).configureSidecar(
    sidecars['trade-republic'] ?? null,
  );
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, created_at, updated_at)
     VALUES (?, ?, ?, '2024-01-01', '2024-01-01')`,
    connection.id,
    connection.provider,
    connection.provider,
  );
  const secrets = new SecretsStore(ctx.db, 'cle-de-test-suffisamment-longue-pour-hkdf');
  const sync = new SyncService(ctx.db, ctx.registry, secrets, {
    baseCurrency: 'EUR',
    logger: createSilentLogger(),
    sidecars,
  });
  return { ctx, sync };
}

test('intégration : succès complet puis idempotence (aucun doublon, skipped > 0)', async (t) => {
  const sidecars = { degiro: sidecarTransport('degiro', 'degiro') };
  const { ctx, sync } = await setup({ id: 'c-degiro', provider: 'degiro' }, sidecars);
  t.after(async () => {
    degiroConnector.configureSidecar(null);
    await ctx.cleanup();
  });

  const first = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(first.status, 'SUCCESS', first.message ?? '');
  assert.ok(first.created > 0, 'des lignes ont été créées');
  assert.equal(first.skipped, 0);
  assert.equal(first.errorCode, null);
  const created = ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c ?? 0;
  assert.ok(created > 0);

  const second = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(second.created, 0, 'aucune création au second passage');
  assert.ok(second.skipped > 0, 'la couche d\'ingestion déduplique (skipped)');
  assert.equal(
    ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c,
    created,
    'le nombre de lignes est inchangé',
  );
});

test('intégration : Trade Republic — MFA puis reprise au second appel', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sidecar-sync-state-'));
  const sidecars = {
    'trade-republic': sidecarTransport('trade-republic', 'trade-republic', {
      SUIVIINVEST_FAKE_SIDECAR_MODE: 'mfa-then-success',
      SUIVIINVEST_FAKE_SIDECAR_STATE: join(directory, 'approved.marker'),
    }),
  };
  const { ctx, sync } = await setup({ id: 'c-tr', provider: 'trade_republic' }, sidecars);
  t.after(async () => {
    tradeRepublicConnector.configureSidecar(null);
    rmSync(directory, { recursive: true, force: true });
    await ctx.cleanup();
  });

  const first = await sync.syncConnection('c-tr', 'MANUAL');
  assert.equal(first.status, 'AUTH_REQUIRED');
  assert.equal(first.errorCode, 'MFA_REQUIRED');
  assert.ok(first.userAction && /application du fournisseur|validation/i.test(first.userAction));

  const second = await sync.syncConnection('c-tr', 'MANUAL');
  assert.equal(second.status, 'SUCCESS', second.message ?? '');
  assert.ok(second.created > 0, 'la synchronisation reprend après validation');
});

test('intégration : rate limit transmis tel quel (RATE_LIMITED)', async (t) => {
  const sidecars = {
    degiro: sidecarTransport('degiro', 'degiro', { SUIVIINVEST_FAKE_SIDECAR_MODE: 'rate-limited' }),
  };
  const { ctx, sync } = await setup({ id: 'c-degiro', provider: 'degiro' }, sidecars);
  t.after(async () => {
    degiroConnector.configureSidecar(null);
    await ctx.cleanup();
  });

  const outcome = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'RATE_LIMITED');
  assert.ok(outcome.userAction && outcome.userAction.length > 0);
});

test('intégration : session expirée => AUTH_REQUIRED (SESSION_EXPIRED)', async (t) => {
  const sidecars = {
    degiro: sidecarTransport('degiro', 'degiro', { SUIVIINVEST_FAKE_SIDECAR_MODE: 'session-expired' }),
  };
  const { ctx, sync } = await setup({ id: 'c-degiro', provider: 'degiro' }, sidecars);
  t.after(async () => {
    degiroConnector.configureSidecar(null);
    await ctx.cleanup();
  });

  const outcome = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(outcome.status, 'AUTH_REQUIRED');
  assert.equal(outcome.errorCode, 'SESSION_EXPIRED');
});

test('intégration : binaire absent => NOT_SUPPORTED actionnable, sans planter', async (t) => {
  const sidecars = {
    degiro: sidecarTransport('degiro', 'degiro', {}, '/chemin/inexistant/sidecar-bin'),
  };
  const { ctx, sync } = await setup({ id: 'c-degiro', provider: 'degiro' }, sidecars);
  t.after(async () => {
    degiroConnector.configureSidecar(null);
    await ctx.cleanup();
  });

  assert.equal(sidecars.degiro.isAvailable(), false);
  assert.equal(degiroConnector.capabilities.api, false);

  const outcome = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'NOT_SUPPORTED');
  assert.ok(outcome.userAction && outcome.userAction.length > 0);
});

test('intégration : réponse invalide => PROVIDER_BROKEN', async (t) => {
  const sidecars = {
    degiro: sidecarTransport('degiro', 'degiro', { SUIVIINVEST_FAKE_SIDECAR_MODE: 'garbage' }),
  };
  const { ctx, sync } = await setup({ id: 'c-degiro', provider: 'degiro' }, sidecars);
  t.after(async () => {
    degiroConnector.configureSidecar(null);
    await ctx.cleanup();
  });

  const outcome = await sync.syncConnection('c-degiro', 'MANUAL');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'PROVIDER_BROKEN');
});

test('registry : createSidecarTransports fournit les deux clés attendues', () => {
  const transports = createSidecarTransports({
    degiro: { command: process.execPath, args: [FAKE_SIDECAR] },
    'trade-republic': { command: process.execPath, args: [FAKE_SIDECAR] },
    register: false,
  });
  assert.equal(transports.degiro.name, 'degiro');
  assert.equal(transports['trade-republic'].name, 'trade-republic');
});
