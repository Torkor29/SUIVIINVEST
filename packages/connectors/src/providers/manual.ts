/**
 * Connecteur « manual » — STRICTEMENT READ-ONLY.
 *
 * Saisie et import de données que l'utilisateur fournit lui-même : livrets,
 * comptes sans export, biens immobiliers, positions d'un portefeuille tenu à la
 * main. Aucune connexion, aucun secret, aucune signature : ce connecteur est
 * entièrement hors ligne.
 *
 * ---------------------------------------------------------------------------
 * FORMATS : définis par SuiviInvest, donc VÉRIFIÉS par construction (tests).
 *
 *  1. `manual-activities-csv` — CSV à entêtes stables :
 *     `date,type,account,description,isin,symbol,name,quantity,unit_unit...`
 *     (voir `FIELDS_CSV`). Une ligne dont `type` vaut `POSITION` (insensible à la
 *     casse) crée une position au lieu d'une activité.
 *  2. `manual-activities-json` — document JSON :
 *     `{ "account": {...}, "activities": [...], "positions": [...] }`
 *     Un tableau JSON nu est accepté et traité comme une liste d'activités.
 *
 * Aucun appel réseau n'est possible depuis ce connecteur : `capabilities.api`
 * vaut `false` et toutes les méthodes de synchronisation lèvent
 * `ConnectorError(kind: 'NOT_SUPPORTED')`.
 */

import {
  type Connector,
  type ConnectorContext,
  type ConnectionTestResult,
  type ImportFormat,
  type ImportParseOptions,
  type ImportParseResult,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedIncome,
  type NormalizedPosition,
  type NormalizedTransaction,
  type SyncCursor,
  type SyncStatusReport,
  type SyncWindow,
} from '../connector.ts';
import { redact } from '../connector.ts';
import type { AccountType, ActivityType, AssetKind } from '@suiviinvest/core';
import { detectActivityType, parseDate } from '@suiviinvest/core';
import type { FieldSpec } from '../csv.ts';
import {
  createAccumulator,
  createCsvFormat,
  fileOnlyError,
  pushActivity,
  pushPosition,
  readCurrency,
  readDate,
  readNumber,
  readQuantity,
  readText,
  rejectRow,
  toResult,
  type CsvRowContext,
} from './shared.ts';

const PROVIDER_ID = 'manual' as const;
const DEFAULT_ACCOUNT_ID = 'manual';
const RAW_SOURCE_CSV = 'manual.activities_csv';
const RAW_SOURCE_JSON = 'manual.activities_json';

const f = (...candidates: string[]): FieldSpec => ({ candidates });

/* ------------------------------------------------------------------- CSV */

const FIELDS_CSV: Readonly<Record<string, FieldSpec>> = {
  date: f('date', 'date_operation'),
  type: f('type', 'activity_type'),
  account: f('account', 'compte', 'external_account_id'),
  description: f('description', 'libelle', 'label'),
  isin: f('isin'),
  symbol: f('symbol', 'ticker'),
  name: f('name', 'nom', 'instrument'),
  quantity: f('quantity', 'quantite'),
  unitPrice: f('unit_price', 'prix_unitaire', 'price'),
  amount: f('amount', 'montant'),
  currency: f('currency', 'devise'),
  fees: f('fees', 'frais'),
  taxes: f('taxes', 'impots'),
  kind: f('kind', 'asset_kind'),
  externalTransactionId: f('external_transaction_id', 'id'),
};

const ASSET_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'EQUITY',
  'ETF',
  'FUND',
  'BOND',
  'CRYPTO',
  'CASH',
  'REAL_ESTATE',
  'OTHER',
]);

function toAssetKind(value: string | null): AssetKind {
  if (!value) return 'OTHER';
  const upper = value.trim().toUpperCase() as AssetKind;
  return ASSET_KINDS.has(upper) ? upper : 'OTHER';
}

function parseManualCsvRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const rawType = readText(record, mapping, 'type');
  const accountId = readText(record, mapping, 'account') ?? row.accountId;
  const description = readText(record, mapping, 'description') ?? '';
  const date = readDate(record, mapping, 'date');
  const quantity = readQuantity(record, mapping, 'quantity');
  const unitPrice = readNumber(record, mapping, 'unitPrice');
  const currency = readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR';

  if (!date) {
    rejectRow(acc, line, `Date absente ou illisible dans une ligne manuelle : « ${readText(record, mapping, 'date') ?? ''} »`);
    return;
  }

  // Ligne de position : explicitement marquée par `type=POSITION`.
  if (rawType && rawType.trim().toUpperCase() === 'POSITION') {
    if (quantity === null) {
      rejectRow(acc, line, `Position manuelle « ${description} » sans quantité exploitable.`);
      return;
    }
    const isin = readText(record, mapping, 'isin');
    const name =
      readText(record, mapping, 'name') ?? (description !== '' ? description : null) ?? isin ?? 'Position';
    pushPosition(acc, {
      accountId,
      name,
      isin,
      symbol: readText(record, mapping, 'symbol'),
      quantity,
      unitPrice,
      currency,
      kind: toAssetKind(readText(record, mapping, 'kind')),
      rawSourceType: RAW_SOURCE_CSV,
      externalAssetId: isin,
    });
    return;
  }

  const amount = readNumber(record, mapping, 'amount');
  if (amount === null) {
    rejectRow(acc, line, `Montant absent ou illisible pour l'activité manuelle « ${description} »`);
    return;
  }

  const activityType: ActivityType | null =
    (rawType ? (detectActivityType(rawType, { amount, hasQuantity: quantity !== null }) as ActivityType | null) : null) ??
    detectActivityType(description, { amount, hasQuantity: quantity !== null });

  if (!activityType) {
    rejectRow(acc, line, `Type d'activité manuel indéterminé (type « ${rawType ?? ''} », libellé « ${description} »)`);
    return;
  }

  const fees = readNumber(record, mapping, 'fees');
  const taxes = readNumber(record, mapping, 'taxes');
  const isin = readText(record, mapping, 'isin');
  const externalTransactionId = readText(record, mapping, 'externalTransactionId');

  pushActivity(acc, {
    accountId,
    date,
    type: activityType,
    description: description || activityType,
    amount,
    currency,
    rawSourceType: RAW_SOURCE_CSV,
    externalTransactionId: externalTransactionId ? `manual:${externalTransactionId}` : null,
    externalAssetId: isin,
    quantity,
    unitPrice,
    fees: fees === null ? 0 : Math.abs(fees),
    taxes: taxes === null ? 0 : Math.abs(taxes),
  });
}

const CSV_FORMAT = createCsvFormat({
  id: 'manual-activities-csv',
  label: 'Saisie manuelle — activités et positions (CSV)',
  signature: ['date', 'type', 'description', 'account', 'unit_price', 'amount', 'currency', 'fees', 'taxes'],
  fields: FIELDS_CSV,
  defaultAccountExternalId: DEFAULT_ACCOUNT_ID,
  parseRow: parseManualCsvRow,
});

/* ------------------------------------------------------------------ JSON */

interface ManualAccountJson {
  readonly externalAccountId?: string;
  readonly name?: string;
  readonly type?: string;
  readonly currency?: string;
}

interface ManualActivityJson {
  readonly date?: string;
  readonly type?: string;
  readonly account?: string;
  readonly description?: string;
  readonly isin?: string;
  readonly symbol?: string;
  readonly quantity?: number | string;
  readonly unitPrice?: number | string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly fees?: number | string;
  readonly taxes?: number | string;
  readonly externalTransactionId?: string;
}

interface ManualPositionJson {
  readonly account?: string;
  readonly name?: string;
  readonly isin?: string;
  readonly symbol?: string;
  readonly kind?: string;
  readonly quantity?: number | string;
  readonly unitPrice?: number | string;
  readonly currency?: string;
}

interface ManualDocumentJson {
  readonly account?: ManualAccountJson;
  readonly activities?: readonly ManualActivityJson[];
  readonly positions?: readonly ManualPositionJson[];
}

function numeric(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

const ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'SECURITIES',
  'CASH',
  'CRYPTO',
  'REAL_ESTATE',
  'LIABILITY',
  'OTHER',
]);

export function manualJsonToResult(
  content: string,
  options: ImportParseOptions = {},
): ImportParseResult {
  const acc = createAccumulator();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? redact(error.message) : 'erreur de parsing';
    rejectRow(acc, 0, `JSON invalide : ${message}`);
    return toResult(acc, [], []);
  }

  const document: ManualDocumentJson = Array.isArray(parsed)
    ? { activities: parsed as readonly ManualActivityJson[] }
    : (parsed as ManualDocumentJson);

  if (document === null || typeof document !== 'object') {
    rejectRow(acc, 0, 'Le document doit être un objet { account, activities, positions } ou un tableau d\'activités.');
    return toResult(acc, [], []);
  }

  const accountId =
    options.defaultAccountExternalId ??
    document.account?.externalAccountId ??
    DEFAULT_ACCOUNT_ID;

  (document.activities ?? []).forEach((activity, index) => {
    const line = index + 1;
    const date = activity.date ? parseDate(activity.date) : null;
    if (!date) {
      rejectRow(acc, line, `Activité ${index + 1} : date absente ou illisible.`);
      return;
    }
    const amount = numeric(activity.amount);
    if (amount === null) {
      rejectRow(acc, line, `Activité ${index + 1} (${activity.description ?? '?'}) : montant absent ou illisible.`);
      return;
    }
    const quantity = numeric(activity.quantity);
    const type =
      (activity.type ? (detectActivityType(activity.type, { amount, hasQuantity: quantity !== null }) as ActivityType | null) : null) ??
      detectActivityType(activity.description ?? '', { amount, hasQuantity: quantity !== null });
    if (!type) {
      rejectRow(acc, line, `Activité ${index + 1} : type indéterminable.`);
      return;
    }

    pushActivity(acc, {
      accountId: activity.account ?? accountId,
      date,
      type,
      description: activity.description ?? type,
      amount,
      currency: activity.currency ?? document.account?.currency ?? 'EUR',
      rawSourceType: RAW_SOURCE_JSON,
      externalTransactionId: activity.externalTransactionId ?? null,
      externalAssetId: activity.isin ?? null,
      quantity,
      unitPrice: numeric(activity.unitPrice),
      fees: Math.abs(numeric(activity.fees) ?? 0),
      taxes: Math.abs(numeric(activity.taxes) ?? 0),
    });
  });

  (document.positions ?? []).forEach((position, index) => {
    const line = index + 1;
    const quantity = numeric(position.quantity);
    if (quantity === null) {
      rejectRow(acc, line, `Position ${index + 1} (${position.name ?? '?'}) : quantité absente ou illisible.`);
      return;
    }
    pushPosition(acc, {
      accountId: position.account ?? accountId,
      name: position.name ?? position.symbol ?? position.isin ?? 'Position',
      isin: position.isin ?? null,
      symbol: position.symbol ?? null,
      kind: toAssetKind(position.kind ?? null),
      quantity: Math.abs(quantity),
      unitPrice: numeric(position.unitPrice),
      currency: position.currency ?? document.account?.currency ?? 'EUR',
      rawSourceType: RAW_SOURCE_JSON,
      externalAssetId: position.isin ?? null,
    });
  });

  const detected = document.account
    ? ['account', 'activities', 'positions']
    : Array.isArray(parsed)
      ? ['activities']
      : Object.keys(document);

  return toResult(acc, detected, []);
}

export const manualJsonFormat: ImportFormat = {
  id: 'manual-activities-json',
  label: 'Saisie manuelle — activités et positions (JSON)',
  kind: 'JSON',
  detect(content: string): number {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        const first = parsed[0] as Record<string, unknown> | undefined;
        if (!first || typeof first !== 'object') return 0;
        const keys = Object.keys(first);
        return keys.includes('date') && keys.includes('amount') ? 0.4 : 0;
      }
      if (parsed === null || typeof parsed !== 'object') return 0;
      const document = parsed as ManualDocumentJson;
      let score = 0;
      if (Array.isArray(document.activities)) score += 0.5;
      if (Array.isArray(document.positions)) score += 0.3;
      if (document.account && typeof document.account === 'object') score += 0.2;
      return Math.min(score, 1);
    } catch {
      return 0;
    }
  },
  parse: manualJsonToResult,
};

/** Types de comptes acceptés pour le bloc `account` d'un document manuel. */
export function manualAccount(raw: ManualAccountJson): NormalizedAccount {
  const type = (raw.type ?? 'OTHER').toUpperCase() as AccountType;
  return {
    externalAccountId: raw.externalAccountId ?? DEFAULT_ACCOUNT_ID,
    name: raw.name ?? 'Compte manuel',
    type: ACCOUNT_TYPES.has(type) ? type : 'OTHER',
    currency: (raw.currency ?? 'EUR').toUpperCase(),
    rawSourceType: 'manual.account',
    balance: null,
    isActive: true,
  };
}

/* -------------------------------------------------------------- connecteur */

export const manualConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Saisie manuelle',
  capabilities: {
    accounts: true,
    balances: false, // pas de notion de solde fournisseur : les soldes viennent des activités.
    positions: true,
    transactions: true,
    income: true,
    api: false, // aucun réseau : import de fichier uniquement.
  },
  importFormats: [CSV_FORMAT, manualJsonFormat],
  requiredConfig: [],
  requiredSecrets: [],

  async testConnection(_ctx: ConnectorContext): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: 'DISCONNECTED',
      message: 'Saisie manuelle : aucun fournisseur à contacter. Importez ou saisissez vos activités.',
      requiresUserAction: false,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    ctx.logger.info('Saisie manuelle : pas de synchronisation réseau.');
    throw fileOnlyError(PROVIDER_ID, 'syncAccounts', this.importFormats);
  },

  async syncBalances(
    _ctx: ConnectorContext,
    _accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]> {
    throw fileOnlyError(PROVIDER_ID, 'syncBalances', this.importFormats);
  },

  async syncPositions(
    _ctx: ConnectorContext,
    _accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]> {
    throw fileOnlyError(PROVIDER_ID, 'syncPositions', this.importFormats);
  },

  async syncTransactions(
    _ctx: ConnectorContext,
    _window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }> {
    throw fileOnlyError(PROVIDER_ID, 'syncTransactions', this.importFormats);
  },

  async syncIncome(
    _ctx: ConnectorContext,
    _window: SyncWindow,
  ): Promise<readonly NormalizedIncome[]> {
    throw fileOnlyError(PROVIDER_ID, 'syncIncome', this.importFormats);
  },

  async getSyncStatus(_ctx: ConnectorContext): Promise<SyncStatusReport> {
    return {
      status: 'DISCONNECTED',
      lastSyncAt: null,
      message: 'Saisie manuelle : synchronisation sans objet.',
      requiresUserAction: false,
    };
  },
};

/** Surface interne exposée aux tests unitaires. */
export const manualInternals = {
  toAssetKind,
  numeric,
  manualJsonToResult,
  manualAccount,
  FIELDS_CSV,
};
