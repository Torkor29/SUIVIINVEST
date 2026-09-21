import { createHash } from 'node:crypto';
import type { Activity, CurrencyCode } from './types.ts';

/**
 * Déduplication des objets importés.
 *
 * Deux niveaux, dans cet ordre :
 *  1. Identifiant externe (`provider` + `externalTransactionId`) : clé primaire
 *     logique. C'est ce qui rend une synchronisation idempotente.
 *  2. Empreinte déterministe (`dedupHash`) : repli quand le fournisseur n'expose
 *     pas d'identifiant stable (exports CSV, transferts on-chain sans hash, etc.).
 *
 * L'empreinte est déterministe : mêmes données => même hash, sur n'importe quelle
 * machine. Elle est volontairement calculée sur des champs *normalisés* (devise en
 * majuscules, montants arrondis, date au jour près) pour que deux imports du même
 * fichier — ou un import CSV et une synchro API — produisent le même hash.
 */

export interface DedupKeyInput {
  readonly providerId: string;
  readonly externalAccountId?: string | null;
  readonly externalTransactionId?: string | null;
  readonly externalAssetId?: string | null;
}

/** Clé de déduplication de plus haute priorité. `null` si aucun id externe. */
export function externalDedupKey(input: DedupKeyInput): string | null {
  if (!input.externalTransactionId) return null;
  return [
    'ext',
    input.providerId,
    input.externalAccountId ?? '-',
    input.externalTransactionId,
  ].join(':');
}

export interface FingerprintInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly type: string;
  readonly date: string;
  readonly instrumentId?: string | null;
  readonly quantity?: number | null;
  readonly unitPrice?: number | null;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly description?: string | null;
}

/** Normalise une date vers `YYYY-MM-DD` et rejette les valeurs non datables. */
export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Date invalide : ${value}`);
  return parsed.toISOString().slice(0, 10);
}

/** Normalise une description : minuscules, espaces compactés, ponctuation légère retirée. */
export function normalizeDescription(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Arrondi monétaire utilisé dans l'empreinte : garantit la stabilité du hash. */
function canon(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return (Math.round(value * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
}

export function fingerprint(input: FingerprintInput): string {
  const parts = [
    input.providerId,
    input.accountId,
    input.type.toUpperCase(),
    normalizeDate(input.date),
    input.instrumentId ?? '',
    canon(input.quantity, 8),
    canon(input.unitPrice, 8),
    canon(input.amount, 8),
    input.currency.toUpperCase(),
    normalizeDescription(input.description),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export type DedupDecision = 'NEW' | 'DUPLICATE_EXTERNAL_ID' | 'DUPLICATE_FINGERPRINT';

export interface DedupResult {
  readonly decision: DedupDecision;
  readonly key: string;
  readonly fingerprint: string;
}

/**
 * Index de déduplication en mémoire, alimenté au fil d'un import/sync.
 * Les appelants le préchargent avec l'existant en base via `seed()`.
 */
export class DedupIndex {
  readonly #externalKeys = new Set<string>();
  readonly #fingerprints = new Set<string>();

  seed(externalKey: string | null, fp: string | null): void {
    if (externalKey) this.#externalKeys.add(externalKey);
    if (fp) this.#fingerprints.add(fp);
  }

  seedFromActivity(activity: Activity): void {
    this.seed(
      externalDedupKey({
        providerId: activity.provenance.providerId,
        externalAccountId: activity.provenance.externalAccountId,
        externalTransactionId: activity.provenance.externalTransactionId,
      }),
      activity.provenance.dedupHash,
    );
  }

  check(input: DedupKeyInput & FingerprintInput): DedupResult {
    const key = externalDedupKey(input);
    const fp = fingerprint(input);
    if (key && this.#externalKeys.has(key)) {
      return { decision: 'DUPLICATE_EXTERNAL_ID', key, fingerprint: fp };
    }
    if (this.#fingerprints.has(fp)) {
      return { decision: 'DUPLICATE_FINGERPRINT', key: key ?? fp, fingerprint: fp };
    }
    return { decision: 'NEW', key: key ?? fp, fingerprint: fp };
  }

  /** Enregistre l'objet comme vu (à appeler après une insertion réussie). */
  commit(input: DedupKeyInput & FingerprintInput): DedupResult {
    const result = this.check(input);
    if (result.key) this.#externalKeys.add(result.key);
    this.#fingerprints.add(result.fingerprint);
    return result;
  }

  get size(): number {
    return this.#fingerprints.size;
  }
}