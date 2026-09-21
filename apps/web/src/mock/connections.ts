/** Connexions bancaires et historique de synchronisation (maquette). */
import type { ConnectionDto, SyncRunDto } from '@suiviinvest/api-contract';

export const CONNECTIONS: readonly ConnectionDto[] = [
  {
    id: 'conn-ca',
    providerId: 'credit-agricole',
    providerName: 'Crédit Agricole',
    label: 'Comptes CA — espace perso',
    status: 'OK',
    lastSyncedAt: '2026-09-21T05:30:00Z',
    lastError: null,
    requiresUserAction: false,
    needsReauth: false,
    config: { region: 'Centre-Est', accountTypes: 'CASH,SAVINGS' },
    secretNames: ['CA_LOGIN', 'CA_PASSWORD'],
    capabilities: { accounts: true, balances: true, positions: false, transactions: true, income: true, api: false },
    importFormats: [{ id: 'ca-csv', label: 'Export CSV Crédit Agricole', kind: 'CSV' }],
  },
  {
    id: 'conn-degiro',
    providerId: 'degiro',
    providerName: 'DEGIRO',
    label: 'DEGIRO — compte-titres',
    status: 'OK',
    lastSyncedAt: '2026-09-21T05:42:00Z',
    lastError: null,
    requiresUserAction: false,
    needsReauth: false,
    config: { environment: 'production' },
    secretNames: ['DEGIRO_USERNAME', 'DEGIRO_TOTP_SECRET'],
    capabilities: { accounts: true, balances: true, positions: true, transactions: true, income: true, api: false },
    importFormats: [{ id: 'degiro-transactions', label: 'DEGIRO Transactions.csv', kind: 'CSV' }],
  },
  {
    id: 'conn-revolut',
    providerId: 'revolut',
    providerName: 'Revolut',
    label: 'Revolut — comptes multi-devises',
    status: 'AUTH_REQUIRED',
    lastSyncedAt: '2026-09-18T19:05:00Z',
    lastError: 'Jeton expiré : réauthentification nécessaire.',
    requiresUserAction: true,
    needsReauth: true,
    config: { devices: '2' },
    secretNames: ['REVOLUT_ACCESS_TOKEN'],
    capabilities: { accounts: true, balances: true, positions: false, transactions: false, income: false, api: true },
    importFormats: [],
  },
  {
    id: 'conn-metamask',
    providerId: 'metamask',
    providerName: 'MetaMask',
    label: 'MetaMask — watch-only',
    status: 'OK',
    lastSyncedAt: '2026-09-21T06:12:00Z',
    lastError: null,
    requiresUserAction: false,
    needsReauth: false,
    config: { networks: 'ethereum,arbitrum,polygon,solana' },
    secretNames: ['ALCHEMY_API_KEY'],
    capabilities: { accounts: true, balances: true, positions: true, transactions: true, income: false, api: true },
    importFormats: [],
  },
  {
    id: 'conn-tr',
    providerId: 'trade-republic',
    providerName: 'Trade Republic',
    label: 'Trade Republic — export relevés',
    status: 'IMPORT_ONLY',
    lastSyncedAt: '2026-09-12T09:10:00Z',
    lastError: 'Aucune API publique : import de relevés uniquement.',
    requiresUserAction: false,
    needsReauth: false,
    config: {},
    secretNames: [],
    capabilities: { accounts: false, balances: false, positions: false, transactions: false, income: false, api: false },
    importFormats: [
      { id: 'trade-republic-csv', label: 'Relevé de compte Trade Republic', kind: 'CSV' },
      { id: 'trade-republic-pdf', label: 'Relevé annuel Trade Republic', kind: 'PDF' },
    ],
  },
];

export const PROVIDER_CATALOG: readonly {
  providerId: string;
  providerName: string;
  implemented: boolean;
  apiSupported: boolean;
  importFormats: readonly string[];
  requiredConfig: readonly string[];
  requiredSecrets: readonly string[];
  notes: string;
}[] = [
  { providerId: 'credit-agricole', providerName: 'Crédit Agricole', implemented: true, apiSupported: false, importFormats: ['ca-csv'], requiredConfig: ['region'], requiredSecrets: ['CA_LOGIN', 'CA_PASSWORD'], notes: 'Lecture seule, collecte via export de comptes.' },
  { providerId: 'degiro', providerName: 'DEGIRO', implemented: true, apiSupported: false, importFormats: ['degiro-transactions'], requiredConfig: ['environment'], requiredSecrets: ['DEGIRO_USERNAME', 'DEGIRO_TOTP_SECRET'], notes: 'Expiration fréquente des sessions : jeton de sécurité requis.' },
  { providerId: 'trade-republic', providerName: 'Trade Republic', implemented: true, apiSupported: false, importFormats: ['trade-republic-csv', 'trade-republic-pdf'], requiredConfig: [], requiredSecrets: [], notes: 'Pas d’API publique : import de relevés uniquement.' },
  { providerId: 'revolut', providerName: 'Revolut', implemented: true, apiSupported: true, importFormats: [], requiredConfig: ['devices'], requiredSecrets: ['REVOLUT_ACCESS_TOKEN'], notes: 'API en lecture seule, jeton personnel à renouveler.' },
  { providerId: 'metamask', providerName: 'MetaMask', implemented: true, apiSupported: true, importFormats: [], requiredConfig: ['networks'], requiredSecrets: ['ALCHEMY_API_KEY'], notes: 'Adresses en observation seule (aucune signature de transaction).' },
  { providerId: 'autres', providerName: 'Autres', implemented: false, apiSupported: false, importFormats: [], requiredConfig: [], requiredSecrets: [], notes: 'Saisie manuelle et imports génériques.' },
];

export const SYNC_RUNS: readonly SyncRunDto[] = [
  { syncRunId: 'run-1042', providerId: 'metamask', connectionId: 'conn-metamask', trigger: 'SCHEDULED', startedAt: '2026-09-21T06:12:00Z', finishedAt: '2026-09-21T06:12:09Z', status: 'SUCCESS', created: 12, updated: 4, skipped: 2, errors: 0, durationMs: 9120, message: null },
  { syncRunId: 'run-1041', providerId: 'degiro', connectionId: 'conn-degiro', trigger: 'SCHEDULED', startedAt: '2026-09-21T05:42:00Z', finishedAt: '2026-09-21T05:42:14Z', status: 'PARTIAL', created: 62, updated: 3, skipped: 41, errors: 2, durationMs: 14300, message: '2 instruments sans cotation : valeurs conservées.' },
  { syncRunId: 'run-1040', providerId: 'credit-agricole', connectionId: 'conn-ca', trigger: 'SCHEDULED', startedAt: '2026-09-21T05:30:00Z', finishedAt: '2026-09-21T05:30:21Z', status: 'SUCCESS', created: 34, updated: 0, skipped: 12, errors: 0, durationMs: 21120, message: null },
  { syncRunId: 'run-1039', providerId: 'revolut', connectionId: 'conn-revolut', trigger: 'MANUAL', startedAt: '2026-09-18T19:05:00Z', finishedAt: '2026-09-18T19:05:02Z', status: 'AUTH_REQUIRED', created: 0, updated: 0, skipped: 0, errors: 1, durationMs: 2400, message: 'Jeton expiré : réauthentification nécessaire.' },
];
