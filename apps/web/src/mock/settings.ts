/** Paramètres, santé et historique d'imports de la maquette. */
import type { HealthResponse, ImportHistoryDto, SettingsDto } from '@suiviinvest/api-contract';

export const SETTINGS: SettingsDto = {
  baseCurrency: 'EUR',
  theme: 'system',
  marketDataProviders: ['yahoo', 'coingecko', 'ecb-fx'],
  backup: {
    enabled: true,
    cron: '0 3 * * *',
    directory: '/var/lib/suiviinvest/backups',
    lastBackupAt: '2026-09-21T03:00:12Z',
    retentionDays: 30,
  },
  scheduler: { enabled: true, cron: '*/30 * * * *' },
  snapshotCron: '15 0 * * *',
  security: {
    sessionTtlMinutes: 720,
    argon2Params: 'argon2id, m=64MiB, t=3, p=1',
    encryption: 'AES-256-GCM (clé locale)',
  },
  version: '0.1.0',
  databasePath: '/var/lib/suiviinvest/suiviinvest.db',
};

export const HEALTH: HealthResponse = {
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 486_320,
  database: { ok: true, file: '/var/lib/suiviinvest/suiviinvest.db', migrations: 14 },
  connectors: 5,
  lastSyncAt: '2026-09-21T06:12:09Z',
};

export const IMPORT_HISTORY: readonly ImportHistoryDto[] = [
  { importId: 'imp-318', filename: 'trade_republic_2026-09.csv', formatId: 'trade-republic-csv', accountId: 'acc-tr-cto', importedAt: '2026-09-20T20:41:00Z', created: 42, skipped: 6, errors: 0 },
  { importId: 'imp-317', filename: 'degiro_releve_2026-08.csv', formatId: 'degiro-transactions', accountId: 'acc-degiro-cto', importedAt: '2026-09-01T08:12:00Z', created: 28, skipped: 14, errors: 1 },
  { importId: 'imp-316', filename: 'ca_comptes_2026-08.csv', formatId: 'ca-csv', accountId: 'acc-ca-courant', importedAt: '2026-09-01T07:58:00Z', created: 36, skipped: 0, errors: 0 },
];

export const MARKET_REFRESH = {
  refreshed: 268,
  failed: 3,
  providers: [
    { provider: 'yahoo', instruments: 132, errors: 2 },
    { provider: 'coingecko', instruments: 47, errors: 1 },
    { provider: 'ecb-fx', instruments: 89, errors: 0 },
  ],
  message: '268 cotations actualisées, 3 échecs (instruments illiquides).',
};
