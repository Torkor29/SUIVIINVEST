/**
 * Connecteur Revolut — STRICTEMENT READ-ONLY.
 *
 * Aucune méthode de virement, d'échange de devises ou d'ordre n'est exposée.
 *
 * ---------------------------------------------------------------------------
 * Deux exports CSV sont reconnus, sur la base de leur jeu de colonnes public
 * (Revolut les écrit dans son application et sa documentation d'export) :
 *
 *  1. `revolut-account-statement-csv`
 *     `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,
 *      State,Balance`
 *  2. `revolut-trading-statement-csv`
 *     `Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate`
 *
 * VÉRIFICATION : ces jeux d'entêtes sont documentés publiquement et largement
 * reproduits, mais AUCUN n'a été comparé ici à un export Revolut réellement
 * téléchargé. À traiter comme UNVERIFIED tant qu'un export n'a pas été validé :
 * le lecteur cherche les colonnes par synonymes, signale les colonnes absentes
 * dans `warnings` et rejette les lignes ininterprétables dans `errors`.
 * Revolut n'expose par ailleurs AUCUNE API de lecture pour un particulier :
 * `capabilities.api = false`, et le connecteur ne tente aucune connexion.
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
import { detectActivityType, foldLabel } from '@suiviinvest/core';
import type { FieldSpec } from '../csv.ts';
import {
  createCsvFormat,
  fileOnlyError,
  pushActivity,
  readCurrency,
  readDate,
  readNumber,
  readText,
  rejectRow,
  warnOnce,
  type CsvRowContext,
} from './shared.ts';

const PROVIDER_ID = 'revolut' as const;
const DEFAULT_ACCOUNT_ID = 'revolut-compte';
const RAW_SOURCE_ACCOUNT = 'revolut.account_statement_csv';
const RAW_SOURCE_TRADING = 'revolut.trading_statement_csv';

const f = (...candidates: string[]): FieldSpec => ({ candidates });

/* ---------------------------------------------------- relevé de compte */

const FIELDS_ACCOUNT: Readonly<Record<string, FieldSpec>> = {
  type: f('type'),
  product: f('product'),
  startedDate: f('started date', 'started_date', 'date de début'),
  completedDate: f('completed date', 'completed_date', 'date de fin'),
  description: f('description', 'libellé', 'libelle'),
  amount: f('amount', 'montant'),
  fee: f('fee', 'fees', 'frais'),
  currency: f('currency', 'devise'),
  state: f('state', 'statut', 'status'),
  balance: f('balance', 'solde'),
};

/** Libellés du champ `Type` Revolut -> type canonique. */
const REVOLUT_TYPE_MAP: Readonly<Record<string, ActivityType>> = {
  topup: 'DEPOSIT',
  'top up': 'DEPOSIT',
  'card payment': 'BANK_EXPENSE',
  'card refund': 'DEPOSIT',
  'direct debit': 'BANK_EXPENSE',
  'atm': 'WITHDRAWAL',
  cashback: 'STAKING_REWARD',
  reward: 'STAKING_REWARD',
  rewards: 'STAKING_REWARD',
  fee: 'FEE',
  interest: 'INTEREST',
  dividend: 'DIVIDEND',
  salary: 'DEPOSIT',
  refund: 'DEPOSIT',
  tax: 'TAX',
  loan: 'OTHER' as ActivityType,
};

function classifyRevolut(
  type: string,
  description: string,
  amount: number | null,
): ActivityType | null {
  const folded = foldLabel(type);
  // Transferts / échanges : le sens est porté par le signe du montant.
  if (folded === 'transfer' || folded === 'exchange' || folded === 'transferwise') {
    if (amount === null) return null;
    return amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN';
  }
  const direct = REVOLUT_TYPE_MAP[folded];
  if (direct && direct !== ('OTHER' as ActivityType)) return direct;
  return detectActivityType(`${type} ${description}`, { amount });
}

function parseAccountRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const type = readText(record, mapping, 'type') ?? '';
  const description = readText(record, mapping, 'description') ?? type;

  // Un état non final (PENDING, REVERTED, FAILED) est écarté : importer une
  // opération non aboutie fausserait l'historique.
  const state = readText(record, mapping, 'state');
  if (state && state.toUpperCase() !== 'COMPLETED') {
    warnOnce(
      acc,
      `Relevé Revolut : les opérations dont l'état n'est pas COMPLETED (ex. « ${state} ») ` +
        'sont ignorées. Relancez l\'import une fois l\'opération finalisée.',
    );
    return;
  }

  const date = readDate(record, mapping, 'completedDate') ?? readDate(record, mapping, 'startedDate');
  if (!date) {
    rejectRow(acc, line, `Date illisible pour l'opération Revolut « ${description} »`);
    return;
  }

  const amount = readNumber(record, mapping, 'amount');
  if (amount === null) {
    rejectRow(acc, line, `Montant illisible pour l'opération Revolut « ${description} »`);
    return;
  }

  const activityType = classifyRevolut(type, description, amount);
  if (!activityType) {
    rejectRow(acc, line, `Type Revolut indéterminé « ${type} »`);
    return;
  }

  const fee = readNumber(record, mapping, 'fee');

  pushActivity(acc, {
    accountId: row.accountId,
    date,
    type: activityType,
    description: type ? `${description} (${type})` : description,
    amount,
    currency: readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR',
    rawSourceType: RAW_SOURCE_ACCOUNT,
    externalTransactionId: null,
    externalAssetId: null,
    quantity: null,
    unitPrice: null,
    fees: fee === null ? 0 : Math.abs(fee),
    taxes: 0,
  });
}

const ACCOUNT_FORMAT = createCsvFormat({
  id: 'revolut-account-statement-csv',
  label: 'Revolut — relevé de compte (CSV)',
  signature: ['type', 'product', 'started date', 'completed date', 'amount', 'fee', 'currency', 'state'],
  fields: FIELDS_ACCOUNT,
  defaultAccountExternalId: DEFAULT_ACCOUNT_ID,
  parseRow: parseAccountRow,
});

/* ---------------------------------------------------- relevé de trading */

const FIELDS_TRADING: Readonly<Record<string, FieldSpec>> = {
  date: f('date', 'completed date'),
  ticker: f('ticker', 'symbol'),
  type: f('type'),
  quantity: f('quantity', 'quantité', 'quantite'),
  pricePerShare: f('price per share', 'price', 'prix par action'),
  totalAmount: f('total amount', 'amount', 'montant total'),
  currency: f('currency', 'devise'),
  fxRate: f('fx rate', 'taux de change'),
};

function classifyTrading(type: string, description: string, amount: number | null): ActivityType | null {
  const folded = foldLabel(type);
  if (folded === 'buy' || folded === 'market buy' || folded === 'limit buy') return 'BUY';
  if (folded === 'sell' || folded === 'market sell' || folded === 'limit sell') return 'SELL';
  if (folded === 'dividend') return 'DIVIDEND';
  if (folded.includes('custodyfee') || folded === 'fee') return 'FEE';
  if (folded === 'transfer') {
    if (amount === null) return null;
    return amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN';
  }
  return detectActivityType(`${type} ${description}`, { amount, hasQuantity: true });
}

function parseTradingRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const type = readText(record, mapping, 'type') ?? '';
  const ticker = readText(record, mapping, 'ticker');

  const date = readDate(record, mapping, 'date');
  if (!date) {
    rejectRow(acc, line, `Date illisible dans le relevé de trading Revolut (${ticker ?? '?'})`);
    return;
  }

  const quantity = readNumber(record, mapping, 'quantity');
  const price = readNumber(record, mapping, 'pricePerShare');
  const currency = readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR';

  let amount = readNumber(record, mapping, 'totalAmount');
  const activityType0 = classifyTrading(type, ticker ?? '', amount);
  if (amount === null && quantity !== null && price !== null) {
    // Montant absent : dérivé de quantité x prix (jamais 0 silencieux).
    const sign = activityType0 === 'SELL' ? 1 : -1;
    amount = sign * Math.abs(quantity) * Math.abs(price);
    warnOnce(
      acc,
      'Relevé de trading Revolut : colonne « Total Amount » absente ou illisible, ' +
        'le montant est recalculé comme quantité x prix unitaire (signe selon le sens de l\'opération).',
    );
  }
  if (amount === null) {
    rejectRow(acc, line, `Montant introuvable pour l'opération Revolut « ${type} ${ticker ?? ''} »`);
    return;
  }

  const activityType = classifyTrading(type, ticker ?? '', amount);
  if (!activityType) {
    rejectRow(acc, line, `Type de trading Revolut indéterminé « ${type} »`);
    return;
  }

  if (ticker && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(ticker)) {
    warnOnce(
      acc,
      'Relevé de trading Revolut : la colonne « Ticker » ne contient pas d\'ISIN. ' +
        'Les actifs seront rapprochés par symbole, pas par ISIN.',
    );
  }

  pushActivity(acc, {
    accountId: row.accountId,
    date,
    type: activityType,
    description: `${type} ${ticker ?? ''}`.trim(),
    amount,
    currency,
    rawSourceType: RAW_SOURCE_TRADING,
    externalTransactionId: null,
    externalAssetId: null,
    quantity: quantity === null ? null : Math.abs(quantity),
    unitPrice: price === null ? null : Math.abs(price),
    fees: 0,
    taxes: 0,
  });
  void ticker;
}

const TRADING_FORMAT = createCsvFormat({
  id: 'revolut-trading-statement-csv',
  label: 'Revolut — relevé de trading (CSV)',
  signature: ['date', 'ticker', 'type', 'quantity', 'price per share', 'total amount', 'currency'],
  fields: FIELDS_TRADING,
  defaultAccountExternalId: 'revolut-trading',
  parseRow: parseTradingRow,
});

/* -------------------------------------------------------------- connecteur */

export const revolutConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Revolut',
  capabilities: {
    accounts: true,
    balances: true,
    positions: false, // aucun des deux exports ne fournit un état de position.
    transactions: true,
    income: true,
    api: false, // aucune API de lecture personnelle : import de fichier uniquement.
  },
  importFormats: [ACCOUNT_FORMAT, TRADING_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  async testConnection(_ctx: ConnectorContext): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: 'DISCONNECTED',
      message:
        'Connecteur en mode import de fichier : Revolut n\'expose pas d\'API de lecture ' +
        'pour les comptes personnels. Exportez le relevé (CSV) puis importez-le.',
      requiresUserAction: false,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    ctx.logger.info('Revolut : synchronisation réseau non implémentée (mode fichier).');
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
      message: 'Mode import de fichier uniquement (relevé de compte, relevé de trading).',
      requiresUserAction: false,
    };
  },
};

/** Surface interne exposée aux tests unitaires. */
export const revolutInternals = {
  classifyRevolut,
  classifyTrading,
  RAW_SOURCE_ACCOUNT,
  RAW_SOURCE_TRADING,
};