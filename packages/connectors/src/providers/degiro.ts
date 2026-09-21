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
  ConnectorError,
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
  type SidecarFailure,
  type SidecarTransport,
  type SyncCursor,
  type SyncStatusReport,
  type SyncWindow,
} from '../connector.ts';
import { parseCsv, toRecords } from '../csv.ts';
import { foldLabel, parseAmount, parseCurrency, parseDate } from '@suiviinvest/core';
import type { AccountType, ActivityType, AssetKind } from '@suiviinvest/core';
import {
  createAccumulator,
  isIncomeType,
  pushActivity,
  rejectRow,
  slug,
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

/* ================================================================== MODE API */
/*
 * Synchronisation par sidecar Python (`degiro-connector`). Strictement LECTURE
 * SEULE : seules les opérations `test`, `accounts`, `balances`, `positions`,
 * `transactions`, `income` sont demandées. Aucune action d'ordre (`check_order`,
 * `confirm_order`, `update_order`, `delete_order`) n'est référencée ici : le
 * sidecar applique lui-même une liste blanche d'actions de lecture.
 *
 * Les identifiants sont lus à la demande (`ctx.secrets`) et transmis DANS la
 * requête du sidecar ; ce module ne les conserve nulle part, n'écrit aucun fichier
 * et ne journalise jamais leur valeur.
 */

const SIDECAR_NAME = 'degiro';
const RAW_SOURCE_API = 'degiro.api';
const DEFAULT_API_ACCOUNT_ID = 'degiro-default';
const API_INT_ACCOUNT_CONFIG = 'degiro_int_account';

/** Noms logiques des secrets lus pour le sidecar (préfixés du côté de SyncService). */
const API_SECRET_NAMES = [
  'username',
  'password',
  'totp_secret_key',
  'one_time_password',
  'in_app_token',
] as const;

/** Types canoniques acceptés dans une réponse d'échec du transport. */
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

/** Libellés du sidecar -> type canonique (le champ `type` est brut, jamais deviné). */
const API_TYPE_MAP: Readonly<Record<string, ActivityType>> = {
  buy: 'BUY',
  achat: 'BUY',
  sell: 'SELL',
  vente: 'SELL',
  dividend: 'DIVIDEND',
  dividende: 'DIVIDEND',
  remboursementdecapital: 'DIVIDEND',
  interest: 'INTEREST',
  interet: 'INTEREST',
  flatexinterestincome: 'INTEREST',
  fee: 'FEE',
  frais: 'FEE',
  fraisdegiro: 'FEE',
  tax: 'TAX',
  impot: 'TAX',
  impots: 'TAX',
  deposit: 'DEPOSIT',
  versementdefonds: 'DEPOSIT',
  withdrawal: 'WITHDRAWAL',
  retrait: 'WITHDRAWAL',
  transferin: 'TRANSFER_IN',
  transferout: 'TRANSFER_OUT',
  split: 'SPLIT',
};

/* ------------------------------------------ formes attendues du sidecar */

export interface DegiroSidecarAccount {
  readonly id: string | number;
  readonly name?: string;
  readonly currency?: string;
  readonly type?: string;
  readonly balance?: number | null;
}

export interface DegiroSidecarBalance {
  readonly accountId: string | number;
  readonly date?: string;
  readonly cash: number;
  readonly currency?: string;
}

export interface DegiroSidecarPosition {
  readonly accountId?: string | number;
  readonly productId?: string | number | null;
  readonly isin?: string | null;
  readonly symbol?: string | null;
  readonly name?: string;
  readonly quantity: number;
  readonly price?: number | null;
  readonly currency?: string;
  readonly kind?: string;
}

export interface DegiroSidecarTransaction {
  readonly accountId?: string | number;
  readonly id?: string | null;
  readonly date: string;
  readonly type?: string | null;
  readonly description?: string | null;
  readonly product?: string | null;
  readonly isin?: string | null;
  readonly quantity?: number | null;
  readonly price?: number | null;
  readonly amount: number;
  readonly currency?: string;
  readonly fees?: number | null;
  readonly taxes?: number | null;
}

export interface DegiroSidecarIncome {
  readonly accountId?: string | number;
  readonly id?: string | null;
  readonly date: string;
  readonly type?: string | null;
  readonly description?: string | null;
  readonly amount: number;
  readonly currency?: string;
  readonly withholdingTax?: number | null;
}

/* ------------------------------------------------ résolution du transport */

let registeredSidecar: SidecarTransport | null = null;

/**
 * Sidecar de lecture actif pour ce connecteur : celui fourni par le contexte
 * (`ctx.sidecars['degiro']`, prioritaire) ou, à défaut, celui déclaré via
 * `configureSidecar` (utilisé par `createSidecarTransports`). `null` = mode fichier.
 */
function activeSidecar(ctx: ConnectorContext): SidecarTransport | null {
  const fromContext = ctx.sidecars?.[SIDECAR_NAME];
  if (fromContext) return fromContext.isAvailable() ? fromContext : null;
  return registeredSidecar && registeredSidecar.isAvailable() ? registeredSidecar : null;
}

/** Message actionnable quand aucune synchronisation automatique n'est branchée. */
function apiUnavailableError(method: string): ConnectorError {
  return new ConnectorError(
    PROVIDER_ID,
    'NOT_SUPPORTED',
    `${method} n'est pas disponible en automatique : le sidecar « degiro » n'est pas configuré. ` +
      `Ce connecteur fonctionne par import de fichier (format : ${ACCOUNT_CSV_FORMAT.label} ` +
      `[${ACCOUNT_CSV_FORMAT.id}]). Pour activer la synchronisation automatique, installez le ` +
      'sidecar Python DEGIRO (voir docs/connectors/sidecars.md et sidecar/README.md) puis ' +
      'définissez SUIVIINVEST_SIDECAR_DEGIRO_COMMAND ou SUIVIINVEST_SIDECAR_DEGIRO_URL.',
  );
}

function toConnectorError(operation: string, failure: SidecarFailure): ConnectorError {
  const code = failure.code;
  const kind: ConnectorError['kind'] = KNOWN_FAILURE_CODES.has(code)
    ? (code as ConnectorError['kind'])
    : 'PROVIDER_BROKEN';
  const message = failure.message || `Le sidecar DEGIRO a échoué pendant « ${operation} ».`;
  return new ConnectorError(PROVIDER_ID, kind, message);
}

async function collectSecrets(ctx: ConnectorContext): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const name of API_SECRET_NAMES) {
    const value = await ctx.secrets.get(`degiro_${name}`);
    if (value !== null && value !== '') secrets[name] = value;
  }
  return secrets;
}

function intAccountParam(ctx: ConnectorContext): Record<string, unknown> {
  const value = ctx.config[API_INT_ACCOUNT_CONFIG];
  return value ? { intAccount: value } : {};
}

async function callSidecar<T>(
  ctx: ConnectorContext,
  sidecar: SidecarTransport,
  operation: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await sidecar.call<T>({
    operation,
    params: { ...intAccountParam(ctx), ...params },
    secrets: await collectSecrets(ctx),
  });
  if (!response.ok) throw toConnectorError(operation, response);
  for (const warning of response.warnings ?? []) {
    ctx.logger.warn(`Sidecar DEGIRO : ${warning}`);
  }
  return response.data;
}

function expectArray<T>(data: unknown, key: string, operation: string): readonly T[] {
  if (data === null || typeof data !== 'object') {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      `Sidecar DEGIRO : opération « ${operation} » sans objet de données exploitable.`,
    );
  }
  const value = (data as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      `Sidecar DEGIRO : champ « ${key} » absent ou non tableau pour « ${operation} ».`,
    );
  }
  return value as readonly T[];
}

/* ------------------------------------------------------------- normalisation */

export function degiroAccountExternalId(raw: string | number): string {
  return `degiro-${String(raw)}`;
}

function mapAccountType(raw: string | undefined): AccountType {
  const folded = slug(raw ?? '');
  if (folded.includes('cash') || folded.includes('espece')) return 'CASH';
  if (folded.includes('crypto')) return 'CRYPTO';
  if (folded.includes('liability') || folded.includes('credit')) return 'LIABILITY';
  return 'SECURITIES';
}

function mapAssetKind(raw: string | undefined): AssetKind {
  switch (slug(raw ?? '')) {
    case 'etf':
      return 'ETF';
    case 'fund':
    case 'mutualfund':
    case 'fonds':
      return 'FUND';
    case 'bond':
    case 'obligation':
      return 'BOND';
    case 'stock':
    case 'equity':
    case 'action':
      return 'EQUITY';
    case 'cash':
      return 'CASH';
    default:
      return 'OTHER';
  }
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function accountIdOf(raw: string | number | undefined): string {
  return raw === undefined || raw === null || raw === ''
    ? DEFAULT_API_ACCOUNT_ID
    : degiroAccountExternalId(raw);
}

function normalizeApiAccount(raw: DegiroSidecarAccount): NormalizedAccount {
  return {
    externalAccountId: degiroAccountExternalId(raw.id),
    name: raw.name?.trim() || `Compte DEGIRO ${String(raw.id)}`,
    type: mapAccountType(raw.type),
    currency: parseCurrency(raw.currency ?? '', 'EUR') ?? 'EUR',
    rawSourceType: RAW_SOURCE_API,
    balance: typeof raw.balance === 'number' ? raw.balance : null,
  };
}

function normalizeApiBalance(raw: DegiroSidecarBalance, now: Date): NormalizedBalance {
  return {
    externalAccountId: degiroAccountExternalId(raw.accountId),
    date: parseDate(raw.date ?? '') ?? isoDay(now),
    cash: raw.cash,
    currency: parseCurrency(raw.currency ?? '', 'EUR') ?? 'EUR',
    rawSourceType: RAW_SOURCE_API,
  };
}

function normalizeApiPosition(raw: DegiroSidecarPosition): NormalizedPosition {
  const isin = raw.isin?.trim() || null;
  return {
    externalAccountId: accountIdOf(raw.accountId),
    externalAssetId: isin ?? (raw.productId !== undefined && raw.productId !== null ? String(raw.productId) : null),
    isin,
    symbol: raw.symbol?.trim() || null,
    name: raw.name?.trim() || isin || 'Titre DEGIRO',
    kind: mapAssetKind(raw.kind),
    quantity: raw.quantity,
    unitPrice: typeof raw.price === 'number' ? raw.price : null,
    currency: parseCurrency(raw.currency ?? '', 'EUR') ?? 'EUR',
    rawSourceType: RAW_SOURCE_API,
  };
}

/** Classement d'une transaction d'API : champ `type` explicite, sinon libellé. */
export function classifyApiTransaction(raw: DegiroSidecarTransaction): ActivityType | null {
  const explicit = raw.type ? API_TYPE_MAP[slug(raw.type)] : undefined;
  if (explicit) return explicit;
  const description = raw.description ?? raw.type ?? '';
  return classifyDegiro(description, raw.product ?? null, raw.amount, raw.quantity != null);
}

function normalizeApiTransaction(raw: DegiroSidecarTransaction): NormalizedTransaction | null {
  const date = parseDate(emitValue(raw.date));
  if (!date) return null;
  const type = classifyApiTransaction(raw);
  if (!type) return null;
  const isTrade = type === 'BUY' || type === 'SELL';
  return {
    externalAccountId: accountIdOf(raw.accountId),
    externalTransactionId: raw.id?.trim() || null,
    externalAssetId: raw.isin?.trim() || null,
    date,
    type,
    description: (raw.description ?? raw.type ?? '').trim() || 'Opération DEGIRO',
    quantity: isTrade ? (raw.quantity ?? null) : null,
    unitPrice: isTrade ? (raw.price ?? null) : null,
    amount: raw.amount,
    currency: parseCurrency(raw.currency ?? '', 'EUR') ?? 'EUR',
    fees: Math.abs(raw.fees ?? 0),
    taxes: Math.abs(raw.taxes ?? 0),
    rawSourceType: RAW_SOURCE_API,
  };
}

function normalizeApiIncome(raw: DegiroSidecarIncome): NormalizedIncome | null {
  const date = parseDate(emitValue(raw.date));
  if (!date) return null;
  const explicit = raw.type ? API_TYPE_MAP[slug(raw.type)] : undefined;
  const candidate =
    explicit ?? classifyDegiro(raw.description ?? '', null, raw.amount, false);
  if (!candidate || !isIncomeType(candidate)) return null;
  return {
    externalAccountId: accountIdOf(raw.accountId),
    externalTransactionId: raw.id?.trim() || null,
    date,
    type: candidate,
    description: (raw.description ?? raw.type ?? '').trim() || 'Revenu DEGIRO',
    amount: raw.amount,
    currency: parseCurrency(raw.currency ?? '', 'EUR') ?? 'EUR',
    withholdingTax: Math.abs(raw.withholdingTax ?? 0),
    rawSourceType: RAW_SOURCE_API,
  };
}

function emitValue(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/* -------------------------------------------------------------- connecteur */

interface DegiroAccountsData {
  readonly accounts?: readonly DegiroSidecarAccount[];
}
interface DegiroBalancesData {
  readonly balances?: readonly DegiroSidecarBalance[];
}
interface DegiroPositionsData {
  readonly positions?: readonly DegiroSidecarPosition[];
}
interface DegiroTransactionsData {
  readonly transactions?: readonly DegiroSidecarTransaction[];
  readonly cursor?: string | null;
}
interface DegiroIncomeData {
  readonly income?: readonly DegiroSidecarIncome[];
}



const SYNC_UNSUPPORTED =
  'Synchronisation directe non implémentée : DEGIRO ne fournit pas d\'API publique ' +
  'documentée et son API interne n\'est pas vérifiée ici. Importez Account.csv.';

export interface DegiroConnector extends Connector {
  /** Branche (ou débranche) le sidecar Python utilisé pour la synchronisation réseau. */
  configureSidecar(transport: SidecarTransport | null): void;
}

export const degiroConnector: DegiroConnector = {
  id: PROVIDER_ID,
  displayName: 'DEGIRO',
  /**
   * `capabilities.api` vaut `true` SEULEMENT si un sidecar DEGIRO est réellement
   * disponible (déclaré via `configureSidecar`, appelé par
   * `createSidecarTransports`). Sans sidecar, le connecteur reste honnêtement
   * limité à l'import de fichier.
   */
  get capabilities() {
    const api = registeredSidecar?.isAvailable() ?? false;
    return {
      accounts: true,
      balances: true,
      // Account.csv ne contient pas de position ; l'API (sidecar) en fournit.
      positions: api,
      transactions: true,
      income: true,
      api,
    };
  },
  importFormats: [ACCOUNT_CSV_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  /** Déclare (ou retire) le sidecar DEGIRO utilisé pour la synchronisation réseau. */
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
          'Connecteur en mode import de fichier : aucune connexion DEGIRO n\'est établie et aucun ' +
          'sidecar n\'est configuré. Importez le relevé de compte (Account.csv) exporté depuis ' +
          'l\'espace client.',
        requiresUserAction: false,
      };
    }
    const response = await sidecar.call<{ library?: string }>({
      operation: 'test',
      params: intAccountParam(ctx),
      secrets: await collectSecrets(ctx),
    });
    if (response.ok) {
      const library = response.data?.library ? ` (bibliothèque ${response.data.library})` : '';
      return {
        ok: true,
        status: 'CONNECTED',
        message: `Sidecar DEGIRO opérationnel${library} : synchronisation en lecture seule disponible.`,
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
      ctx.logger.info(SYNC_UNSUPPORTED);
      throw apiUnavailableError('syncAccounts');
    }
    const data = await callSidecar<DegiroAccountsData>(ctx, sidecar, 'accounts');
    return expectArray<DegiroSidecarAccount>(data, 'accounts', 'accounts').map(normalizeApiAccount);
  },

  async syncBalances(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncBalances');
    const data = await callSidecar<DegiroBalancesData>(ctx, sidecar, 'balances', {
      accountIds: accounts.map((account) => account.externalAccountId),
    });
    return expectArray<DegiroSidecarBalance>(data, 'balances', 'balances').map((balance) =>
      normalizeApiBalance(balance, ctx.now()),
    );
  },

  async syncPositions(
    ctx: ConnectorContext,
    _accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncPositions');
    const data = await callSidecar<DegiroPositionsData>(ctx, sidecar, 'positions');
    return expectArray<DegiroSidecarPosition>(data, 'positions', 'positions').map(
      normalizeApiPosition,
    );
  },

  async syncTransactions(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }> {
    const sidecar = activeSidecar(ctx);
    if (!sidecar) throw apiUnavailableError('syncTransactions');
    const data = await callSidecar<DegiroTransactionsData>(ctx, sidecar, 'transactions', {
      since: window.since ?? null,
      cursor: window.cursor ?? null,
    });
    const raw = expectArray<DegiroSidecarTransaction>(data, 'transactions', 'transactions');
    const items: NormalizedTransaction[] = [];
    let skipped = 0;
    for (const entry of raw) {
      const normalized = normalizeApiTransaction(entry);
      if (normalized) items.push(normalized);
      else skipped++;
    }
    if (skipped > 0) {
      ctx.logger.warn(
        `Sidecar DEGIRO : ${skipped} transaction(s) ignorée(s) faute de date ou de type exploitable.`,
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
    const data = await callSidecar<DegiroIncomeData>(ctx, sidecar, 'income', {
      since: window.since ?? null,
    });
    const raw = expectArray<DegiroSidecarIncome>(data, 'income', 'income');
    const items: NormalizedIncome[] = [];
    let skipped = 0;
    for (const entry of raw) {
      const normalized = normalizeApiIncome(entry);
      if (normalized) items.push(normalized);
      else skipped++;
    }
    if (skipped > 0) {
      ctx.logger.warn(
        `Sidecar DEGIRO : ${skipped} revenu(s) ignoré(s) faute de date ou de type exploitable.`,
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
          'Synchronisation automatique disponible via le sidecar « degiro » (lecture seule). ' +
          'Aucune donnée n\'a encore été comparée à un compte réel.',
        requiresUserAction: false,
      };
    }
    return {
      status: 'DISCONNECTED',
      lastSyncAt: null,
      message:
        'Mode import de fichier uniquement (Account.csv). Aucune synchronisation réseau programmée.',
      requiresUserAction: false,
    };
  },
};

function isUserActionCode(code: string): boolean {
  return code === 'AUTH_REQUIRED' || code === 'MFA_REQUIRED' || code === 'SESSION_EXPIRED';
}

/** Exporté pour les tests : la vérification de signature est testable isolément. */
export const degiroInternals = {
  COLUMN,
  classifyDegiro,
  parseTradeDetails,
  detectDegiroAccountCsv,
  mapAccountType,
  mapAssetKind,
  classifyApiTransaction,
  normalizeApiAccount,
  normalizeApiPosition,
  normalizeApiTransaction,
  normalizeApiIncome,
  RAW_SOURCE_API,
};
