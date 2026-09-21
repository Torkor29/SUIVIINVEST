/**
 * Connecteur DEGIRO — STRICTEMENT READ-ONLY.
 *
 * Aucune méthode d'ordre, de virement ou de signature n'est exposée : le type
 * `Connector` ne le permet pas et ce fichier n'ajoute rien en dehors de lui.
 *
 * ---------------------------------------------------------------------------
 * MODE PRINCIPAL (implémenté et vérifié) : import du relevé de compte
 * `Account.csv`, celui que l'espace client DEGIRO produit (« Relevé de compte »
 * / « Account statement »).
 *
 * La disposition des colonnes a été vérifiée sur un export réel anonymisé
 * (fixture `libdegiro/test/fixtures/Account.csv` + `Account-en.csv`, projet
 * tiers `libdegiro`) et recoupée avec la table de colonnes du client officieux
 * `Chavithra/degiro-connector` (`DEGIRO_COLUMNS`) :
 *
 *   index 0  Date            (JJ-MM-AAAA)
 *   index 1  Heure           (HH:MM)
 *   index 2  Date de valeur  (non utilisée : le booking date prime)
 *   index 3  Produit
 *   index 4  Code ISIN
 *   index 5  Description
 *   index 6  FX              (taux de change, optionnel)
 *   index 7  Devise          (devise du mouvement)
 *   index 8  Mouvement       (montant signé, séparateur décimal local)
 *   index 9  Devise          (devise du solde)
 *   index 10 Solde           (solde courant après l'opération)
 *   index 11 ID Ordre        (UUID du lot d'ordres, peut être vide)
 *
 * Les entêtes réelles diffèrent seulement par la langue :
 *   FR : Date,Heure,Date de,Produit,Code ISIN,Description,FX,Mouvements,,Solde,,ID Ordre
 *   EN : Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id
 * C'est pourquoi le lecteur est POSITIONNEL et non piloté par les entêtes : les
 * deux cellules de montant n'ont littéralement pas d'entête.
 *
 * ---------------------------------------------------------------------------
 * MODE API : UNVERIFIED — à ajuster quand le format officieux est confirmé.
 *
 * `capabilities.api` vaut donc `false` : le chemin réseau n'est pas implémenté
 * ici. Les points d'entrée observés dans les clients non officiels
 * (`trader.degiro.nl/login/secure/login`, `/pa/secure/client`,
 * `/portfolio-reports/secure/v3/positionReport`,
 * `/portfolio-reports/secure/v4/transactions`) ne sont pas contractuels, ne sont
 * pas documentés par DEGIRO, utilisent une session + cookie JET et déclenchent
 * une validation par SMS ou par application mobile. Aucune de ces étapes n'est
 * contournée : si une connexion API est un jour ajoutée, une confirmation
 * humaine devra lever `ConnectorError(kind: 'MFA_REQUIRED')`.
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
import { parseCsv, toRecords } from '../csv.ts';
import { foldLabel, parseAmount, parseCurrency, parseDate } from '@suiviinvest/core';
import type { ActivityType } from '@suiviinvest/core';
import {
  createAccumulator,
  fileOnlyError,
  pushActivity,
  rejectRow,
  toResult,
  warnOnce,
} from './shared.ts';

const PROVIDER_ID = 'degiro' as const;
const RAW_SOURCE = 'degiro.account_csv';
const DEFAULT_ACCOUNT_ID = 'degiro-compte-especes';

/** Indices de colonnes vérifiés (voir l'entête du fichier). */
const COLUMN = {
  date: 0,
  time: 1,
  valueDate: 2,
  product: 3,
  isin: 4,
  description: 5,
  fx: 6,
  mutationCurrency: 7,
  mutationAmount: 8,
  balanceCurrency: 9,
  balanceAmount: 10,
  orderId: 11,
} as const;

const FR_SIGNATURE = ['Date', 'Heure', 'Produit', 'Code ISIN', 'Description', 'Mouvements', 'Solde'];
const EN_SIGNATURE = ['Date', 'Time', 'Product', 'ISIN', 'Description', 'Change', 'Balance'];

/* ------------------------------------------------------------- classement */

/** Libellés DEGIRO -> type canonique. Ordre significatif (du plus au moins spécifique). */
const DEGIRO_LABELS: readonly { match: string; type: ActivityType }[] = [
  { match: 'fraisdegirodecourtage', type: 'FEE' },
  { match: 'fraisdeconnexion', type: 'FEE' },
  { match: 'flatexinterestincome', type: 'INTEREST' },
  { match: 'impotsurdividende', type: 'TAX' },
  { match: 'impotsdividende', type: 'TAX' },
  { match: 'remboursementdecapital', type: 'DIVIDEND' },
  { match: 'dividende', type: 'DIVIDEND' },
  { match: 'operationdechangecredit', type: 'TRANSFER_IN' },
  { match: 'operationdechangedebit', type: 'TRANSFER_OUT' },
  { match: 'virementdepuis', type: 'TRANSFER_IN' },
  { match: 'virementvers', type: 'TRANSFER_OUT' },
  { match: 'reglementtransactiondevise', type: 'TRANSFER_IN' },
  { match: 'versementdefonds', type: 'DEPOSIT' },
  { match: 'frais', type: 'FEE' },
];

const FX_PAIR = /^[A-Z]{3}\/[A-Z]{3}$/;

/** Classement d'une ligne DEGIRO à partir de sa description et de son produit. */
function classifyDegiro(
  description: string,
  product: string | null,
  amount: number | null,
  _hasQuantity: boolean,
): ActivityType | null {
  if (product && FX_PAIR.test(product.trim())) {
    // Achat/vente d'un pair de devises : ce n'est pas un titre.
    if (amount === null) return null;
    return amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN';
  }

  const folded = foldLabel(description);
  if (folded.includes('degirocashsweeptransfer')) {
    if (amount === null) return null;
    return amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN';
  }
  // Retenue à la source : « Impôts sur dividende » / « Impôt sur dividende » —
  // le libellé varie (singulier/pluriel), on matche sur les deux racines.
  if (folded.includes('impot') && folded.includes('dividende')) return 'TAX';
  for (const entry of DEGIRO_LABELS) {
    if (folded.includes(entry.match)) return entry.type;
  }
  if (folded.startsWith('achat')) return 'BUY';
  if (folded.startsWith('vente')) return 'SELL';
  return null;
}

/* ------------------------------------------- extraction quantité / prix */

const TRADE_PATTERN = /^(?:Achat|Vente)\s+([\d\s.,]+?)\s+(.+?)@([\d\s.,]+)\s*([A-Za-z]{3})?\s*\(([A-Z0-9]*)\)\s*$/;

interface TradeDetails {
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly priceCurrency: string | null;
  readonly instrumentName: string | null;
  readonly isin: string | null;
}

/** Extrait « Achat 42 LIBELLÉ@96,11 CHF (IE00B4L5Y983) » -> quantité/prix/ISIN. */
function parseTradeDetails(description: string): TradeDetails {
  const match = TRADE_PATTERN.exec(description.trim());
  if (!match) {
    return { quantity: null, unitPrice: null, priceCurrency: null, instrumentName: null, isin: null };
  }
  const [, rawQuantity, name, rawPrice, currency, isin] = match;
  return {
    quantity: parseAmount(rawQuantity ?? ''),
    unitPrice: parseAmount(rawPrice ?? ''),
    priceCurrency: currency ? parseCurrency(currency, null) : null,
    instrumentName: (name ?? '').trim() || null,
    isin: (isin ?? '').trim() || null,
  };
}

/* ------------------------------------------------------------- détection */

function signatureScore(header: readonly string[], signature: readonly string[]): number {
  const folded = new Set(header.map((cell) => foldLabel(cell)));
  let matched = 0;
  for (const token of signature) {
    if (folded.has(foldLabel(token))) matched++;
  }
  return matched / signature.length;
}

export function detectDegiroAccountCsv(content: string): number {
  try {
    const parsed = parseCsv(content);
    if (parsed.header.length !== 12) return 0;
    const best = Math.max(
      signatureScore(parsed.header, FR_SIGNATURE),
      signatureScore(parsed.header, EN_SIGNATURE),
    );
    return best >= 0.7 ? best : 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- parser */

function parseDegiroAccountCsv(
  content: string,
  options: ImportParseOptions = {},
): ImportParseResult {
  const parsed = parseCsv(content);
  const acc = createAccumulator();
  const accountId = options.defaultAccountExternalId ?? DEFAULT_ACCOUNT_ID;

  if (parsed.header.length === 0) {
    warnOnce(acc, 'Fichier vide ou sans entête exploitable : aucune ligne importée.');
    return toResult(acc, [], []);
  }
  if (parsed.header.length !== 12) {
    warnOnce(
      acc,
      `Entête de ${parsed.header.length} colonnes au lieu de 12 : la disposition DEGIRO ` +
        'a peut-être changé, vérifiez les colonnes avant de valider l\'import.',
    );
  }
  if (options.columnMap && Object.keys(options.columnMap).length > 0) {
    warnOnce(
      acc,
      'Le relevé DEGIRO est lu par POSITION de colonnes (deux cellules de montant n\'ont pas ' +
        'd\'entête) : le mapping de colonnes fourni est ignoré. Seul ' +
        '« defaultAccountExternalId » est pris en compte.',
    );
  }

  const records = toRecords(parsed);
  for (const record of records) {
    const cells = record.cells;
    const rawDate = cells[COLUMN.date] ?? '';
    const date = parseDate(rawDate);
    if (!date) {
      rejectRow(acc, record.line, `Date illisible : « ${rawDate} »`);
      continue;
    }

    const description = (cells[COLUMN.description] ?? '').trim();
    const product = (cells[COLUMN.product] ?? '').trim() || null;
    const isin = (cells[COLUMN.isin] ?? '').trim() || null;
    const rawAmount = cells[COLUMN.mutationAmount] ?? '';
    const amount = parseAmount(rawAmount);
    const currency =
      parseCurrency(cells[COLUMN.mutationCurrency] ?? '', null) ??
      parseCurrency(cells[COLUMN.balanceCurrency] ?? '', null) ??
      'EUR';

    if (amount === null) {
      // Ligne « miroir » du cash sweep (solde seul, aucun mouvement) : ignorée
      // explicitement plutôt que transformée en 0 silencieux.
      warnOnce(
        acc,
        'Lignes sans montant de mouvement (relevés de solde DEGIRO) ignorées : ' +
          'seules les lignes portant une mutation sont importées.',
      );
      continue;
    }

    const trade = parseTradeDetails(description);
    const hasQuantity = trade.quantity !== null;
    const type = classifyDegiro(description, product, amount, hasQuantity);
    if (!type) {
      rejectRow(acc, record.line, `Type d'activité indéterminé pour « ${description} »`);
      continue;
    }

    const orderId = (cells[COLUMN.orderId] ?? '').trim() || null;
    const externalTransactionId = orderId
      ? `${orderId}:${foldLabel(description)}:${amount}`
      : null;

    pushActivity(acc, {
      accountId,
      date,
      type,
      description: description === '' ? (product ?? 'Opération DEGIRO') : description,
      amount,
      currency,
      rawSourceType: RAW_SOURCE,
      externalTransactionId,
      externalAssetId: isin ?? trade.isin,
      quantity: type === 'BUY' || type === 'SELL' ? trade.quantity : null,
      unitPrice: type === 'BUY' || type === 'SELL' ? trade.unitPrice : null,
      fees: 0, // DEGIRO isole les frais sur des lignes dédiées (type FEE).
      taxes: 0,
    });
  }

  return toResult(acc, [...parsed.header], []);
}

const ACCOUNT_CSV_FORMAT: ImportFormat = {
  id: 'degiro-account-csv',
  label: 'DEGIRO — relevé de compte (Account.csv, FR/EN)',
  kind: 'CSV',
  detect: detectDegiroAccountCsv,
  parse: parseDegiroAccountCsv,
};

/* -------------------------------------------------------------- connecteur */

const SYNC_UNSUPPORTED =
  'Synchronisation directe non implémentée : DEGIRO ne fournit pas d\'API publique ' +
  'documentée et son API interne n\'est pas vérifiée ici. Importez Account.csv.';

export const degiroConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'DEGIRO',
  capabilities: {
    accounts: true,
    balances: true,
    positions: false, // Account.csv ne contient pas de position (Portfolio.csv, non vérifié ici).
    transactions: true,
    income: true,
    // Chemin API non implémenté / non vérifié : le connecteur est « fichier ».
    api: false,
  },
  importFormats: [ACCOUNT_CSV_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  async testConnection(_ctx: ConnectorContext): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: 'DISCONNECTED',
      message:
        'Connecteur en mode import de fichier : aucune connexion DEGIRO n\'est établie. ' +
        'Importez le relevé de compte (Account.csv) exporté depuis l\'espace client.',
      requiresUserAction: false,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    ctx.logger.info(SYNC_UNSUPPORTED);
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
        'Mode import de fichier uniquement (Account.csv). Aucune synchronisation réseau programmée.',
      requiresUserAction: false,
    };
  },
};

/** Exporté pour les tests : la vérification de signature est testable isolément. */
export const degiroInternals = {
  COLUMN,
  classifyDegiro,
  parseTradeDetails,
  detectDegiroAccountCsv,
};
