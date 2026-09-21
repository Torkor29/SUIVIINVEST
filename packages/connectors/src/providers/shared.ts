/**
 * Socle commun aux six connecteurs « providers ».
 *
 * Ce fichier ne connaît AUCUN fournisseur : il fournit le moteur d'import CSV
 * tolérant (analyse des colonnes + accumulateur de résultats normalisés) et les
 * petites fabriques de `ImportFormat` que chaque connecteur paramètre avec ses
 * propres entêtes et son propre classement d'activités.
 *
 * Règles appliquées ici et héritées par tous les connecteurs :
 *  - une valeur illisible n'est JAMAIS remplacée par 0 : soit la ligne est
 *    rejetée dans `errors`, soit un avertissement explicite est ajouté ;
 *  - les avertissements sont dédupliqués (`warnOnce`) pour qu'un gros export
 *    n'engendre pas des milliers de lignes identiques ;
 *  - aucun accès réseau, aucun secret : le socle est pur et testable hors ligne.
 */

import {
  ConnectorError,
  type ImportFormat,
  type ImportParseOptions,
  type ImportParseResult,
  type NormalizedAccount,
  type NormalizedIncome,
  type NormalizedPosition,
  type NormalizedTransaction,
} from '../connector.ts';
import {
  autoMap,
  findColumn,
  parseCsv,
  toRecords,
  type ColumnMapping,
  type CsvRecord,
  type FieldSpec,
  type ParsedCsv,
} from '../csv.ts';
import {
  detectActivityType,
  parseAmount,
  parseCurrency,
  parseDate,
  parseQuantity,
  type AccountType,
  type ActivityType,
  type AssetKind,
} from '@suiviinvest/core';

/* ------------------------------------------------------------ accumulateur */

export interface ImportAccumulator {
  readonly transactions: NormalizedTransaction[];
  readonly income: NormalizedIncome[];
  readonly positions: NormalizedPosition[];
  readonly warnings: string[];
  readonly errors: { line: number; reason: string }[];
  /** Avertissements déjà émis (déduplication). */
  readonly seenWarnings: Set<string>;
  /** raison d'erreur -> nombre d'occurrences (pour un message de synthèse). */
  readonly errorCounts: Map<string, number>;
}

export function createAccumulator(seedWarnings: readonly string[] = []): ImportAccumulator {
  const acc: ImportAccumulator = {
    transactions: [],
    income: [],
    positions: [],
    warnings: [],
    errors: [],
    seenWarnings: new Set<string>(),
    errorCounts: new Map<string, number>(),
  };
  for (const warning of seedWarnings) warnOnce(acc, warning);
  return acc;
}

/** Ajoute un avertissement au plus une fois. */
export function warnOnce(acc: ImportAccumulator, message: string): void {
  if (acc.seenWarnings.has(message)) return;
  acc.seenWarnings.add(message);
  acc.warnings.push(message);
}

/** Rejette une ligne avec sa raison exacte : jamais silencieux. */
export function rejectRow(acc: ImportAccumulator, line: number, reason: string): void {
  acc.errors.push({ line, reason });
  acc.errorCounts.set(reason, (acc.errorCounts.get(reason) ?? 0) + 1);
}

export function toResult(
  acc: ImportAccumulator,
  detectedColumns: readonly string[],
  unmappedColumns: readonly string[],
): ImportParseResult {
  return {
    transactions: acc.transactions,
    income: acc.income,
    positions: acc.positions,
    detectedColumns,
    unmappedColumns,
    warnings: acc.warnings,
    errors: acc.errors,
  };
}

/* ----------------------------------------------------- lecture des champs */

export function readText(record: CsvRecord, mapping: ColumnMapping, field: string): string | null {
  const column = mapping[field];
  if (!column) return null;
  const value = record.values[column];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function readNumber(record: CsvRecord, mapping: ColumnMapping, field: string): number | null {
  const raw = readText(record, mapping, field);
  if (raw === null) return null;
  return parseAmount(raw);
}

export function readDate(record: CsvRecord, mapping: ColumnMapping, field: string): string | null {
  const raw = readText(record, mapping, field);
  if (raw === null) return null;
  return parseDate(raw);
}

export function readQuantity(record: CsvRecord, mapping: ColumnMapping, field: string): number | null {
  const raw = readText(record, mapping, field);
  if (raw === null) return null;
  return parseQuantity(raw);
}

export function readCurrency(
  record: CsvRecord,
  mapping: ColumnMapping,
  field: string,
  fallback: string | null = null,
): string | null {
  return parseCurrency(readText(record, mapping, field), fallback);
}

/* -------------------------------------------------------- types d'activité */

const INCOME_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  'DIVIDEND',
  'INTEREST',
  'RENT',
  'STAKING_REWARD',
]);

export function isIncomeType(type: ActivityType): type is NormalizedIncome['type'] {
  return INCOME_TYPES.has(type);
}

export interface ActivityDraft {
  readonly accountId: string;
  readonly date: string;
  readonly type: ActivityType;
  readonly description: string;
  readonly amount: number;
  readonly currency: string;
  readonly rawSourceType: string;
  readonly externalTransactionId?: string | null;
  readonly externalAssetId?: string | null;
  readonly quantity?: number | null;
  readonly unitPrice?: number | null;
  readonly fees?: number;
  readonly taxes?: number;
  /**
   * Taux de change communiqué par la source, s'il existe. Prioritaire sur le taux
   * reconstitué par l'application : c'est celui réellement appliqué à l'opération.
   */
  readonly fxRate?: number | null;
}

/**
 * Route une activité vers `income` ou `transactions` selon son type : les
 * revenus (dividende, intérêt, loyer, staking) ne sont pas dupliqués dans les
 * deux tableaux.
 */
export function pushActivity(acc: ImportAccumulator, draft: ActivityDraft): void {
  const common = {
    externalAccountId: draft.accountId,
    externalTransactionId: draft.externalTransactionId ?? null,
    date: draft.date,
    description: draft.description,
    amount: draft.amount,
    currency: draft.currency,
    rawSourceType: draft.rawSourceType,
    fxRate: draft.fxRate ?? null,
  };

  if (isIncomeType(draft.type)) {
    acc.income.push({
      ...common,
      type: draft.type,
      withholdingTax: draft.taxes ?? 0,
    });
    return;
  }

  acc.transactions.push({
    ...common,
    externalAssetId: draft.externalAssetId ?? null,
    type: draft.type,
    quantity: draft.quantity ?? null,
    unitPrice: draft.unitPrice ?? null,
    fees: draft.fees ?? 0,
    taxes: draft.taxes ?? 0,
  });
}

export interface PositionDraft {
  readonly accountId: string;
  readonly name: string;
  readonly quantity: number;
  readonly currency: string;
  readonly rawSourceType: string;
  readonly kind?: AssetKind;
  readonly isin?: string | null;
  readonly symbol?: string | null;
  readonly externalAssetId?: string | null;
  readonly unitPrice?: number | null;
  readonly chain?: string | null;
  readonly contractAddress?: string | null;
  readonly decimals?: number | null;
}

export function pushPosition(acc: ImportAccumulator, draft: PositionDraft): void {
  acc.positions.push({
    externalAccountId: draft.accountId,
    externalAssetId: draft.externalAssetId ?? draft.isin ?? null,
    isin: draft.isin ?? null,
    symbol: draft.symbol ?? null,
    name: draft.name,
    kind: draft.kind ?? 'OTHER',
    quantity: draft.quantity,
    unitPrice: draft.unitPrice ?? null,
    currency: draft.currency,
    chain: draft.chain ?? null,
    contractAddress: draft.contractAddress ?? null,
    decimals: draft.decimals ?? null,
    rawSourceType: draft.rawSourceType,
  });
}

/* -------------------------------------------------------- analyse du CSV */

export interface ImportAnalysis {
  readonly parsed: ParsedCsv;
  readonly records: readonly CsvRecord[];
  readonly mapping: ColumnMapping;
  readonly detectedColumns: readonly string[];
  readonly unmappedColumns: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Analyse un CSV : entête, délimiteur, mapping de colonnes (explicite si fourni,
 * automatique sinon) et colonnes non utilisées.
 */
export function analyzeCsv(
  content: string,
  spec: Readonly<Record<string, FieldSpec>>,
  options: ImportParseOptions = {},
): ImportAnalysis {
  const parsed = parseCsv(content);
  const warnings: string[] = [];

  if (parsed.header.length === 0) {
    return {
      parsed,
      records: [],
      mapping: {},
      detectedColumns: [],
      unmappedColumns: [],
      warnings: ['Fichier vide ou sans entête exploitable : aucune ligne importée.'],
    };
  }

  const records = toRecords(parsed);
  const mapping: Record<string, string | null> = {};
  const explicit = options.columnMap ?? {};

  if (Object.keys(explicit).length > 0) {
    for (const field of Object.keys(spec)) {
      const wanted = explicit[field];
      if (wanted === undefined || wanted === null || wanted === '') {
        mapping[field] = null;
        continue;
      }
      if (parsed.header.includes(wanted)) {
        mapping[field] = wanted;
        continue;
      }
      const index = findColumn(parsed.header, [wanted]);
      if (index >= 0) {
        mapping[field] = parsed.header[index] as string;
      } else {
        mapping[field] = null;
        warnings.push(`Colonne « ${wanted} » introuvable pour le champ « ${field} ».`);
      }
    }
    for (const field of Object.keys(explicit)) {
      if (!(field in spec)) {
        warnings.push(`Champ de mapping inconnu ignoré : « ${field} ».`);
      }
    }
  } else {
    Object.assign(mapping, autoMap(parsed.header, spec));
  }

  for (const [field, definition] of Object.entries(spec)) {
    if (definition.required && !mapping[field]) {
      warnings.push(
        `Colonne obligatoire introuvable pour « ${field} » (colonnes acceptées : ${definition.candidates.join(', ')}).`,
      );
    }
  }

  const used = new Set(
    Object.values(mapping).filter((value): value is string => typeof value === 'string'),
  );
  const unmappedColumns = parsed.header.filter((cell) => !used.has(cell));

  return {
    parsed,
    records,
    mapping,
    detectedColumns: [...parsed.header],
    unmappedColumns,
    warnings,
  };
}

/* ------------------------------------------------- fabrique d'ImportFormat */

export interface CsvRowContext {
  readonly record: CsvRecord;
  readonly mapping: ColumnMapping;
  readonly accountId: string;
  readonly acc: ImportAccumulator;
  readonly line: number;
}

export interface CsvFormatDefinition {
  readonly id: string;
  readonly label: string;
  /** Entêtes dont la présence caractérise le format (score de détection). */
  readonly signature: readonly string[];
  /** En dessous de ce ratio, le format ne prétend pas reconnaître le fichier. */
  readonly minSignatureRatio?: number;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly parseRow: (row: CsvRowContext) => void;
  readonly defaultAccountExternalId?: string;
}

/**
 * Construit un `ImportFormat` CSV à partir d'une signature d'entêtes et d'une
 * fonction ligne -> activités. La détection est tolérante : elle exige une
 * fraction minimale de la signature (défaut 60 %) et retourne 0 en dessous.
 */
export function createCsvFormat(definition: CsvFormatDefinition): ImportFormat {
  const minRatio = definition.minSignatureRatio ?? 0.6;
  const fallbackAccount = definition.defaultAccountExternalId ?? definition.id;

  return {
    id: definition.id,
    label: definition.label,
    kind: 'CSV',
    detect(content: string): number {
      try {
        const parsed = parseCsv(content);
        if (parsed.header.length === 0 || definition.signature.length === 0) return 0;
        const matched = definition.signature.filter(
          (token) => findColumn(parsed.header, [token]) >= 0,
        ).length;
        if (matched === 0) return 0;
        const ratio = matched / definition.signature.length;
        return ratio >= minRatio ? ratio : 0;
      } catch {
        return 0;
      }
    },
    parse(content: string, options: ImportParseOptions = {}): ImportParseResult {
      const analysis = analyzeCsv(content, definition.fields, options);
      const accountId =
        options.defaultAccountExternalId ?? fallbackAccount;
      const acc = createAccumulator(analysis.warnings);

      for (const record of analysis.records) {
        definition.parseRow({
          record,
          mapping: analysis.mapping,
          accountId,
          acc,
          line: record.line,
        });
      }

      return toResult(acc, analysis.detectedColumns, analysis.unmappedColumns);
    },
  };
}

/* ------------------------------------------------ utilitaires transverses */

/** Raccourci : classement d'activité avec repli sur le signe du montant. */
export function classify(
  label: string | null | undefined,
  options: { amount?: number | null; hasQuantity?: boolean } = {},
): ActivityType | null {
  return detectActivityType(label, options);
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Compte d'une devise de repli quand l'export n'en porte pas. */
export const DEFAULT_FIAT = 'EUR';

/**
 * Erreur standard des connecteurs « mode fichier uniquement » : les méthodes de
 * synchronisation n'ont pas d'API à interroger, l'appelant doit passer par
 * `importFormats`.
 */
export function fileOnlyError(
  providerId: string,
  method: string,
  formats: readonly ImportFormat[],
): ConnectorError {
  const labels = formats.map((format) => `${format.label} [${format.id}]`).join(' | ');
  return new ConnectorError(
    providerId,
    'NOT_SUPPORTED',
    `${method} n'est pas disponible : ce connecteur fonctionne par import de fichier ` +
      `(formats : ${labels}). Utilisez l'assistant d'import plutôt que la synchronisation réseau.`,
  );
}

export function accountOf(
  externalAccountId: string,
  name: string,
  type: AccountType,
  currency: string,
  rawSourceType: string,
): NormalizedAccount {
  return { externalAccountId, name, type, currency, rawSourceType };
}
