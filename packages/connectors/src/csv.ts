import { parseAmount, parseCurrency, parseDate, parseQuantity } from '@suiviinvest/core';

/**
 * Lecture CSV générique.
 *
 * Écrit à la main plutôt qu'avec une librairie : les exports financiers réels
 * (DEGIRO, Trade Republic, Revolut, CA) ont des particularités qu'aucun parser
 * standard ne gère toutes — délimiteur variable (`,` `;` `\t`), BOM UTF-8,
 * guillemets échappés, lignes de préambule avant les entêtes, champs multi-lignes.
 */

export interface ParsedCsv {
  readonly delimiter: string;
  readonly header: readonly string[];
  /** Lignes de données, chacune exactement de la longueur de l'entête. */
  readonly rows: readonly string[][];
  /** Numéro de ligne (1-based) dans le fichier d'origine, pour le message d'erreur. */
  readonly lineNumbers: readonly number[];
  /** Lignes ignorées avant l'entête (préambule des exports bancaires). */
  readonly preambleLines: readonly string[];
}

export interface ParseCsvOptions {
  /** Force le délimiteur au lieu de le détecter. */
  readonly delimiter?: string;
  /** Force la ligne d'entête (1-based). Par défaut : détection automatique. */
  readonly headerLine?: number;
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

/** Compte les occurrences d'un caractère hors guillemets (respecte le quoting CSV). */
function countOutsideQuotes(line: string, char: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const current = line[i];
    if (current === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (current === char && !inQuotes) {
      count++;
    }
  }
  return count;
}

export function detectDelimiter(content: string): string {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    // Un bon délimiteur découpe chaque ligne en un nombre de champs constant > 1.
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const nonZero = counts.filter((count) => count > 0);
    if (nonZero.length === 0) continue;
    const average = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
    const variance =
      nonZero.reduce((acc, count) => acc + (count - average) ** 2, 0) / nonZero.length;
    const score = average * nonZero.length - variance * 4;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Découpe une ligne CSV en champs, en gérant guillemets et guillemets échappés. */
export function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Détecte la ligne d'entête : celle qui contient le plus de cellules non
 * numériques et le plus de mots-clés attendus dans un export financier.
 */
function detectHeaderLine(rows: string[][]): number {
  const keywords = [
    'date', 'amount', 'montant', 'quantity', 'quantite', 'isin', 'symbol', 'ticker',
    'description', 'libelle', 'currency', 'devise', 'type', 'price', 'prix', 'fee', 'frais',
    'transaction', 'value', 'valeur', 'change', 'balance', 'solde',
  ];
  let bestIndex = 0;
  let bestScore = -1;
  rows.forEach((row, index) => {
    if (row.length < 2) return;
    const nonNumeric = row.filter((cell) => cell !== '' && parseAmount(cell) === null).length;
    const lowered = row.map((cell) => cell.toLowerCase());
    const matches = keywords.filter((keyword) => lowered.some((cell) => cell.includes(keyword))).length;
    const score = nonNumeric + matches * 3 - index * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function parseCsv(content: string, options: ParseCsvOptions = {}): ParsedCsv {
  const cleaned = content.replace(/^\uFEFF/, '');
  const rawLines = cleaned.split(/\r?\n/);
  const delimiter = options.delimiter ?? detectDelimiter(cleaned);

  const parsed: { fields: string[]; lineNumber: number }[] = [];
  let buffer = '';
  let bufferStartLine = 1;

  rawLines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (buffer === '') bufferStartLine = lineNumber;
    buffer += (buffer === '' ? '' : '\n') + line;
    // Champ multi-lignes : on ne clôt la ligne que si les guillemets sont équilibrés.
    const quotes = (buffer.match(/"/g) ?? []).length;
    if (quotes % 2 !== 0) return;
    const fields = splitLine(buffer, delimiter);
    parsed.push({ fields, lineNumber: bufferStartLine });
    buffer = '';
  });
  if (buffer !== '') parsed.push({ fields: splitLine(buffer, delimiter), lineNumber: bufferStartLine });

  const nonEmpty = parsed.filter((row) => row.fields.some((field) => field !== ''));
  const headerIndex =
    options.headerLine !== undefined
      ? options.headerLine - 1
      : detectHeaderLine(nonEmpty.map((row) => row.fields));

  const headerRow = nonEmpty[headerIndex];
  if (!headerRow) {
    return { delimiter, header: [], rows: [], lineNumbers: [], preambleLines: [] };
  }
  const header = dedupeHeader(headerRow.fields);
  const data = nonEmpty.slice(headerIndex + 1);

  return {
    delimiter,
    header,
    rows: data.map((row) => {
      const fields = [...row.fields];
      while (fields.length < header.length) fields.push('');
      return fields.slice(0, header.length);
    }),
    lineNumbers: data.map((row) => row.lineNumber),
    preambleLines: nonEmpty.slice(0, headerIndex).map((row) => row.fields.join(delimiter)),
  };
}

/** Deux colonnes peuvent porter le même nom : on les suffixe au lieu de les perdre. */
function dedupeHeader(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const base = cell.trim() === '' ? `colonne_${index + 1}` : cell.trim();
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

export interface CsvRecord {
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
  /** Accès brut par index, utile quand l'entête est absente ou non fiable. */
  readonly cells: readonly string[];
}

export function toRecords(parsed: ParsedCsv): CsvRecord[] {
  return parsed.rows.map((row, index) => {
    const values: Record<string, string> = {};
    parsed.header.forEach((name, column) => {
      values[name] = row[column] ?? '';
    });
    return { line: parsed.lineNumbers[index] ?? index + 2, values, cells: row };
  });
}

/** Résolution d'une colonne par liste de noms candidats (insensible à la casse/accents). */
export function findColumn(header: readonly string[], candidates: readonly string[]): number {
  const fold = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  const foldedCandidates = candidates.map(fold);
  for (const candidate of foldedCandidates) {
    const index = header.findIndex((cell) => fold(cell) === candidate);
    if (index >= 0) return index;
  }
  for (const candidate of foldedCandidates) {
    const index = header.findIndex((cell) => fold(cell).includes(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

export interface FieldSpec {
  /** Noms de colonnes acceptés, par ordre de préférence. */
  readonly candidates: readonly string[];
  readonly required?: boolean;
}

export type ColumnMapping = Record<string, string | null>;

/** Construit un mapping automatique champ -> colonne à partir des entêtes. */
export function autoMap(
  header: readonly string[],
  spec: Readonly<Record<string, FieldSpec>>,
): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const [field, definition] of Object.entries(spec)) {
    const index = findColumn(header, definition.candidates);
    mapping[field] = index >= 0 ? (header[index] as string) : null;
  }
  return mapping;
}

/** Valeur d'un champ à partir d'un mapping, ou null si la colonne est absente/vide. */
export function pick(
  record: CsvRecord,
  mapping: ColumnMapping,
  field: string,
): string | null {
  const column = mapping[field];
  if (!column) return null;
  const value = record.values[column];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** Raccourcis typés : analyse systématique et retour `null` si illisible. */
export function pickAmount(record: CsvRecord, mapping: ColumnMapping, field: string): number | null {
  return parseAmount(pick(record, mapping, field));
}

export function pickQuantity(record: CsvRecord, mapping: ColumnMapping, field: string): number | null {
  return parseQuantity(pick(record, mapping, field));
}

export function pickDate(record: CsvRecord, mapping: ColumnMapping, field: string): string | null {
  return parseDate(pick(record, mapping, field));
}

export function pickCurrency(
  record: CsvRecord,
  mapping: ColumnMapping,
  field: string,
  fallback: string | null = null,
): string | null {
  return parseCurrency(pick(record, mapping, field), fallback);
}