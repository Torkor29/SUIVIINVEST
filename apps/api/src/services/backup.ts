import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_KEY_INFO, deriveKey } from '../security/crypto.ts';
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
 * Chiffrement : avec une clé maîtresse (par défaut en production), chaque
 * fichier est chiffré en AES-256-GCM (suffixe `.enc`) avant d'être posé sur le
 * disque. Un fichier de sauvegarde copié hors du serveur est donc illisible sans
 * `SUIVIINVEST_MASTER_KEY`. Déchiffrement : `node apps/api/src/cli/decrypt-backup.ts`.
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
  /** Présente = sauvegardes chiffrées (AES-256-GCM, clé dérivée HKDF). */
  readonly masterKey?: string;
}

/** En-tête d'un fichier chiffré : magie + version, puis IV (12), chiffré, tag (16). */
const ENCRYPTED_MAGIC = Buffer.from('SUIVIINVEST-ENC1\n', 'utf8');

export function encryptBackupBytes(plain: Buffer, masterKey: string): Buffer {
  const key = deriveKey(masterKey, BACKUP_KEY_INFO);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, iv, body, cipher.getAuthTag()]);
}

export function isEncryptedBackup(bytes: Buffer): boolean {
  return bytes.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC);
}

export function decryptBackupBytes(bytes: Buffer, masterKey: string): Buffer {
  if (!isEncryptedBackup(bytes)) throw new Error("Ce fichier n'est pas une sauvegarde chiffrée SuiviInvest.");
  const key = deriveKey(masterKey, BACKUP_KEY_INFO);
  const start = ENCRYPTED_MAGIC.length;
  const iv = bytes.subarray(start, start + 12);
  const tag = bytes.subarray(bytes.length - 16);
  const body = bytes.subarray(start + 12, bytes.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('Déchiffrement impossible : clé maîtresse différente ou fichier altéré.');
  }
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
  readonly #masterKey: string | null;

  constructor(db: Db, options: BackupOptions) {
    this.#db = db;
    this.#directory = options.directory;
    this.#retentionDays = options.retentionDays;
    this.#masterKey = options.masterKey ?? null;
    if (!existsSync(this.#directory)) mkdirSync(this.#directory, { recursive: true });
  }

  get directory(): string {
    return this.#directory;
  }

  get excludedTables(): readonly string[] {
    return EXCLUDED_TABLES;
  }

  get encrypted(): boolean {
    return this.#masterKey !== null;
  }

  /** Écrit un fichier, chiffré si une clé est configurée. Retourne le chemin final. */
  #write(path: string, content: Buffer | string): string {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (this.#masterKey === null) {
      writeFileSync(path, bytes, { mode: 0o600 });
      return path;
    }
    const target = `${path}.enc`;
    writeFileSync(target, encryptBackupBytes(bytes, this.#masterKey), { mode: 0o600 });
    return target;
  }

  /** Sauvegarde SQLite cohérente + export JSON du même instant. */
  create(kind: 'sqlite' | 'json' | 'csv' | 'all' = 'all'): BackupFile[] {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const created: BackupFile[] = [];

    if (kind === 'sqlite' || kind === 'all') {
      const path = join(this.#directory, `suiviinvest-${stamp}.db`);
      if (this.#masterKey === null) {
        this.#db.backupTo(path);
        created.push(this.#describe(path, 'sqlite'));
      } else {
        // Copie cohérente dans un fichier temporaire, chiffrée puis effacée :
        // aucune version en clair ne reste dans le répertoire de sauvegarde.
        const temporary = join(tmpdir(), `suiviinvest-${stamp}-${randomBytes(4).toString('hex')}.db`);
        this.#db.backupTo(temporary);
        try {
          created.push(this.#describe(this.#write(path, readFileSync(temporary)), 'sqlite'));
        } finally {
          unlinkSync(temporary);
        }
      }
    }
    if (kind === 'json' || kind === 'all') {
      const path = join(this.#directory, `suiviinvest-${stamp}.json`);
      created.push(this.#describe(this.#write(path, JSON.stringify(this.exportJson(), null, 2)), 'json'));
    }
    if (kind === 'csv' || kind === 'all') {
      const directory = join(this.#directory, `csv-${stamp}`);
      mkdirSync(directory, { recursive: true });
      for (const table of EXPORTED_TABLES) {
        this.#write(join(directory, `${table}.csv`), this.exportCsv(table));
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
        const kind: BackupFile['kind'] = name.endsWith('.db') || name.endsWith('.db.enc')
          ? 'sqlite'
          : name.endsWith('.json') || name.endsWith('.json.enc')
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
    let temporary: string | null = null;
    try {
      let target = path;
      const bytes = readFileSync(path);
      if (isEncryptedBackup(bytes)) {
        if (this.#masterKey === null) throw new Error('Sauvegarde chiffrée : clé maîtresse requise.');
        temporary = join(tmpdir(), `suiviinvest-verify-${randomBytes(6).toString('hex')}.db`);
        writeFileSync(temporary, decryptBackupBytes(bytes, this.#masterKey), { mode: 0o600 });
        target = temporary;
      }
      const probe = new DbProbe(target);
      const result = probe.check();
      probe.close();
      return result;
    } catch (error) {
      return {
        ok: false,
        tables: 0,
        message: error instanceof Error ? error.message : 'fichier illisible',
      };
    } finally {
      if (temporary !== null) {
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            unlinkSync(`${temporary}${suffix}`);
          } catch {
            /* déjà absent */
          }
        }
      }
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