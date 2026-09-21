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
  type Connector,
  type ConnectorContext,
  type ConnectionTestResult,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedIncome,
  type NormalizedPosition,
  type NormalizedTransaction,
  type SyncCursor,
  type SyncStatusReport,
  type SyncWindow,
} from '../connector.ts';
import type { ActivityType } from '@suiviinvest/core';
import { detectActivityType } from '@suiviinvest/core';
import type { FieldSpec } from '../csv.ts';
import {
  createCsvFormat,
  fileOnlyError,
  isIncomeType,
  pushActivity,
  readCurrency,
  readDate,
  readNumber,
  readQuantity,
  readText,
  rejectRow,
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

/* -------------------------------------------------------------- connecteur */

export const tradeRepublicConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Trade Republic',
  capabilities: {
    accounts: true,
    balances: true,
    positions: false, // un relevé de mouvements n'est pas un état de portefeuille.
    transactions: true,
    income: true,
    api: false, // aucun chemin API implémenté (login appareil + confirmation app).
  },
  importFormats: [EN_FORMAT, DE_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  async testConnection(_ctx: ConnectorContext): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: 'DISCONNECTED',
      message:
        'Connecteur en mode import de fichier : aucune session Trade Republic n\'est ouverte. ' +
        'Exportez les transactions depuis l\'application puis importez le CSV.',
      requiresUserAction: false,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    ctx.logger.info('Trade Republic : synchronisation réseau non implémentée (mode fichier).');
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
      message:
        'Mode import de fichier uniquement. Trade Republic ne publie pas d\'API de lecture : ' +
        'synchronisation réseau indisponible.',
      requiresUserAction: false,
    };
  },
};

/** Surface interne exposée aux tests unitaires. */
export const tradeRepublicInternals = {
  classifyTradeRepublicEn,
  classifyTradeRepublicDe,
  RAW_SOURCE_EN,
  RAW_SOURCE_DE,
};
