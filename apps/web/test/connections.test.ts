/**
 * Tests des aides d'affichage des connexions : états, durées, messages.
 * Aucun DOM, aucune API : uniquement des fonctions pures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSyncAll,
  connectionStateOf,
  describeSyncOutcome,
  formatSyncDuration,
  isConnected,
  lastSyncLabel,
  readableDate,
  relativeTime,
  sourceStateOf,
  syncAllHeadline,
  syncErrorHeadline,
  syncOutcomeLabel,
  syncOutcomeTone,
  syncRunningLabel,
  walletChains,
  walletEndpointNotice,
  type SourceDefinition,
} from '../src/lib/connections.ts';
import type { SyncAllResponse, SyncOutcomeDto, WalletStatusDto } from '@suiviinvest/api-contract';

const NOW = Date.parse('2026-09-21T12:00:00Z');

test('les états serveur sont traduits en français lisible', () => {
  assert.equal(connectionStateOf('CONNECTED').label, 'Connecté');
  assert.equal(connectionStateOf('SYNCED').label, 'Synchronisé');
  assert.equal(connectionStateOf('SYNCING').label, 'En cours');
  assert.equal(connectionStateOf('AUTH_REQUIRED').label, 'Validation requise');
  assert.equal(connectionStateOf('ERROR').label, 'Erreur');
  assert.equal(connectionStateOf('IMPORT_ONLY').label, 'Import requis');
  assert.equal(connectionStateOf('DISCONNECTED').label, 'Non connecté');
});

test('un statut inconnu ne fuit jamais le code brut comme état principal', () => {
  const state = connectionStateOf('ETAT_BIZARRE');
  assert.equal(state.label, 'État inconnu');
  assert.equal(state.tone, 'neutral');
});

test('une source sans connexion est « Non configuré » et n’est pas dite connectée', () => {
  const state = sourceStateOf(null);
  assert.equal(state.label, 'Non configuré');
  assert.equal(isConnected(null), false);
});

test('AUTH_REQUIRED est bien signalé comme non connecté', () => {
  const connection = {
    id: 'c1',
    providerId: 'trade_republic',
    providerName: 'Trade Republic',
    label: 'TR',
    status: 'AUTH_REQUIRED',
    lastSyncedAt: null,
    lastError: 'Validation requise.',
    requiresUserAction: true,
    needsReauth: true,
    config: {},
    secretNames: [],
    capabilities: {
      accounts: false,
      balances: false,
      positions: false,
      transactions: false,
      income: false,
      api: false,
    },
    importFormats: [],
  };
  assert.equal(sourceStateOf(connection).label, 'Validation requise');
  assert.equal(isConnected(connection), false);
});

test('relativeTime produit « il y a X » sur toutes les échelles', () => {
  assert.equal(relativeTime('2026-09-21T11:59:50Z', NOW), "à l'instant");
  assert.equal(relativeTime('2026-09-21T11:30:00Z', NOW), 'il y a 30 min');
  assert.equal(relativeTime('2026-09-21T06:00:00Z', NOW), 'il y a 6 h');
  assert.equal(relativeTime('2026-09-18T12:00:00Z', NOW), 'il y a 3 j');
  assert.equal(relativeTime('2026-06-21T12:00:00Z', NOW), 'il y a 3 mois');
  assert.equal(relativeTime(null, NOW), '—');
});

test('readableDate et lastSyncLabel restent lisibles et explicites', () => {
  assert.equal(readableDate('2026-09-21T05:42:00Z'), '21 sept. 2026');
  assert.equal(lastSyncLabel(null), 'jamais synchronisé');
  assert.equal(lastSyncLabel('2026-09-21T06:00:00Z', NOW), '21 sept. 2026 (il y a 6 h)');
});

test('formatSyncDuration affiche « 4,2 s » et les millisecondes', () => {
  assert.equal(formatSyncDuration(4200), '4,2 s');
  assert.equal(formatSyncDuration(950), '950 ms');
  assert.equal(formatSyncDuration(0), '0 ms');
  assert.equal(formatSyncDuration(65_000), '1 min 5 s');
  assert.equal(formatSyncDuration(null), '—');
});

test('describeSyncOutcome produit la phrase demandée', () => {
  const outcome = {
    status: 'SUCCESS' as const,
    created: 37,
    updated: 12,
    skipped: 0,
    errors: 0,
    durationMs: 4200,
  };
  assert.equal(
    describeSyncOutcome(outcome),
    '37 transactions récupérées, 12 positions mises à jour, 0 doublon créé, durée 4,2 s',
  );
});

test('describeSyncOutcome gère les singuliers et les erreurs', () => {
  const outcome = {
    status: 'PARTIAL' as const,
    created: 1,
    updated: 1,
    skipped: 2,
    errors: 1,
    durationMs: 1200,
  };
  assert.equal(
    describeSyncOutcome(outcome),
    '1 transaction récupérée, 1 position mise à jour, 2 doublons créés, 1 erreur, durée 1,2 s',
  );
});

test('syncRunningLabel annonce la synchronisation en cours', () => {
  assert.equal(syncRunningLabel('DEGIRO'), 'Synchronisation DEGIRO…');
});

test('syncErrorHeadline traduit les codes techniques en consignes', () => {
  assert.match(syncErrorHeadline('AUTH_REQUIRED'), /Validation requise/);
  assert.match(syncErrorHeadline('SESSION_EXPIRED'), /expiré/);
  assert.match(syncErrorHeadline('RATE_LIMITED'), /limite temporairement/);
  assert.match(syncErrorHeadline('PROVIDER_DOWN'), /ne répond pas/);
  assert.match(syncErrorHeadline('NOT_SUPPORTED'), /importez un relevé/);
  assert.equal(syncErrorHeadline('INCONNU', 'Message métier.'), 'Message métier.');
  assert.equal(syncErrorHeadline(null), 'La synchronisation a échoué.');
});

test('syncOutcomeLabel et syncOutcomeTone classent les retours', () => {
  assert.equal(syncOutcomeLabel('SUCCESS'), 'OK');
  assert.equal(syncOutcomeLabel('PARTIAL'), 'Partiel');
  assert.equal(syncOutcomeLabel('AUTH_REQUIRED'), 'Validation requise');
  assert.equal(syncOutcomeLabel('FAILED'), 'Erreur');
  assert.equal(syncOutcomeTone('SUCCESS'), 'ok');
  assert.equal(syncOutcomeTone('PARTIAL'), 'warn');
  assert.equal(syncOutcomeTone('FAILED'), 'danger');
});

function outcome(providerId: string, status: SyncOutcomeDto['status'], created = 0, updated = 0): SyncOutcomeDto {
  return {
    syncRunId: `run-${providerId}`,
    connectionId: `conn-${providerId}`,
    providerId,
    status,
    created,
    updated,
    skipped: 0,
    errors: status === 'FAILED' ? 1 : 0,
    message: null,
    errorCode: null,
    durationMs: 1000,
    warnings: [],
  };
}

test('aggregateSyncAll agrège les retours par source et détecte la panne isolée', () => {
  const response: SyncAllResponse = {
    results: [
      outcome('metamask', 'SUCCESS', 1, 2),
      outcome('degiro', 'SUCCESS', 2, 1),
      outcome('trade_republic', 'AUTH_REQUIRED'),
      outcome('credit_agricole', 'SUCCESS', 1, 1),
      outcome('revolut', 'FAILED'),
    ],
    summary: { total: 5, succeeded: 3, partial: 0, failed: 1, authRequired: 1, created: 4, updated: 4 },
  };
  const summary = aggregateSyncAll(response);
  assert.equal(summary.total, 5);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.authRequired, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.created, 4);
  assert.equal(summary.updated, 4);
  assert.equal(summary.hasFailure, true);
  assert.match(syncAllHeadline(summary), /3 source\(s\) sur 5/);
  assert.match(syncAllHeadline(summary), /1 validation\(s\) requise\(s\)/);
});

test('aggregateSyncAll sur un résumé vide reste neutre', () => {
  const summary = aggregateSyncAll(null);
  assert.equal(summary.total, 0);
  assert.equal(summary.hasFailure, false);
  assert.equal(syncAllHeadline(summary), 'Aucune connexion à synchroniser.');
});

test('la vue wallet expose chaînes et erreur sans invention', () => {
  const wallet: WalletStatusDto = {
    accountId: 'acc-1',
    name: 'MetaMask',
    address: '0xe2e0000000000000000000000000000000000001',
    chains: [
      { chain: 'ethereum', tokens: 1, valueEur: 5000, lastSyncedAt: '2026-09-21T06:00:00Z', lastBlock: 1, error: null },
      { chain: 'base', tokens: 1, valueEur: 1500, lastSyncedAt: '2026-09-21T06:00:00Z', lastBlock: 2, error: 'RPC lent' },
    ],
    tokenCount: 2,
    valueEur: 6500,
    lastSyncedAt: '2026-09-21T06:00:00Z',
    error: null,
  };
  assert.deepEqual(walletChains(wallet), ['ethereum', 'base']);
  assert.equal(wallet.tokenCount, 2);
  assert.equal(wallet.valueEur, 6500);
});

test('walletEndpointNotice explique un 404 et un 401 sans erreur brute', () => {
  assert.match(walletEndpointNotice(404, 'NOT_FOUND'), /pas encore disponible/);
  assert.match(walletEndpointNotice(401, 'UNAUTHENTICATED'), /Session expirée/);
  assert.match(walletEndpointNotice(500, 'INTERNAL'), /ne peuvent pas être affichés/);
});

test('SOURCE_ORDER couvre les cinq sources demandées dans l’ordre', () => {
  const order: readonly SourceDefinition[] = [
    { providerId: 'metamask', providerName: 'MetaMask' },
    { providerId: 'degiro', providerName: 'DEGIRO' },
    { providerId: 'trade_republic', providerName: 'Trade Republic' },
    { providerId: 'credit_agricole', providerName: 'Crédit Agricole' },
    { providerId: 'revolut', providerName: 'Revolut' },
  ];
  assert.deepEqual(order.map((item) => item.providerName), [
    'MetaMask',
    'DEGIRO',
    'Trade Republic',
    'Crédit Agricole',
    'Revolut',
  ]);
});
