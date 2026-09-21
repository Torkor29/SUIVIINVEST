import type { SecretReader } from '@suiviinvest/connectors';
import type { Db } from '../db/database.ts';
import { decryptSecret, deriveKey, encryptSecret, SECRET_KEY_INFO } from './crypto.ts';

/**
 * Stockage des secrets des connecteurs.
 *
 * - Chaque valeur est chiffrée en AES-256-GCM avec une clé dérivée de la clé
 *   maître d'environnement ;
 * - la base ne contient que du chiffré (voir migration `core`) ;
 * - l'interface publique n'expose QUE `get`/`list` : rien ne peut écrire un
 *   secret sans passer par `set`, utilisé par les routes de connexion.
 *
 * Aucun secret n'est jamais renvoyé par l'API : les DTO n'exposent que les NOMS
 * des secrets attendus (`secretNames`).
 */

export interface SecretSummary {
  readonly name: string;
  readonly updatedAt: string;
}

export class SecretsStore implements SecretReader {
  readonly #db: Db;
  readonly #key: Buffer;
  /** Cache mémoire court : évite de déchiffrer à chaque requête d'une synchro. */
  readonly #cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(db: Db, masterKey: string, cacheTtlMs = 30_000) {
    this.#db = db;
    this.#key = deriveKey(masterKey, SECRET_KEY_INFO);
    this.#cacheTtlMs = cacheTtlMs;
  }

  readonly #cacheTtlMs: number;

  async get(name: string): Promise<string | null> {
    const cached = this.#cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const row = this.#db.get<{ ciphertext: string; iv: string; tag: string }>(
      'SELECT ciphertext, iv, tag FROM secrets WHERE name = ?',
      name,
    );
    if (!row) return null;
    const value = decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, version: 1 },
      this.#key,
    );
    this.#cache.set(name, { value, expiresAt: Date.now() + this.#cacheTtlMs });
    return value;
  }

  set(name: string, value: string): void {
    const encrypted = encryptSecret(value, this.#key);
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO secrets (name, ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
         tag = excluded.tag, updated_at = excluded.updated_at`,
      name,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      now,
      now,
    );
    this.#cache.delete(name);
  }

  delete(name: string): void {
    this.#db.run('DELETE FROM secrets WHERE name = ?', name);
    this.#cache.delete(name);
  }

  /** Noms et dates de mise à jour : jamais les valeurs. */
  list(): SecretSummary[] {
    return this.#db
      .all<{ name: string; updated_at: string }>('SELECT name, updated_at FROM secrets ORDER BY name')
      .map((row) => ({ name: row.name, updatedAt: row.updated_at }));
  }

  has(name: string): boolean {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM secrets WHERE name = ?', name);
    return (row?.count ?? 0) > 0;
  }
}