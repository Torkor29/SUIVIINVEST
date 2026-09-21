/**
 * Connecteur Crédit Agricole — STRICTEMENT READ-ONLY.
 *
 * Aucune méthode d'ordre, de virement ou de prélèvement n'est exposée : le
 * connecteur ne lit que des exports de fichiers.
 *
 * ---------------------------------------------------------------------------
 * AUCUN FORMAT N'EST VÉRIFIÉ — à ajuster quand un export réel sera disponible.
 *
 * Crédit Agricole ne publie aucun format d'export documenté, et les exports de
 * l'espace client varient d'une caisse régionale à l'autre (entêtes, séparateur,
 * encodage, colonnes Débit/Crédit séparées ou montant unique). Les deux lecteurs
 * ci-dessous sont donc volontairement TOLÉRANTS : ils cherchent les colonnes par
 * listes de synonymes, signalent toute colonne obligatoire absente dans
 * `warnings`, et rejettent dans `errors` toute ligne non interprétable plutôt que
 * de produire un 0 silencieux. Aucune correspondance n'a été confirmée sur un
 * vrai export : à valider par l'utilisateur avant de considérer l'import fiable.
 *
 * Deux dispositions reconnues :
 *  - `credit-agricole-operations-csv` : liste d'opérations de compte courant
 *    (Date / Libellé / Montant, ou Date / Libellé / Débit / Crédit).
 *  - `credit-agricole-titres-csv` : état de portefeuille (compte-titres / PEA)
 *    avec ISIN, quantité, cours et valorisation.
 *
 * ---------------------------------------------------------------------------
 * MODE API : NON IMPLÉMENTÉ — UNVERIFIED.
 * `capabilities.api = false`. Crédit Agricole impose une authentification forte
 * (mot de passe + code de sécurité / validation application) et ne fournit
 * aucune API de lecture pour un particulier : cette étape humaine n'est jamais
 * contournée.
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
import type { ActivityType, AssetKind } from '@suiviinvest/core';
import { detectActivityType, foldLabel } from '@suiviinvest/core';
import type { FieldSpec } from '../csv.ts';
import {
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
  warnOnce,
  type CsvRowContext,
} from './shared.ts';

const PROVIDER_ID = 'credit_agricole' as const;
const DEFAULT_ACCOUNT_ID = 'credit-agricole-compte-courant';
const RAW_SOURCE_OPS = 'credit_agricole.operations_csv';
const RAW_SOURCE_TITRES = 'credit_agricole.titres_csv';

const f = (...candidates: string[]): FieldSpec => ({ candidates });

/* ------------------------------------------------------ opérations bancaires */

const FIELDS_OPS: Readonly<Record<string, FieldSpec>> = {
  date: f(
    'date',
    "date de l'opération",
    'date operation',
    "date d'opération",
    'date de valeur',
    'date comptable',
  ),
  valueDate: f('date de valeur', 'valeur'),
  label: f(
    'libellé',
    'libelle',
    "libellé de l'opération",
    'description',
    "nature de l'opération",
    'nature',
    "détail de l'opération",
    'detail',
    'opération',
    'operation',
  ),
  amount: f('montant', 'montant en euros', 'montant euros', 'somme', 'valeur'),
  debit: f('débit', 'debit', 'débit euros', 'debit euros', 'montant débit', 'montant au débit'),
  credit: f('crédit', 'credit', 'crédit euros', 'credit euros', 'montant crédit', 'montant au crédit'),
  currency: f('devise', 'currency', 'monnaie'),
  category: f('catégorie', 'categorie', 'sous-catégorie', 'rubrique', 'categorie de operation'),
};

/** Libellés bancaires français -> type canonique (avant repli sur le socle). */
const CA_LABELS: readonly { match: string; type: ActivityType }[] = [
  { match: 'virementrecu', type: 'TRANSFER_IN' },
  { match: 'virementenvotrefaveur', type: 'TRANSFER_IN' },
  { match: 'virementemis', type: 'TRANSFER_OUT' },
  { match: 'remise', type: 'DEPOSIT' },
  { match: 'depot', type: 'DEPOSIT' },
  { match: 'retrait', type: 'WITHDRAWAL' },
  { match: 'dab', type: 'WITHDRAWAL' },
  { match: 'prelevement', type: 'BANK_EXPENSE' },
  { match: 'cotisation', type: 'FEE' },
  { match: 'commission', type: 'FEE' },
  { match: 'frais', type: 'FEE' },
  { match: 'interet', type: 'INTEREST' },
  { match: 'carte', type: 'BANK_EXPENSE' },
  { match: 'achat', type: 'BANK_EXPENSE' },
  { match: 'paiement', type: 'BANK_EXPENSE' },
  { match: 'cheque', type: 'BANK_EXPENSE' },
];

export function classifyCreditAgricole(label: string, amount: number | null): ActivityType | null {
  const folded = foldLabel(label);
  if (folded.startsWith('prlv')) return 'BANK_EXPENSE';
  for (const entry of CA_LABELS) {
    if (folded.includes(entry.match)) return entry.type;
  }
  return detectActivityType(label, { amount });
}

function parseOperationsRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const label = readText(record, mapping, 'label');
  if (!label) {
    rejectRow(acc, line, 'Libellé absent ou vide : ligne non classable');
    return;
  }

  const date = readDate(record, mapping, 'date') ?? readDate(record, mapping, 'valueDate');
  if (!date) {
    rejectRow(acc, line, `Date illisible pour l'opération « ${label} »`);
    return;
  }

  const direct = readNumber(record, mapping, 'amount');
  const debit = readNumber(record, mapping, 'debit');
  const credit = readNumber(record, mapping, 'credit');

  let amount: number | null = direct;
  if (amount === null && (debit !== null || credit !== null)) {
    // Convention bancaire française : les colonnes Débit/Crédit sont positives,
    // le sens est porté par la colonne.
    amount = (credit ?? 0) - (debit ?? 0);
  }
  if (amount === null) {
    warnOnce(
      acc,
      'Aucune colonne de montant reconnue (ni Montant, ni Débit/Crédit) : ' +
        'les lignes sans montant sont rejetées. Vérifiez le mapping de colonnes.',
    );
    rejectRow(acc, line, `Montant introuvable pour l'opération « ${label} »`);
    return;
  }

  const type = classifyCreditAgricole(label, amount);
  if (!type) {
    rejectRow(acc, line, `Type d'activité indéterminé pour « ${label} » (montant ${amount})`);
    return;
  }

  const category = readText(record, mapping, 'category');
  pushActivity(acc, {
    accountId: row.accountId,
    date,
    type,
    description: category ? `${label} — ${category}` : label,
    amount,
    currency: readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR',
    rawSourceType: RAW_SOURCE_OPS,
    externalTransactionId: null,
    externalAssetId: null,
    quantity: null,
    unitPrice: null,
    fees: type === 'FEE' ? Math.abs(amount) : 0,
    taxes: 0,
  });
}

const OPERATIONS_FORMAT = createCsvFormat({
  id: 'credit-agricole-operations-csv',
  label: 'Crédit Agricole — opérations de compte (CSV, FR)',
  signature: ['date', 'libellé', 'montant'],
  minSignatureRatio: 0.6,
  fields: FIELDS_OPS,
  defaultAccountExternalId: DEFAULT_ACCOUNT_ID,
  parseRow: parseOperationsRow,
});

/* --------------------------------------------------------- état du portefeuille */

const FIELDS_TITRES: Readonly<Record<string, FieldSpec>> = {
  name: f('valeur', 'libellé', 'libelle', 'désignation', 'designation', 'nom', 'support'),
  isin: f('isin', 'code isin', 'code valeur', 'code', 'code instrument'),
  quantity: f('quantité', 'quantite', 'nombre', 'qté', 'qte', 'quantité détenue'),
  unitPrice: f('cours', 'prix unitaire', 'cours unitaire', 'dernier cours', 'prix', 'cours moyen'),
  currency: f('devise', 'currency'),
  valuation: f('valorisation', 'valeur', 'montant', 'montant valorise'),
  nature: f('nature', 'type', 'classe', 'catégorie', 'categorie'),
};

const KIND_KEYWORDS: readonly { match: string; kind: AssetKind }[] = [
  { match: 'etf', kind: 'ETF' },
  { match: 'opcvm', kind: 'FUND' },
  { match: 'sicav', kind: 'FUND' },
  { match: 'fcp', kind: 'FUND' },
  { match: 'fonds', kind: 'FUND' },
  { match: 'obligation', kind: 'BOND' },
  { match: 'action', kind: 'EQUITY' },
  { match: 'monetaire', kind: 'FUND' },
  { match: 'immobilier', kind: 'REAL_ESTATE' },
];

export function inferAssetKind(nature: string | null): AssetKind {
  if (!nature) return 'OTHER';
  const folded = foldLabel(nature);
  for (const entry of KIND_KEYWORDS) {
    if (folded.includes(entry.match)) return entry.kind;
  }
  return 'OTHER';
}

function parseTitresRow(row: CsvRowContext): void {
  const { record, mapping, acc, line } = row;
  const name = readText(record, mapping, 'name');
  const isin = readText(record, mapping, 'isin');
  const quantity = readQuantity(record, mapping, 'quantity');

  if (!name && !isin) {
    rejectRow(acc, line, 'Ni valeur ni code ISIN : ligne de portefeuille inutilisable');
    return;
  }
  if (quantity === null) {
    rejectRow(
      acc,
      line,
      `Quantité absente ou illisible pour « ${name ?? isin ?? '?'} » : ` +
        'la position ne peut pas être créée sans quantité.',
    );
    return;
  }

  const nature = readText(record, mapping, 'nature');
  const unitPrice = readNumber(record, mapping, 'unitPrice');
  const valuation = readNumber(record, mapping, 'valuation');

  if (unitPrice === null && valuation !== null && quantity !== 0) {
    warnOnce(
      acc,
      'Colonne « cours » absente : le prix unitaire est déduit de la valorisation / quantité.',
    );
  }

  pushPosition(acc, {
    accountId: row.accountId,
    name: name ?? (isin as string),
    isin,
    symbol: null,
    quantity,
    unitPrice: unitPrice ?? (valuation !== null && quantity !== 0 ? valuation / quantity : null),
    currency: readCurrency(record, mapping, 'currency', 'EUR') ?? 'EUR',
    kind: inferAssetKind(nature),
    rawSourceType: RAW_SOURCE_TITRES,
    externalAssetId: isin,
  });
}

const TITRES_FORMAT = createCsvFormat({
  id: 'credit-agricole-titres-csv',
  label: 'Crédit Agricole — état de portefeuille titres (CSV, FR)',
  signature: ['isin', 'quantité', 'cours'],
  minSignatureRatio: 0.6,
  fields: FIELDS_TITRES,
  defaultAccountExternalId: 'credit-agricole-compte-titres',
  parseRow: parseTitresRow,
});

/* -------------------------------------------------------------- connecteur */

export const creditAgricoleConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Crédit Agricole',
  capabilities: {
    accounts: true,
    balances: true,
    positions: true,
    transactions: true,
    income: true,
    api: false, // aucun chemin API implémenté (authentification forte obligatoire).
  },
  importFormats: [OPERATIONS_FORMAT, TITRES_FORMAT],
  requiredConfig: [],
  requiredSecrets: [],

  async testConnection(_ctx: ConnectorContext): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: 'DISCONNECTED',
      message:
        'Connecteur en mode import de fichier : Crédit Agricole ne propose pas d\'API de lecture ' +
        'pour un particulier. Exportez les opérations depuis l\'espace client puis importez le CSV.',
      requiresUserAction: false,
    };
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    ctx.logger.info('Crédit Agricole : synchronisation réseau non implémentée (mode fichier).');
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
      message: 'Mode import de fichier uniquement (opérations, portefeuille titres).',
      requiresUserAction: false,
    };
  },
};

/** Surface interne exposée aux tests unitaires. */
export const creditAgricoleInternals = { classifyCreditAgricole, inferAssetKind };
