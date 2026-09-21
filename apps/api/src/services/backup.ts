import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database.ts';
import { Db as Database } from '../db/database.ts';

/**
 * Sauvegardes.
 *
 * L'application contient tout l'historique financier : la sauvegarde n'est pas
 * une option. Trois formats sont produits :
 *  - **SQLite** (`VACUUM INTO`) : copie cohérente et restaurable telle quelle,
 *    sans arrêter le serveur ;
 *  - **JSON** : export complet, lisible et versionnable, utilisable pour migrer ;
 *  - **CSV** : une table = un fichier, exploitable dans un tableur.
 *
 * Rétention : les sauvegardes de plus de N jours sont supprimées (configurable).
 * La restauration est documentée dans README.md (procédure opérateur).
 */

export interface BackupFile {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly kind: 'sqlite' | 'json' | 'csv';
}

export interface BackupOptions {
  readonly directory: string;
  readonly retentionDays: number;
}

/** Tables exportées : liste explicite pour ne jamais exporter une future table sensible par accident. */
const EXPORTED_TABLES = [
  'accounts',
  'instruments',
  'activities',
  'valuations',
  'quotes',
  'fx_rates',
  'net_worth_snapshots',
  'properties',
  'property_loans',
  'property_appraisals',
  'property_cash_flows',
  'connections',
  'sync_runs',
  'imports',
  'settings',
] as const;

/** Tables volontairement JAMAIS exportées : secrets, sessions, journal d'audit brut. */
const EXCLUDED_TABLES = ['secrets', 'sessions', 'users', 'audit_log'] as const;

export class BackupService {
  readonly #db: Db;
  readonly #directory: string;
  readonly #retentionDays: number;

  constructor(db: Db, options: BackupOptions) {
    this.#db = db;
    this.#directory = options.directory;
    this.#retentionDays = options.retentionDays;
    if (!existsSync(this.#directory)) mkdirSync(this.#directory, { recursive: true });
  }

  get directory(): string {
    return this.#directory;
  }

  get excludedTables(): readonly string[] {
    return EXCLUDED_TABLES;
  }

  /** Sauvegarde SQLite cohérente + export JSON du même instant. */
  create(kind: 'sqlite' | 'json' | 'csv' | 'all' = 'all'): BackupFile[] {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created: BackupFile[] = [];

    if (kind === 'sqlite' || kind === 'all') {
      const path = join(this.#directory, `suiviinvest-${stamp}.db`);
      this.#db.backupTo(path);
      created.push(this.#describe(path, 'sqlite'));
    }
    if (kind === 'json' || kind === 'all') {
      const path = join(this.#directory, `suiviinvest-${stamp}.json`);
      writeFileSync(path, JSON.stringify(this.exportJson(), null, 2), 'utf8');
      created.push(this.#describe(path, 'json'));
    }
    if (kind === 'csv' || kind === 'all') {
      const directory = join(this.#directory, `csv-${stamp}`);
      mkdirSync(directory, { recursive: true });
      for (const table of EXPORTED_TABLES) {
        writeFileSync(join(directory, `${table}.csv`), this.exportCsv(table), 'utf8');
      }
      created.push({
        name: `csv-${stamp}`,
        path: directory,
        sizeBytes: 0,
        createdAt: new Date().toISOString(),
        kind: 'csv',
      });
    }

    this.applyRetention();
    return created;
  }

  /** Export JSON complet : enveloppe versionnée + comptages + données. */
  exportJson(): {
    version: string;
    exportedAt: string;
    excludedTables: readonly string[];
    tables: Record<string, unknown[]>;
  } {
    const tables: Record<string, unknown[]> = {};
    for (const table of EXPORTED_TABLES) {
      tables[table] = this.#db.all(`SELECT * FROM ${table}`);
    }
    return {
      version: '1',
      exportedAt: new Date().toISOString(),
      excludedTables: EXCLUDED_TABLES,
      tables,
    };
  }

  exportCsv(table: (typeof EXPORTED_TABLES)[number]): string {
    const rows = this.#db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    if (rows.length === 0) return '';
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.join(';')];
    for (const row of rows) {
      lines.push(columns.map((column) => escape(row[column])).join(';'));
    }
    return `${lines.join('\n')}\n`;
  }

  list(): BackupFile[] {
    if (!existsSync(this.#directory)) return [];
    return readdirSync(this.#directory)
      .map((name) => {
        const path = join(this.#directory, name);
        const stats = statSync(path);
        const kind: BackupFile['kind'] = name.endsWith('.db')
          ? 'sqlite'
          : name.endsWith('.json')
            ? 'json'
            : 'csv';
        return {
          name,
          path,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
          kind,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Supprime les sauvegardes au-delà de la rétention. Retourne les fichiers retirés. */
  applyRetention(): string[] {
    if (this.#retentionDays <= 0) return [];
    const threshold = Date.now() - this.#retentionDays * 86_400_000;
    const removed: string[] = [];
    for (const file of this.list()) {
      if (Date.parse(file.createdAt) >= threshold) continue;
      try {
        if (file.kind === 'csv') {
          for (const entry of readdirSync(file.path)) unlinkSync(join(file.path, entry));
          // Le répertoire CSV reste vide après nettoyage : on le laisse, rmSync
          // récursif est volontairement évité pour ne pas risquer une suppression
          // large sur un chemin mal formé.
        } else {
          unlinkSync(file.path);
        }
        removed.push(file.name);
      } catch {
        // Un fichier verrouillé ne doit pas faire échouer la sauvegarde.
      }
    }
    return removed;
  }

  /**
   * Vérifie qu'une sauvegarde SQLite est lisible avant de s'en servir.
   * On ne restaure jamais « à l'aveugle » : la vérification d'intégrité passe en
   * premier (voir la procédure de restauration documentée dans README.md).
   */
  verify(path: string): { ok: boolean; tables: number; message: string } {
    try {
      const probe = new DbProbe(path);
      const result = probe.check();
      probe.close();
      return result;
    } catch (error) {
      return {
        ok: false,
        tables: 0,
        message: error instanceof Error ? error.message : 'fichier illisible',
      };
    }
  }

  #describe(path: string, kind: BackupFile['kind']): BackupFile {
    const stats = statSync(path);
    return {
      name: path.split('/').pop() ?? path,
      path,
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
      kind,
    };
  }
}

/** Ouverture d'un fichier de sauvegarde pour contrôle d'intégrité. */
class DbProbe {
  readonly #db: Db;

  constructor(path: string) {
    this.#db = new Database(path);
  }

  check(): { ok: boolean; tables: number; message: string } {
    const health = this.#db.health();
    const tables = this.#db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    return {
      ok: health.ok,
      tables: tables?.count ?? 0,
      message: health.ok
        ? `Intégrité vérifiée : ${tables?.count ?? 0} tables.`
        : 'Échec du contrôle d\'intégrité SQLite.',
    };
  }

  close(): void {
    this.#db.close();
  }
}