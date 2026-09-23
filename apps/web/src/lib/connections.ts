/**
 * Aides d'affichage des connexions et des synchronisations.
 *
 * Module pur (aucun import React/DOM) : chaque règle est directement testable
 * avec `node --test`. Deux principes non négociables y sont appliqués :
 *  - un état serveur est toujours traduit en français lisible, jamais affiché brut ;
 *  - un message d'erreur technique n'est jamais montré tel quel : on produit une
 *    phrase compréhensible et, à côté, un détail repliable.
 */
import { plural } from '@suiviinvest/core/text';
import type {
  ConnectionDto,
  SyncAllResponse,
  SyncOutcomeDto,
  WalletChainStatusDto,
  WalletStatusDto,
} from '@suiviinvest/api-contract';

/* ------------------------------------------------------------------- sources */

export type SourceGroup = 'bank' | 'broker' | 'crypto';

export interface SourceDefinition {
  readonly providerId: string;
  readonly providerName: string;
  /** Aucun accès automatique possible : import de relevés uniquement. */
  readonly importOnly?: boolean;
  readonly group?: SourceGroup;
  /** Plusieurs connexions possibles (plusieurs wallets, plusieurs banques…). */
  readonly multiple?: boolean;
  /** Une phrase : ce que cette source permet et comment. */
  readonly description?: string;
}

/** Ordre d'affichage des cinq sources historiques (une carte chacune). */
export const SOURCE_ORDER: readonly SourceDefinition[] = [
  { providerId: 'metamask', providerName: 'MetaMask', group: 'crypto', multiple: true },
  { providerId: 'degiro', providerName: 'DEGIRO', group: 'broker' },
  { providerId: 'trade_republic', providerName: 'Trade Republic', group: 'broker' },
  { providerId: 'credit_agricole', providerName: 'Crédit Agricole', importOnly: true, group: 'bank' },
  { providerId: 'revolut', providerName: 'Revolut', importOnly: true, group: 'bank' },
];

/** Catalogue complet, par catégorie, dans l'ordre d'affichage de la page Connexions. */
export const SOURCE_CATALOG: readonly SourceDefinition[] = [
  {
    providerId: 'enable_banking',
    providerName: 'Banques (open banking)',
    group: 'bank',
    multiple: true,
    description: 'Crédit Agricole, Revolut, BNP, Boursorama… : accès officiel en lecture seule, soldes et opérations automatiques.',
  },
  {
    providerId: 'credit_agricole',
    providerName: 'Crédit Agricole (fichier)',
    importOnly: true,
    group: 'bank',
    description: 'Import d’un relevé exporté du site, si vous ne passez pas par l’open banking.',
  },
  {
    providerId: 'revolut',
    providerName: 'Revolut (fichier)',
    importOnly: true,
    group: 'bank',
    description: 'Import d’un relevé exporté de l’application, si vous ne passez pas par l’open banking.',
  },
  {
    providerId: 'degiro',
    providerName: 'DEGIRO',
    group: 'broker',
    description: 'Positions, opérations et dividendes, avec vos identifiants DEGIRO (ou import de Account.csv).',
  },
  {
    providerId: 'trade_republic',
    providerName: 'Trade Republic',
    group: 'broker',
    description: 'Portefeuille, espèces et opérations ; une validation dans l’appli Trade Republic est demandée.',
  },
  {
    providerId: 'metamask',
    providerName: 'Wallet EVM',
    group: 'crypto',
    multiple: true,
    description: 'MetaMask, Rabby, Ledger… sur Ethereum, Base, Arbitrum, Polygon et autres, par adresse publique.',
  },
  {
    providerId: 'bitcoin',
    providerName: 'Bitcoin',
    group: 'crypto',
    multiple: true,
    description: 'Adresses ou clé publique xpub/zpub (Ledger, Trezor, Sparrow…). Aucune clé privée.',
  },
  {
    providerId: 'solana',
    providerName: 'Solana',
    group: 'crypto',
    multiple: true,
    description: 'Phantom, Solflare, Backpack… : SOL et jetons, par adresse publique.',
  },
  {
    providerId: 'binance',
    providerName: 'Binance',
    group: 'crypto',
    multiple: true,
    description: 'Spot, épargne et financement, avec une clé API en lecture seule.',
  },
  {
    providerId: 'kraken',
    providerName: 'Kraken',
    group: 'crypto',
    multiple: true,
    description: 'Soldes et staking, avec une clé API limitée à « Query Funds ».',
  },
  {
    providerId: 'coinbase',
    providerName: 'Coinbase',
    group: 'crypto',
    multiple: true,
    description: 'Tous vos portefeuilles, avec une clé API « View » (lecture seule).',
  },
  {
    providerId: 'bitpanda',
    providerName: 'Bitpanda',
    group: 'crypto',
    multiple: true,
    description: 'Crypto, métaux et portefeuilles en euros, avec une clé API en lecture seule.',
  },
];

export const SOURCE_GROUPS: readonly { readonly id: SourceGroup; readonly title: string; readonly subtitle: string }[] = [
  { id: 'bank', title: 'Banques', subtitle: 'Comptes courants et livrets, mis à jour automatiquement.' },
  { id: 'broker', title: 'Bourse', subtitle: 'Courtiers : actions, ETF, dividendes.' },
  { id: 'crypto', title: 'Crypto', subtitle: 'Wallets et plateformes, toujours en lecture seule.' },
];

export type ConnectionStateKey =
  | 'NOT_CONFIGURED'
  | 'CONNECTED'
  | 'RUNNING'
  | 'SYNCED'
  | 'AUTH_REQUIRED'
  | 'IMPORT_REQUIRED'
  | 'ERROR'
  | 'DISCONNECTED'
  | 'UNKNOWN';

export interface ConnectionState {
  readonly key: ConnectionStateKey;
  readonly label: string;
  readonly tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
}

const STATES: Readonly<Record<ConnectionStateKey, ConnectionState>> = {
  NOT_CONFIGURED: { key: 'NOT_CONFIGURED', label: 'Non configuré', tone: 'neutral' },
  CONNECTED: { key: 'CONNECTED', label: 'Connecté', tone: 'ok' },
  RUNNING: { key: 'RUNNING', label: 'En cours', tone: 'info' },
  SYNCED: { key: 'SYNCED', label: 'Synchronisé', tone: 'ok' },
  AUTH_REQUIRED: { key: 'AUTH_REQUIRED', label: 'Validation requise', tone: 'warn' },
  IMPORT_REQUIRED: { key: 'IMPORT_REQUIRED', label: 'Import requis', tone: 'warn' },
  ERROR: { key: 'ERROR', label: 'Erreur', tone: 'danger' },
  DISCONNECTED: { key: 'DISCONNECTED', label: 'Non connecté', tone: 'neutral' },
  UNKNOWN: { key: 'UNKNOWN', label: 'État inconnu', tone: 'neutral' },
};

/** Traduit un statut serveur (`SyncStatus`) en état d'interface. */
export function connectionStateOf(status: string | null | undefined): ConnectionState {
  switch ((status ?? '').toUpperCase()) {
    case 'CONNECTED':
      return STATES.CONNECTED;
    case 'SYNCING':
    case 'RUNNING':
      return STATES.RUNNING;
    case 'SYNCED':
    case 'OK':
    case 'SUCCESS':
      return STATES.SYNCED;
    case 'AUTH_REQUIRED':
    case 'MFA_REQUIRED':
    case 'SESSION_EXPIRED':
      return STATES.AUTH_REQUIRED;
    case 'IMPORT_ONLY':
    case 'IMPORT_REQUIRED':
    case 'NOT_SUPPORTED':
      return STATES.IMPORT_REQUIRED;
    case 'ERROR':
    case 'FAILED':
      return STATES.ERROR;
    case 'DISCONNECTED':
    case '':
      return STATES.DISCONNECTED;
    default:
      return STATES.UNKNOWN;
  }
}

/** État d'une source : `null` de connexion signifie « jamais configurée ». */
export function sourceStateOf(connection: ConnectionDto | null | undefined): ConnectionState {
  if (connection === null || connection === undefined) return STATES.NOT_CONFIGURED;
  return connectionStateOf(connection.status);
}

/** Vrai seulement si le serveur atteste une connexion établie (aucune supposition). */
export function isConnected(connection: ConnectionDto | null | undefined): boolean {
  if (connection === null || connection === undefined) return false;
  const state = connectionStateOf(connection.status);
  return state.key === 'CONNECTED' || state.key === 'SYNCED';
}

/* -------------------------------------------------------------------- dates */

/** ISO -> Date (UTC), `null` si la valeur est inexploitable. */
function parseDate(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * « il y a X » à partir d'une date ISO. Le « maintenant » est injectable pour
 * que les tests soient déterministes.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parseDate(iso);
  if (date === null) return '—';
  const deltaMs = now - date.getTime();
  if (!Number.isFinite(deltaMs)) return '—';
  if (deltaMs < 0) {
    const ahead = Math.abs(deltaMs);
    if (ahead < 60_000) return 'dans quelques secondes';
    if (ahead < 3_600_000) return `dans ${Math.round(ahead / 60_000)} min`;
    if (ahead < 86_400_000) return `dans ${Math.round(ahead / 3_600_000)} h`;
    return `dans ${Math.round(ahead / 86_400_000)} j`;
  }
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 45) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `il y a ${days} j`;
  const months = Math.round(days / 30);
  if (months < 12) return `il y a ${months} mois`;
  return `il y a ${Math.round(months / 12)} an(s)`;
}

/** Date lisible courte : « 21 sept. 2026 ». */
export function readableDate(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (date === null) return '—';
  const months = [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ] as const;
  return `${date.getUTCDate()} ${months[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`.trim();
}

/** « 21 sept. 2026 (il y a 4 h) » ou « jamais synchronisé ». */
export function lastSyncLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (parseDate(iso) === null) return 'jamais synchronisé';
  return `${readableDate(iso)} (${relativeTime(iso, now)})`;
}

/* ------------------------------------------------------------------- durées */

/** Durée de synchronisation telle que lue par un humain : « 4,2 s ». */
export function formatSyncDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${formatDecimal(ms / 1000, 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function formatDecimal(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/* ------------------------------------------------------- retour de synchro */

export type SyncOutcomeLike = Pick<
  SyncOutcomeDto,
  'created' | 'updated' | 'skipped' | 'errors' | 'durationMs' | 'status'
>;

/**
 * Résumé lisible d'un retour de synchronisation :
 * « 37 transactions récupérées, 12 positions mises à jour, 0 doublon créé, durée 4,2 s ».
 */
export function describeSyncOutcome(outcome: SyncOutcomeLike | null | undefined): string {
  if (outcome === null || outcome === undefined) return 'Aucun retour de synchronisation.';
  const parts = [
    plural(Math.max(outcome.created, 0), 'transaction récupérée', 'transactions récupérées'),
    plural(Math.max(outcome.updated, 0), 'position mise à jour', 'positions mises à jour'),
    plural(Math.max(outcome.skipped, 0), 'doublon créé', 'doublons créés'),
  ];
  if (outcome.errors > 0) parts.push(plural(outcome.errors, 'erreur', 'erreurs'));
  parts.push(`durée ${formatSyncDuration(outcome.durationMs)}`);
  return parts.join(', ');
}

/** Libellé d'attente pendant la synchronisation : « Synchronisation DEGIRO… ». */
export function syncRunningLabel(providerName: string): string {
  return `Synchronisation ${providerName}…`;
}

/** Phrase compréhensible pour un code d'erreur de connecteur (`ConnectorError.kind`). */
export function syncErrorHeadline(
  errorCode: string | null | undefined,
  fallback: string | null | undefined = null,
): string {
  switch ((errorCode ?? '').toUpperCase()) {
    case 'AUTH_REQUIRED':
    case 'MFA_REQUIRED':
      return "Validation requise dans l'application du fournisseur : ouvrez-la pour approuver la connexion, puis resynchronisez.";
    case 'SESSION_EXPIRED':
      return 'La session chez le fournisseur a expiré : reconnectez-vous pour reprendre la collecte.';
    case 'RATE_LIMITED':
      return 'Le fournisseur limite temporairement les requêtes : réessayez dans quelques minutes.';
    case 'PROVIDER_DOWN':
      return 'Le service du fournisseur ne répond pas pour le moment : réessayez plus tard.';
    case 'PROVIDER_BROKEN':
      return 'Le fournisseur a modifié son interface : la collecte est suspendue en attendant une mise à jour.';
    case 'NETWORK':
      return 'Connexion au fournisseur impossible depuis cette machine : vérifiez le réseau puis réessayez.';
    case 'DATA':
      return 'Les données reçues du fournisseur sont inexploitables : aucune écriture n’a été faite.';
    case 'NOT_SUPPORTED':
      return 'Ce fournisseur ne propose pas de collecte automatique : importez un relevé à la place.';
    case 'SYNC_ERROR':
      return 'La synchronisation a échoué : le détail technique est replié ci-dessous.';
    default:
      return fallback !== null && fallback !== undefined && fallback.trim() !== ''
        ? fallback
        : 'La synchronisation a échoué.';
  }
}

/** Résumé court d'un retour : « Synchronisé », « Partiel », « Échec »… */
export function syncOutcomeLabel(status: SyncOutcomeDto['status'] | string): string {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'OK';
    case 'PARTIAL':
      return 'Partiel';
    case 'AUTH_REQUIRED':
      return 'Validation requise';
    case 'FAILED':
      return 'Erreur';
    default:
      return 'Import requis';
  }
}

export function syncOutcomeTone(status: string): 'ok' | 'warn' | 'danger' {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'ok';
    case 'PARTIAL':
      return 'warn';
    default:
      return 'danger';
  }
}

/** Vrai si le retour porte des avertissements non bloquants. */
export function hasWarnings(outcome: Pick<SyncOutcomeDto, 'warnings'> | null | undefined): boolean {
  return (outcome?.warnings?.length ?? 0) > 0;
}

/* --------------------------------------------------- synchronisation globale */

export interface SyncAllSummaryView {
  readonly total: number;
  readonly succeeded: number;
  readonly partial: number;
  readonly failed: number;
  readonly authRequired: number;
  readonly created: number;
  readonly updated: number;
  /** Vrai dès qu'au moins un fournisseur a échoué, sans empêcher les autres. */
  readonly hasFailure: boolean;
}

/**
 * Agrège un retour de « Synchroniser tout ».
 *
 * Les compteurs sont recalculés depuis les résultats individuels afin de rester
 * justes même si le serveur renvoie un résumé incomplet.
 */
export function aggregateSyncAll(response: SyncAllResponse | null | undefined): SyncAllSummaryView {
  const results = response?.results ?? [];
  const count = (status: SyncOutcomeDto['status']): number =>
    results.filter((result) => result.status === status).length;
  const created = results.reduce((total, result) => total + Math.max(result.created, 0), 0);
  const updated = results.reduce((total, result) => total + Math.max(result.updated, 0), 0);
  const failed = count('FAILED');
  const authRequired = count('AUTH_REQUIRED');
  return {
    total: results.length || response?.summary.total || 0,
    succeeded: count('SUCCESS'),
    partial: count('PARTIAL'),
    failed,
    authRequired,
    created,
    updated,
    hasFailure: failed > 0 || authRequired > 0,
  };
}

/** Phrase de synthèse : « 4 sources sur 5 ont répondu, 1 validation requise. » */
export function syncAllHeadline(summary: SyncAllSummaryView): string {
  if (summary.total === 0) return 'Aucune connexion à synchroniser.';
  const ok = summary.succeeded + summary.partial;
  const pieces = [`${ok} source(s) sur ${summary.total} ont répondu`];
  pieces.push(`${summary.created} transaction(s) récupérée(s)`);
  pieces.push(`${summary.updated} position(s) mise(s) à jour`);
  if (summary.authRequired > 0) pieces.push(`${summary.authRequired} validation(s) requise(s)`);
  if (summary.failed > 0) pieces.push(`${summary.failed} échec(s)`);
  return `${pieces.join(', ')}.`;
}

/* ------------------------------------------------------------------ wallets */

/** Comptes d'une source : nombre total et valeur récupérée en euros. */
export interface SourceAccountSummary {
  readonly count: number;
  readonly valueEur: number;
  /** Comptes dont la valeur n'est pas libellée en euros (jamais additionnée en silence). */
  readonly foreignCount: number;
}

export interface AccountLike {
  readonly providerId: string;
  readonly connectionId?: string | null;
  readonly value: number;
  readonly valueCurrency: string;
}

/**
 * Agrège les comptes d'un fournisseur.
 *
 * Seules les valeurs libellées en euros sont additionnées : une devise
 * différente est comptée à part, jamais convertie au jugé côté client.
 */
export function summarizeAccounts(
  accounts: readonly AccountLike[],
  providerId: string,
  connectionId?: string | null,
): SourceAccountSummary {
  let count = 0;
  let valueEur = 0;
  let foreignCount = 0;
  for (const account of accounts) {
    if (account.providerId !== providerId) continue;
    if (connectionId !== undefined && connectionId !== null && account.connectionId !== connectionId) continue;
    count += 1;
    if (account.valueCurrency.toUpperCase() === 'EUR') valueEur += account.value;
    else foreignCount += 1;
  }
  return { count, valueEur, foreignCount };
}

/** Nombre de jetons d'un wallet EVM. */
export function walletTokenCount(wallet: WalletStatusDto): number {
  return wallet.tokenCount;
}

/** Chaînes suivies, telles qu'affichées : « ethereum », « base ». */
export function walletChains(wallet: WalletStatusDto): readonly string[] {
  return wallet.chains.map((chain: WalletChainStatusDto) => chain.chain);
}

/** Total en euros d'un wallet : la valeur attestée par le serveur, jamais recalculée. */
export function walletValueEur(wallet: WalletStatusDto): number {
  return wallet.valueEur;
}

/** Message compréhensible pour une erreur d'endpoint wallet (404/401 inclus). */
export function walletEndpointNotice(status: number, code: string | null | undefined): string {
  if (status === 404 || (code ?? '').toUpperCase() === 'NOT_FOUND') {
    return "La vue wallets n'est pas encore disponible sur ce serveur : la page Crypto reste utilisable et rien n'est modifié.";
  }
  if (status === 401 || (code ?? '').toUpperCase() === 'UNAUTHENTICATED') {
    return 'Session expirée : reconnectez-vous pour afficher les portefeuilles.';
  }
  return 'Les portefeuilles ne peuvent pas être affichés pour le moment.';
}
