import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';

/**
 * Accès SQLite.
 *
 * `node:sqlite` (natif Node ≥ 22.5) plutôt que better-sqlite3 : aucune
 * compilation native, aucune dépendance, donc une image Docker reproductible.
 *
 * Réglages : WAL (lectures concurrentes pendant une synchro), clés étrangères
 * actives, `synchronous = NORMAL` (compromis standard pour une base locale).
 */

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

export class Db {
  readonly #db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.#db.prepare(sql);
  }

  /** Exécute une requête et renvoie la première ligne (ou null). */
  get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null | bigint | Uint8Array)[]): T | null {
    const row = this.prepare(sql).get(...params);
    return (row as T | undefined) ?? null;
  }

  all<T = Record<string, unknown>>(
    sql: string,
    ...params: (string | number | null | bigint | Uint8Array)[]
  ): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: (string | number | null | bigint | Uint8Array)[]): void {
    this.prepare(sql).run(...params);
  }

  /**
   * Transaction : toutes les écritures d'une synchronisation ou d'un import
   * passent par ici. Un import partiel n'existe pas — soit tout, soit rien.
   */
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Le rollback peut échouer si la transaction est déjà close : on garde
        // l'erreur d'origine, plus informative.
      }
      throw error;
    }
  }

  /** Applique les migrations non encore appliquées, une transaction par version. */
  migrate(): MigrationRecord[] {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations').map((row) => row.version),
    );
    const records: MigrationRecord[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const run = () => {
        for (const statement of migration.statements) {
          this.#db.exec(statement);
        }
        this.#db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      };
      this.transaction(run);
      records.push({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
    }
    return records;
  }

  migrationCount(): number {
    const row = this.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations');
    return row?.count ?? 0;
  }

  /** Vérifie l'intégrité et la présence des tables (utilisé par /health). */
  health(): { ok: boolean; file: string; migrations: number } {
    try {
      const check = this.get<{ integrity_check: string }>('PRAGMA integrity_check');
      return {
        ok: check?.integrity_check === 'ok',
        file: this.path,
        migrations: this.migrationCount(),
      };
    } catch {
      return { ok: false, file: this.path, migrations: 0 };
    }
  }

  /** Copie de sauvegarde cohérente (API SQLite `VACUUM INTO`, sans arrêter l'app). */
  backupTo(destination: string): void {
    this.#db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.#db.close();
  }
}