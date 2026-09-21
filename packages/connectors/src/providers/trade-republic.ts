/**
 * Connecteur Trade Republic — STRICTEMENT READ-ONLY.
 *
 * Aucune méthode d'ordre n'est exposée. Trade Republic n'offre pas d'API
 * publique : la voie fiable est l'export CSV produit par l'application
 * (« Relevé de compte » / transactions) ou par un outil local tel que `pytr`.
 *
 * Deux dispositions sont reconnues :
 *
 * 1. `trade-republic-csv-de` — export franc-tireur de type pytr
 *    (`Datum;Typ;Wert;Notiz;ISIN;Stück;Gebühren;Steuern;ISIN2;Stück2`).
 *    Entêtes VÉRIFIÉES sur le fichier `pytr/tests/all_events_test_golden.csv`
 *    du dépôt `pytr`. C'est un export local, pas un export officiel Trade
 *    Republic — le format officiel de l'app n'a PAS été vérifié ici.
 *
 * 2. `trade-republic-csv-en` — export en anglais
 *    (`datetime,date,account_type,category,type,asset_class,name,symbol,shares,
 *     price,amount,fee,tax,currency,original_amount,original_currency,fx_rate,
 *     description,transaction_id,counterparty_name,counterparty_iban,
 *     payment_reference,mcc_code`).
 *    Entêtes issues du schéma `libtraderepublic/src/schema.ts`. ATTENTION : le
 *    projet tiers qui publie ce schéma signale lui-même que certaines formes de
 *    lignes ne sont pas vérifiées sur un export réel. À traiter comme
 *    UNVERIFIED tant qu'un export officiel n'a pas été comparé : le lecteur est
 *    tolérant et signale les colonnes absentes.
 *
 * ---------------------------------------------------------------------------
 * MODE API : NON IMPLÉMENTÉ — UNVERIFIED.
 * `capabilities.api = false`. Les points d'entrée observés dans `pytr`
 * (`https://api.traderepublic.com/api/v2/auth/web/login`, `/api/v2/auth/account`)
 * exigent un appareil enregistré et une confirmation dans l'application mobile :
 * cette étape humaine n'est jamais contournée. Une future implémentation devra
 * lever `ConnectorError(kind: 'MFA_REQUIRED')` et ne jamais tenter de rejouer la
 * validation de l'app.
 */

import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type ConnectionTestResult,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedIncome,
  type NormalizedPosition,
  type NormalizedTransaction,
  type SidecarFailure,
  type SidecarTransport,
  type SyncCursor,
  type SyncStatusReport,
  type SyncWindow,
} from '../connector.ts';
import type { ActivityType } from '@suiviinvest/core';
import { detectActivityType } from '@suiviinvest/core';
import type { FieldSpec } from '../csv.ts';
import {
  createCsvFormat,
  isIncomeType,
  pushActivity,
  readCurrency,
  readDate,
  readNumber,
  readQuantity,
  readText,
  rejectRow,
  slug,
  warnOnce,
  type CsvRowContext,
} from './shared.ts';

const PROVIDER_ID = 'trade_republic' as const;
const DEFAULT_BASE = 'trade-republic';
const RAW_SOURCE_EN = 'trade_republic.transactions_csv_en';
const RAW_SOURCE_DE = 'trade_republic.transactions_csv_de';

const f = (...candidates: string[]): FieldSpec => ({ candidates });

/* ------------------------------------------------ format anglais (libtraderepublic) */

const FIELDS_EN: Readonly<Record<string, FieldSpec>> = {
  datetime: f('datetime', 'date_time', 'timestamp'),
  date: f('date', 'booking_date', 'datum'),
  accountType: f('account_type'),
  category: f('category', 'categorie', 'kategorie'),
  type: f('type', 'typ'),
  assetClass: f('asset_class', 'assetclass', 'asset class'),
  name: f('name', 'instrument', 'product'),
  symbol: f('symbol', 'isin'),
  shares: f('shares', 'quantity', 'quantite'),
  price: f('price', 'unit_price', 'cours'),
  amount: f('amount', 'montant', 'wert'),
  fee: f('fee', 'fees', 'gebuehren', 'gebühren'),
  tax: f('tax', 'taxes', 'steuern'),
  currency: f('currency', 'devise', 'waehrung'),
  originalAmount: f('original_amount'),
  originalCurrency: f('original_currency'),
  fxRate: f('fx_rate'),
  description: f('description', 'notiz', 'note'),
  transactionId: f('transaction_id'),
  counterpartyName: f('counterparty_name'),
  mccCode: f('mcc_code'),
};

/** Correspondance `category|type` de Trade Republic -> type canonique. */
const EN_TYPE_MAP: Readonly<Record<string, ActivityType>> = {
  'TRADING|BUY': 'BUY',
  'TRADING|SELL': 'SELL',
  'TRADING|SAVINGS_PLAN': 'BUY',
  'CASH|DIVIDEND': 'DIVIDEND',
  'CASH|INTEREST_PAYMENT': 'INTEREST',
  'CASH|CARD_TRANSACTION': 'BANK_EXPENSE',
  'CASH|CARD_TRANSACTION_INTERNATIONAL': 'BANK_EXPENSE',
  'CASH|TRANSFER_INSTANT_INBOUND': 'TRANSFER_IN',
  'CASH|TRANSFER_INSTANT_OUTBOUND': 'TRANSFER_OUT',
  'CASH|TRANSFER_INBOUND': 'TRANSFER_IN',
  'CASH|TRANSFER_OUTBOUND': 'TRANSFER_OUT',
  'CASH|TRANSFER_DIRECT_DEBIT_INBOUND': 'TRANSFER_OUT',
  'CORPORATE_ACTION|LIQUIDATION_PROCEEDS': 'SELL',
  'CORPORATE_ACTION|SPLIT': 'SPLIT',
  'CORPORATE_ACTION|STOCK_SPLIT': 'SPLIT',
};

/**
 * « Saveback » Trade Republic : récompense en espèces non liée à un titre. Le
 * vocabulaire canonique range les récompenses sous `STAKING_REWARD`
 * (`ACTIVITY_LABEL_MAP` : `reward` -> `STAKING_REWARD`), ce qui la place bien
 * dans le seau « revenus » ; c'est un choix documenté, pas une équivalence TR.
 */
const SAVEBACK_TYPE: ActivityType = 'STAKING_REWARD';

/** Signe de repli quand la catégorie est un transfert. */
function transferBySign(amount: number | null): ActivityType {
  if (amount === null) return 'TRANSFER_OUT';
  return amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN';
}

function classifyTradeRepublicEn(
  category: string,
  type: string,
  description: string,
  amount: number | null,
  hasQuantity: boolean,
): ActivityType | null {
  const key = `${category.toUpperCase()}|${type.toUpperCase()}`;
  if (key === 'CASH|BENEFITS_SAVEBACK') return SAVEBACK_TYPE;
  const direct = EN_TYPE_MAP[key];
  if (direct) return direct;
  if (category.toUpperCase() === 'CASH' && type.toUpperCase().startsWith('TRANSFER')) {
    return transferBySign(amount);
  }
  return detectActivityType(`${category} ${type} ${description}`, { amount, hasQuantity });
}

function parseEnRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const category = readText(record, mapping, 'category') ?? '';
  const type = readText(record, mapping, 'type') ?? '';
  const description = readText(record, mapping, 'description') ?? `${category} ${type}`;
  const accountId = `${row.accountId}-${category.toUpperCase() === 'CASH' ? 'cash' : 'securities'}`;

  const date = readDate(record, mapping, 'date') ?? readDate(record, mapping, 'datetime');
  if (!date) {
    rejectRow(acc, line, 'Date illisible (colonnes « date » et « datetime » absentes ou invalides)');
    return;
  }

  const amount = readNumber(record, mapping, 'amount');
  const shares = readQuantity(record, mapping, 'shares');
  const price = readNumber(record, mapping, 'price');
  const currency = readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR';

  const activityType = classifyTradeRepublicEn(category, type, description, amount, shares !== null);
  if (!activityType) {
    rejectRow(acc, line, `Type d'activité indéterminé pour « ${category}|${type} »`);
    return;
  }

  if (amount === null) {
    // Une ligne d'information sans montant (ex. adresse modifiée) n'est pas une
    // activité financière : signalée, jamais convertie en 0.
    warnOnce(
      acc,
      'Lignes Trade Republic sans montant (informations de compte) ignorées : ' +
        'seule une activité avec un flux de trésorerie est importée.',
    );
    return;
  }

  const fee = readNumber(record, mapping, 'fee');
  const tax = readNumber(record, mapping, 'tax');
  const isin = readText(record, mapping, 'symbol');
  const name = readText(record, mapping, 'name');

  pushActivity(acc, {
    accountId,
    date,
    type: activityType,
    description,
    amount,
    currency,
    rawSourceType: RAW_SOURCE_EN,
    externalTransactionId: readText(record, mapping, 'transactionId'),
    externalAssetId: isin,
    quantity: shares,
    unitPrice: price,
    fees: fee === null ? 0 : Math.abs(fee),
    taxes: tax === null ? 0 : Math.abs(tax),
  });

  // Garde-fou de lisibilité : un instrument nommé avec une quantité mais sans
  // ISIN restera non rapprochable côté market data.
  if (isin === null && shares !== null && isIncomeType(activityType) === false) {
    warnOnce(
      acc,
      `Instrument sans ISIN pour « ${name ?? description} » : rapprochement market data impossible, ` +
        'la quantité est conservée telle quelle.',
    );
  }
}

const EN_FORMAT = createCsvFormat({
  id: 'trade-republic-csv-en',
  label: 'Trade Republic — export transactions (anglais)',
  signature: ['datetime', 'category', 'type', 'amount', 'transaction_id', 'name', 'shares'],
  fields: FIELDS_EN,
  defaultAccountExternalId: DEFAULT_BASE,
  parseRow: parseEnRow,
});

/* ----------------------------------------------- format allemand (pytr) */

const FIELDS_DE: Readonly<Record<string, FieldSpec>> = {
  datum: f('datum', 'date'),
  typ: f('typ', 'type'),
  wert: f('wert', 'value', 'amount', 'montant'),
  notiz: f('notiz', 'note', 'description'),
  isin: f('isin', 'symbol', 'wkn'),
  stueck: f('stück', 'stueck', 'shares', 'quantite', 'quantité'),
  gebuehren: f('gebühren', 'gebuehren', 'fees', 'fee'),
  steuern: f('steuern', 'taxes', 'tax'),
};

const DE_TYPE_MAP: Readonly<Record<string, ActivityType>> = {
  kauf: 'BUY',
  verkauf: 'SELL',
  dividende: 'DIVIDEND',
  zinsen: 'INTEREST',
  einlage: 'DEPOSIT',
  auszahlung: 'WITHDRAWAL',
  split: 'SPLIT',
  steuer: 'TAX',
  gebuehr: 'FEE',
};

function classifyTradeRepublicDe(
  typ: string,
  notiz: string,
  amount: number | null,
  hasQuantity: boolean,
): ActivityType | null {
  const folded = typ
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const direct = DE_TYPE_MAP[folded];
  if (direct) return direct;
  if (folded.startsWith('ubertrag') || folded.startsWith('umbuchung')) {
    return transferBySign(amount);
  }
  return detectActivityType(`${typ} ${notiz}`, { amount, hasQuantity });
}

function parseDeRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const typ = readText(record, mapping, 'typ') ?? '';
  const notiz = readText(record, mapping, 'notiz') ?? '';
  const isin = readText(record, mapping, 'isin');

  const date = readDate(record, mapping, 'datum');
  if (!date) {
    rejectRow(acc, line, `Date illisible dans la colonne « Datum »`);
    return;
  }

  const amount = readNumber(record, mapping, 'wert');
  if (amount === null) {
    rejectRow(acc, line, `Montant illisible dans la colonne « Wert » : « ${readText(record, mapping, 'wert') ?? ''} »`);
    return;
  }

  const shares = readQuantity(record, mapping, 'stueck');
  const activityType = classifyTradeRepublicDe(typ, notiz, amount, shares !== null);
  if (!activityType) {
    rejectRow(acc, line, `Type d'activité indéterminé pour « ${typ} »`);
    return;
  }

  // L'export pytr ne porte pas de devise : elle est supposée EUR. Signalé
  // explicitement pour que l'utilisateur puisse corriger via le mapping.
  warnOnce(
    acc,
    "L'export pytr ne contient pas de colonne devise : EUR est supposé pour toutes les lignes. " +
      'Précisez la devise via le mapping de colonnes si nécessaire.',
  );

  const fee = readNumber(record, mapping, 'gebuehren');
  const tax = readNumber(record, mapping, 'steuern');

  pushActivity(acc, {
    accountId: row.accountId,
    date,
    type: activityType,
    description: notiz === '' ? typ : notiz,
    amount,
    currency: 'EUR',
    rawSourceType: RAW_SOURCE_DE,
    externalTransactionId: null,
    externalAssetId: isin,
    quantity: shares,
    unitPrice:
      shares !== null && shares !== 0 && activityType !== 'SPLIT'
        ? Math.abs(amount) / shares
        : null,
    fees: fee === null ? 0 : Math.abs(fee),
    taxes: tax === null ? 0 : Math.abs(tax),
  });
}

const DE_FORMAT = createCsvFormat({
  id: 'trade-republic-csv-de',
  label: 'Trade Republic — export local (allemand, type pytr)',
  signature: ['Datum', 'Typ', 'Wert', 'Stück'],
  fields: FIELDS_DE,
  defaultAccountExternalId: DEFAULT_BASE,
  parseRow: parseDeRow,
});

/* ================================================================== MODE API */
/*
 * Synchronisation par sidecar Python (`pytr`, import en lecture seule). Aucune
 * méthode d'ordre (`market_order`, `limit_order`, `stop_market_order`) n'est
 * référencée : le sidecar n'expose que `test`, `portfolio`, `cash`, `positions`,
 * `transactions`, `income`, `savingsplans`.
 *
 * Authentification : la validation se fait dans l'application mobile (ou par code
 * à 4 chiffres). Le sidecar renvoie `MFA_REQUIRED` avec `requiresUserAction: true`
 * et le message « Validation Trade Republic requise » ; il REPREND ensuite la
 * synchronisation grâce à la session/cookie exportée par `pytr` (jamais par un mot
 * de passe conservé en clair — voir docs/connectors/sidecars.md).
 *
 * Les identifiants sont lus à la demande (`ctx.secrets`) et transmis DANS la
 * requête du sidecar ; ce module n'écrit rien sur disque et ne journalise aucune
 * valeur secrète.
 */

const SIDECAR_NAME = 'trade-republic';
const RAW_SOURCE_API = 'trade_republic.api';
const ACCOUNT_SECURITIES = 'trade-republic-securities';
const ACCOUNT_CASH = 'trade-republic-cash';

/** Noms logiques des secrets lus pour le sidecar (préfixés par SyncService). */
const API_SECRET_NAMES = ['phone', 'pin', 'session', 'verify_code', 'two_factor_code'] as const;

const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'AUTH_REQUIRED',
  'MFA_REQUIRED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'PROVIDER_BROKEN',
  'PROVIDER_DOWN',
  'SYNC_ERROR',
  'NETWORK',
  'DATA',
  'NOT_SUPPORTED',
]);

/** Types de revenus Trade Republic -> canonique (clés passées par `slug`). */
const TR_INCOME_TYPE_MAP: Readonly<Record<string, NormalizedIncome['type']>> = {
  dividend: 'DIVIDEND',
  dividendpayment: 'DIVIDEND',
  cashdividend: 'DIVIDEND',
  interest: 'INTEREST',
  interestpayment: 'INTEREST',
  interestpayout: 'INTEREST',
  benefitsaveback: 'STAKING_REWARD',
  saveback: 'STAKING_REWARD',
};

/* ------------------------------------------ formes attendues du sidecar */

export interface TradeRepublicSidecarAccount {
  readonly id: string | number;
  readonly name?: string;
  readonly currency?: string;
  readonly type?: string;
  readonly balance?: number | null;
}

export interface TradeRepublicSidecarBalance {
  readonly accountId?: string | number;
  readonly date?: string;
  readonly cash: number;
  readonly currency?: string;
}

export interface TradeRepublicSidecarPosition {
  readonly accountId?: string | number;
  readonly isin?: string | null;
  readonly symbol?: string | null;
  readonly name?: string;
  readonly quantity: number;
  readonly price?: number | null;
  readonly currency?: string;
  readonly kind?: string;
}

export interface TradeRepublicSidecarTransaction {
  readonly accountId?: string | number;
  readonly id?: string | null;
  readonly date: string;
  readonly category?: string | null;
  readonly type?: string | null;
  readonly description?: string | null;
  readonly name?: string | null;
  readonly isin?: string | null;
  readonly quantity?: number | null;
  readonly price?: number | null;
  readonly amount: number;
  readonly currency?: string;
  readonly fees?: number | null;
  readonly taxes?: number | null;
}

export interface TradeRepublicSidecarIncome {
  readonly accountId?: string | number;
  readonly id?: string | null;
  readonly date: string;
  readonly type?: string | null;
  readonly description?: string | null;
  readonly amount: number;
  readonly currency?: string;
  readonly withholdingTax?: number | null;
}

export interface TradeRepublicSidecarSavingsPlan {
  readonly id?: string | null;
  readonly isin?: string | null;
  readonly name?: string | null;
  readonly amount: number;
  readonly interval?: string | null;
  readonly currency?: string;
  readonly active?: boolean;
}

/** Plan d'épargne normalisé (lecture seule ; hors du contrat `Connector`). */
export interface NormalizedSavingsPlan {
  readonly externalAccountId: string;
  readonly externalAssetId: string | null;
  readonly isin: string | null;
  readonly name: string;
  readonly amount: number;
  readonly interval: string;
  readonly currency: string;
  readonly active: boolean;
  readonly rawSourceType: string;
}

/* ------------------------------------------------ résolution du transport */

let registeredSidecar: SidecarTransport | null = null;

function activeSidecar(ctx: ConnectorContext): SidecarTransport | null {
  const fromContext = ctx.sidecars?.[SIDECAR_NAME];
  if (fromContext) return fromContext.isAvailable() ? fromContext : null;
  return registeredSidecar && registeredSidecar.isAvailable() ? registeredSidecar : null;
}

function apiUnavailableError(method: string): ConnectorError {
  const labels = [EN_FORMAT, DE_FORMAT].map((format) => `${format.label} [${format.id}]`).join(' | ');
  return new ConnectorError(
    PROVIDER_ID,
    'NOT_SUPPORTED',
    `${method} n'est pas disponible en automatique : le sidecar « trade-republic » n'est pas ` +
      `configuré. Ce connecteur fonctionne par import de fichier (formats : ${labels}). ` +
      'Pour activer la synchronisation automatique, installez le sidecar Python Trade Republic ' +
      '(voir docs/connectors/sidecars.md et sidecar/README.md) puis définissez ' +
      'SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND ou SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_URL.',
  );
}

function toConnectorError(operation: string, failure: SidecarFailure): ConnectorError {
  const kind: ConnectorError['kind'] = KNOWN_FAILURE_CODES.has(failure.code)
    ? (failure.code as ConnectorError['kind'])
    : 'PROVIDER_BROKEN';
  const message = failure.message || `Le sidecar Trade Republic a échoué pendant « ${operation} ».`;
  return new ConnectorError(PROVIDER_ID, kind, message);
}

async function collectSecrets(ctx: ConnectorContext): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const name of API_SECRET_NAMES) {
    const value = await ctx.secrets.get(`trade_republic_${name}`);
    if (value !== null && value !== '') secrets[name] = value;
  }
  return secrets;
}

async function callSidecar<T>(
  ctx: ConnectorContext,
  sidecar: SidecarTransport,
  operation: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await sidecar.call<T>({
    operation,
    params,
    secrets: await collectSecrets(ctx),
  });
  if (!response.ok) throw toConnectorError(operation, response);
  for (const warning of response.warnings ?? []) {
    ctx.logger.warn(`Sidecar Trade Republic : ${warning}`);
  }
  return response.data;
}

function expectArray<T>(data: unknown, key: string, operation: string): readonly T[] {
  if (data === null || typeof data !== 'object') {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      `Sidecar Trade Republic : opération « ${operation} » sans objet de données exploitable.`,
    );
  }
  const value = (data as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      `Sidecar Trade Republic : champ « ${key} » absent ou non tableau pour « ${operation} ».`,
    );
  }
  return value as readonly T[];
}

/* ------------------------------------------------------------- normalisation */

export function trAccountExternalId(raw: string | number): string {
  return `trade-republic-${String(raw)}`;
}

function accountIdOf(raw: string | number | undefined, kind: 'cash' | 'securities'): string {
  if (raw === undefined || raw === null || raw === '') {
    return kind === 'cash' ? ACCOUNT_CASH : ACCOUNT_SECURITIES;
  }
  return trAccountExternalId(raw);
}

function isSecuritiesType(type: ActivityType): boolean {
  return type === 'BUY' || type === 'SELL' || type === 'SPLIT';
}

function normalizeApiAccount(raw: TradeRepublicSidecarAccount): NormalizedAccount {
  const folded = slug(raw.type ?? '');
  const isCash = folded.includes('cash');
  return {
    externalAccountId: trAccountExternalId(raw.id),
    name: raw.name?.trim() || (isCash ? 'Compte espèces Trade Republic' : 'Portefeuille Trade Republic'),
    type: isCash ? 'CASH' : 'SECURITIES',
    currency: readCurrencyValue(raw.currency),
    rawSourceType: RAW_SOURCE_API,
    balance: typeof raw.balance === 'number' ? raw.balance : null,
  };
}

function readCurrencyValue(value: string | undefined): string {
  const trimmed = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : 'EUR';
}

function normalizeApiBalance(raw: TradeRepublicSidecarBalance, now: Date): NormalizedBalance {
  return {
    externalAccountId: accountIdOf(raw.accountId, 'cash'),
    date: readDateValue(raw.date, now),
    cash: raw.cash,
    currency: readCurrencyValue(raw.currency),
    rawSourceType: RAW_SOURCE_API,
  };
}

function readDateValue(value: string | undefined, now: Date): string {
  const trimmed = (value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return now.toISOString().slice(0, 10);
}

function normalizeApiPosition(raw: TradeRepublicSidecarPosition): NormalizedPosition {
  const isin = raw.isin?.trim() || null;
  return {
    externalAccountId: accountIdOf(raw.accountId, 'securities'),
    externalAssetId: isin,
    isin,
    symbol: raw.symbol?.trim() || null,
    name: raw.name?.trim() || isin || 'Titre Trade Republic',
    kind: mapTrAssetKind(raw.kind),
    quantity: raw.quantity,
    unitPrice: typeof raw.price === 'number' ? raw.price : null,
    currency: readCurrencyValue(raw.currency),
    rawSourceType: RAW_SOURCE_API,
  };
}

function mapTrAssetKind(raw: string | undefined): NormalizedPosition['kind'] {
  switch (slug(raw ?? '')) {
    case 'etf':
      return 'ETF';
    case 'fund':
      return 'FUND';
    case 'stock':
    case 'equity':
      return 'EQUITY';
    case 'crypto':
      return 'CRYPTO';
    case 'synthetic':
      return 'OTHER';
    default:
      return 'OTHER';
  }
}

function normalizeApiTransaction(raw: TradeRepublicSidecarTransaction): NormalizedTransaction | null {
  const date = readDateValue(raw.date, new Date(0));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw.date.trim() === '') return null;
  const description = raw.description ?? raw.type ?? '';
  const category = raw.category ?? '';
  const type = raw.type ?? '';
  const quantity = raw.quantity ?? null;
  const activityType = classifyTradeRepublicEn(
    category,
    type,
    description,
    raw.amount,
    quantity !== null,
  );
  if (!activityType) return null;
  const kind = isSecuritiesType(activityType) ? 'securities' : 'cash';
  return {
    externalAccountId: accountIdOf(raw.accountId, kind),
    externalTransactionId: raw.id?.trim() || null,
    externalAssetId: raw.isin?.trim() || null,
    date,
    type: activityType,
    description: description.trim() || `${category} ${type}`.trim() || 'Opération Trade Republic',
    quantity,
    unitPrice: typeof raw.price === 'number' ? raw.price : null,
    amount: raw.amount,
    currency: readCurrencyValue(raw.currency),
    fees: Math.abs(raw.fees ?? 0),
    taxes: Math.abs(raw.taxes ?? 0),
    rawSourceType: RAW_SOURCE_API,
  };
}

function classifyTrIncome(raw: TradeRepublicSidecarIncome): NormalizedIncome['type'] | null {
  const mapped = raw.type ? TR_INCOME_TYPE_MAP[slug(raw.type)] : undefined;
  if (mapped) return mapped;
  const detected = detectActivityType(`${raw.type ?? ''} ${raw.description ?? ''}`, {
    amount: raw.amount,
    hasQuantity: false,
  });
  return detected && isIncomeType(detected) ? detected : null;
}

function normalizeApiIncome(raw: TradeRepublicSidecarIncome): NormalizedIncome | null {
  const date = readDateValue(raw.date, new Date(0));
  if (raw.date.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const type = classifyTrIncome(raw);
  if (!type) return null;
  return {
    externalAccountId: accountIdOf(raw.accountId, 'cash'),
    externalTransactionId: raw.id?.trim() || null,
    date,
    type,
    description: raw.description?.trim() || raw.type?.trim() || 'Revenu Trade Republic',
    amount: raw.amount,
    currency: readCurrencyValue(raw.currency),
    withholdingTax: Math.abs(raw.withholdingTax ?? 0),
    rawSourceType: RAW_SOURCE_API,
  };
}

/* -------------------------------------------------------------- connecteur */

interface TrPortfolioData {
  readonly accounts?: readonly TradeRepublicSidecarAccount[];
  readonly positions?: readonly TradeRepublicSidecarPosition[];
}
interface TrCashData {
  readonly balances?: readonly TradeRepublicSidecarBalance[];
}
interface TrPositionsData {
  readonly positions?: readonly TradeRepublicSidecarPosition[];
}
interface TrTransactionsData {
  readonly transactions?: readonly TradeRepublicSidecarTransaction[];
  readonly cursor?: string | null;
}
interface TrIncomeData {
  readonly income?: readonly TradeRepublicSidecarIncome[];
}
interface TrSavingsPlansData {
  readonly savingsPlans?: readonly TradeRepublicSidecarSavingsPlan[];
}

export interface TradeRepublicConnector extends Connector {
  /** Branche (ou débranche) le sidecar Python utilisé pour la synchronisation réseau. */
  configureSidecar(transport: SidecarTransport | null): void;
}



export const tradeRepublicConnector: TradeRepublicConnector = {
  id: PROVIDER_ID,
  displayName: 'Trade Republic',
  /**
   * `capabilities.api` vaut `true` SEULEMENT si un sidecar Trade Republic est
   * disponible (déclaré par `createSidecarTransports` via `configureSidecar`).
   */
  get capabilities() {
    const api = registeredSidecar?.isAvailable() ?? false;
    return {
      accounts: true,
      balances: true,
      // Un relevé de mouvements n'est pas un état de portefeuille ; l'API (sidecar) en fournit.
      positions: api,
      transactions: true,
      income: true,
      api,
    };
  },
  importFormats: [EN_FORMAT, DE_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  /** Déclare (ou retire) le sidecar Trade Republic utilisé pour la synchronisation réseau. */
  configureSidecar(transport: SidecarTransport | null): void {
    registeredSidecar = transport && transport.isAvailable() ? transport : null;
  },

  async testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) {
      return {
        ok: true,
        status: 'DISCONNECTED',
        message:
          'Connecteur en mode import de fichier : aucune session Trade Republic n\'est ouverte et ' +
          'aucun sidecar n\'est configuré. Exportez les transactions depuis l\'application puis ' +
          'importez le CSV.',
        requiresUserAction: false,
      };
    }
    const response = await sidecar.call<{ library?: string }>({
      operation: 'test',
      secrets: await collectSecrets(ctx),
    });
    if (response.ok) {
      const library = response.data?.library ? ` (bibliothèque ${response.data.library})` : '';
      return {
        ok: true,
        status: 'CONNECTED',
        message: `Sidecar Trade Republic opérationnel${library} : synchronisation en lecture seule disponible.`,
        requiresUserAction: false,
      };
    }
    return {
      ok: false,
      status: isUserActionCode(response.code) ? 'AUTH_REQUIRED' : 'ERROR',
      message: response.message,
      requiresUserAction: response.requiresUserAction === true,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) {
      ctx.logger.info('Trade Republic : synchronisation réseau non disponible (mode fichier).');
      throw apiUnavailableError('syncAccounts');
    }
    const data = await callSidecar<TrPortfolioData>(ctx, sidecar, 'portfolio');
    if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
      return data.accounts.map(normalizeApiAccount);
    }
    // Repli : dériver les comptes des positions (espèces + titres) si le sidecar
    // ne renvoie pas de bloc `accounts`.
    const positions = expectArray<TradeRepublicSidecarPosition>(data, 'positions', 'portfolio');
    if (positions.length === 0) {
      return [];
    }
    return [
      {
        externalAccountId: ACCOUNT_SECURITIES,
        name: 'Portefeuille Trade Republic',
        type: 'SECURITIES',
        currency: 'EUR',
        rawSourceType: RAW_SOURCE_API,
      },
      {
        externalAccountId: ACCOUNT_CASH,
        name: 'Compte espèces Trade Republic',
        type: 'CASH',
        currency: 'EUR',
        rawSourceType: RAW_SOURCE_API,
      },
    ];
  },

  async syncBalances(
    ctx: ConnectorContext,
    _accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncBalances');
    const data = await callSidecar<TrCashData>(ctx, sidecar, 'cash');
    return expectArray<TradeRepublicSidecarBalance>(data, 'balances', 'cash').map((balance) =>
      normalizeApiBalance(balance, ctx.now()),
    );
  },

  async syncPositions(
    ctx: ConnectorContext,
    _accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncPositions');
    const data = await callSidecar<TrPositionsData>(ctx, sidecar, 'positions');
    return expectArray<TradeRepublicSidecarPosition>(data, 'positions', 'positions').map(
      normalizeApiPosition,
    );
  },

  async syncTransactions(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncTransactions');
    const data = await callSidecar<TrTransactionsData>(ctx, sidecar, 'transactions', {
      since: window.since ?? null,
      cursor: window.cursor ?? null,
    });
    const raw = expectArray<TradeRepublicSidecarTransaction>(data, 'transactions', 'transactions');
    const items: NormalizedTransaction[] = [];
    let skipped = 0;
    for (const entry of raw) {
      const normalized = normalizeApiTransaction(entry);
      if (normalized) items.push(normalized);
      else skipped++;
    }
    if (skipped > 0) {
      ctx.logger.warn(
        `Sidecar Trade Republic : ${skipped} transaction(s) ignorée(s) faute de date ou de type exploitable.`,
      );
    }
    return { items, cursor: { value: data.cursor ?? null } };
  },

  async syncIncome(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<readonly NormalizedIncome[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncIncome');
    const data = await callSidecar<TrIncomeData>(ctx, sidecar, 'income', {
      since: window.since ?? null,
    });
    const raw = expectArray<TradeRepublicSidecarIncome>(data, 'income', 'income');
    const items: NormalizedIncome[] = [];
    let skipped = 0;
    for (const entry of raw) {
      const normalized = normalizeApiIncome(entry);
      if (normalized) items.push(normalized);
      else skipped++;
    }
    if (skipped > 0) {
      ctx.logger.warn(
        `Sidecar Trade Republic : ${skipped} revenu(s) ignoré(s) faute de date ou de type exploitable.`,
      );
    }
    return items;
  },

  async getSyncStatus(ctx: ConnectorContext): Promise<SyncStatusReport> {
    const sidecar = activeSidecar(ctx);
    if (sidecar) {
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message:
          'Synchronisation automatique disponible via le sidecar « trade-republic » (lecture seule). ' +
          'Aucune donnée n\'a encore été comparée à un compte réel.',
        requiresUserAction: false,
      };
    }
    return {
      status: 'DISCONNECTED',
      lastSyncAt: null,
      message:
        'Mode import de fichier uniquement. Trade Republic ne publie pas d\'API de lecture : ' +
        'synchronisation réseau indisponible.',
      requiresUserAction: false,
    };
  },
};

function isUserActionCode(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'MFA_REQUIRED' || code === 'SESSION_EXPIRED';
}

/**
 * Plans d'épargne (« savings plans ») — LECTURE SEULE, hors du contrat `Connector`.
 * Renvoie un tableau vide si le sidecar n'est pas configuré.
 */
export async function fetchTradeRepublicSavingsPlans(
  ctx: ConnectorContext,
): Promise<readonly NormalizedSavingsPlan[]> {
  const sidecar = activeSidecar(ctx);
  if (!sidecar) return [];
  const data = await callSidecar<TrSavingsPlansData>(ctx, sidecar, 'savingsplans');
  return expectArray<TradeRepublicSidecarSavingsPlan>(data, 'savingsPlans', 'savingsplans').map(
    (plan): NormalizedSavingsPlan => {
      const isin = plan.isin?.trim() || null;
      return {
        externalAccountId: ACCOUNT_SECURITIES,
        externalAssetId: isin,
        isin,
        name: plan.name?.trim() || isin || 'Plan d\'épargne Trade Republic',
        amount: plan.amount,
        interval: plan.interval?.trim() || 'UNKNOWN',
        currency: readCurrencyValue(plan.currency),
        active: plan.active !== false,
        rawSourceType: RAW_SOURCE_API,
      };
    },
  );
}

/** Surface interne exposée aux tests unitaires. */
export const tradeRepublicInternals = {
  classifyTradeRepublicEn,
  classifyTradeRepublicDe,
  normalizeApiAccount,
  normalizeApiPosition,
  normalizeApiTransaction,
  normalizeApiIncome,
  classifyTrIncome,
  RAW_SOURCE_EN,
  RAW_SOURCE_DE,
  RAW_SOURCE_API,
};
