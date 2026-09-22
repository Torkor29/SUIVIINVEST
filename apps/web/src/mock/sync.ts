/**
 * Maquette : retours de synchronisation et portefeuilles EVM.
 *
 * Les valeurs sont celles du contrat (`SyncOutcomeDto`, `SyncAllResponse`,
 * `WalletStatusDto`) pour que l'interface soit exercée exactement comme avec
 * l'API réelle — y compris les cas d'échec et de validation requise.
 */
import type { SyncAllResponse, SyncOutcomeDto, WalletStatusDto } from '@suiviinvest/api-contract';

function outcome(
  providerId: string,
  connectionId: string,
  status: SyncOutcomeDto['status'],
  counts: { created: number; updated: number; skipped: number; errors: number },
  durationMs: number,
  extra: { errorCode?: string; message?: string; warnings?: readonly string[] } = {},
): SyncOutcomeDto {
  return {
    syncRunId: `run-${providerId}-${Math.round(durationMs)}`,
    connectionId,
    providerId,
    status,
    created: counts.created,
    updated: counts.updated,
    skipped: counts.skipped,
    errors: counts.errors,
    message: extra.message ?? null,
    errorCode: extra.errorCode ?? null,
    durationMs,
    warnings: extra.warnings ?? [],
  };
}

/** Retour de synchronisation d'une connexion (maquette déterministe). */
export function mockSyncOutcome(connectionId: string): SyncOutcomeDto | null {
  switch (connectionId) {
    case 'conn-degiro':
      return outcome(
        'degiro',
        connectionId,
        'SUCCESS',
        { created: 37, updated: 12, skipped: 0, errors: 0 },
        4200,
        { warnings: ['2 instruments sans cotation : valeurs conservées.'] },
      );
    case 'conn-ca':
      return outcome('credit_agricole', connectionId, 'SUCCESS', { created: 34, updated: 0, skipped: 12, errors: 0 }, 21120);
    case 'conn-metamask':
      return outcome('metamask', connectionId, 'SUCCESS', { created: 12, updated: 4, skipped: 2, errors: 0 }, 9120);
    case 'conn-revolut':
      return outcome('revolut', connectionId, 'FAILED', { created: 0, updated: 0, skipped: 0, errors: 1 }, 2400, {
        errorCode: 'NOT_SUPPORTED',
        message: 'Ce fournisseur ne propose pas de collecte automatique : importez un relevé.',
      });
    case 'conn-tr':
      return outcome('trade_republic', connectionId, 'AUTH_REQUIRED', { created: 0, updated: 0, skipped: 0, errors: 0 }, 1800, {
        errorCode: 'AUTH_REQUIRED',
        message: 'Validation requise dans l’application Trade Republic.',
      });
    default:
      return null;
  }
}

/** Résumé d'une synchronisation globale (maquette) : une panne n'empêche pas les autres. */
export function mockSyncAllResponse(): SyncAllResponse {
  const ids = ['conn-metamask', 'conn-degiro', 'conn-tr', 'conn-ca', 'conn-revolut'] as const;
  const results = ids.map((id) => mockSyncOutcome(id)).filter((item): item is SyncOutcomeDto => item !== null);
  return {
    results,
    summary: {
      total: results.length,
      succeeded: results.filter((result) => result.status === 'SUCCESS').length,
      partial: results.filter((result) => result.status === 'PARTIAL').length,
      failed: results.filter((result) => result.status === 'FAILED').length,
      authRequired: results.filter((result) => result.status === 'AUTH_REQUIRED').length,
      created: results.reduce((total, result) => total + result.created, 0),
      updated: results.reduce((total, result) => total + result.updated, 0),
    },
  };
}

/** Portefeuilles EVM (maquette) : deux chaînes, un avertissement de RPC. */
export const MOCK_WALLETS: readonly WalletStatusDto[] = [
  {
    accountId: 'acc-wallet-e2e',
    name: 'MetaMask — watch-only',
    address: '0xe2e0000000000000000000000000000000000001',
    chains: [
      { chain: 'ethereum', tokens: 1, valueEur: 5000, lastSyncedAt: '2026-09-21T06:12:00Z', lastBlock: 20_000_000, error: null },
      { chain: 'base', tokens: 1, valueEur: 1500, lastSyncedAt: '2026-09-21T06:12:00Z', lastBlock: 12_000_000, error: null },
    ],
    tokenCount: 2,
    valueEur: 6500,
    lastSyncedAt: '2026-09-21T06:12:00Z',
    error: null,
  },
];

/** Retour d'une resynchronisation de wallet (maquette). */
export function mockWalletResync(accountId: string): { outcome: SyncOutcomeDto; wallet: WalletStatusDto } | null {
  const wallet = MOCK_WALLETS.find((item) => item.accountId === accountId);
  if (wallet === undefined) return null;
  return {
    outcome: outcome('metamask', accountId, 'SUCCESS', { created: 0, updated: 2, skipped: 0, errors: 0 }, 1500),
    wallet,
  };
}
