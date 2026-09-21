import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';

/**
 * Connexions, journaux de synchronisation, imports, journal d'audit et réglages.
 *
 * Chaque synchronisation a un `syncRunId` unique : c'est la clé de corrélation
 * entre ce qui a été écrit dans `activities` et l'historique de synchro, ce qui
 * rend une opération auditable et relançable.
 */

export interface ConnectionRow {
  id: string;
  provider_id: string;
  label: string;
  config_json: string;
  secret_refs_json: string;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  requires_user_action: number;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectionInput {
  readonly providerId: string;
  readonly label: string;
  readonly config: Record<string, string>;
  readonly secretNames: readonly string[];
}

export class ConnectionRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): ConnectionRow[] {
    return this.#db.all<ConnectionRow>('SELECT * FROM connections ORDER BY provider_id, label');
  }

  get(id: string): ConnectionRow | null {
    return this.#db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id);
  }

  create(input: CreateConnectionInput): ConnectionRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO connections (id, provider_id, label, config_json, secret_refs_json, status,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'DISCONNECTED', ?, ?)`,
      id,
      input.providerId,
      input.label,
      JSON.stringify(input.config),
      JSON.stringify(input.secretNames),
      now,
      now,
    );
    return this.get(id) as ConnectionRow;
  }

  updateStatus(
    id: string,
    status: string,
    patch: { lastError?: string | null; syncedAt?: string | null; requiresUserAction?: boolean } = {},
  ): void {
    const current = this.get(id);
    if (!current) return;
    this.#db.run(
      `UPDATE connections SET status = ?, last_error = ?, last_synced_at = ?, requires_user_action = ?,
         updated_at = ? WHERE id = ?`,
      status,
      patch.lastError === undefined ? current.last_error : patch.lastError,
      patch.syncedAt === undefined ? current.last_synced_at : patch.syncedAt,
      patch.requiresUserAction === undefined
        ? current.requires_user_action
        : patch.requiresUserAction
          ? 1
          : 0,
      new Date().toISOString(),
      id,
    );
  }

  updateConfig(id: string, config: Record<string, string>, secretNames: readonly string[]): void {
    this.#db.run(
      'UPDATE connections SET config_json = ?, secret_refs_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(config),
      JSON.stringify(secretNames),
      new Date().toISOString(),
      id,
    );
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.#db.run('DELETE FROM connections WHERE id = ?', id);
    return true;
  }

  count(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM connections')?.count ?? 0;
  }
}

export interface SyncRunRow {
  sync_run_id: string;
  connection_id: string | null;
  provider_id: string;
  trigger_type: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  duration_ms: number | null;
  message: string | null;
  details_json: string | null;
  error_code?: string | null;
}

export interface SyncRunCounts {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
}

export class SyncRunRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  start(input: {
    providerId: string;
    connectionId: string | null;
    trigger: 'MANUAL' | 'SCHEDULED' | 'IMPORT';
  }): string {
    const syncRunId = randomUUID();
    this.#db.run(
      `INSERT INTO sync_runs (sync_run_id, connection_id, provider_id, trigger_type, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'RUNNING')`,
      syncRunId,
      input.connectionId,
      input.providerId,
      input.trigger,
      new Date().toISOString(),
    );
    return syncRunId;
  }

  finish(
    syncRunId: string,
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'AUTH_REQUIRED',
    counts: SyncRunCounts,
    message: string | null,
    details?: unknown,
    /** Code d'erreur normalisé (ConnectorError.kind) : sert à l'interface pour un message propre. */
    errorCode?: string | null,
  ): void {
    const started = this.#db.get<{ started_at: string }>(
      'SELECT started_at FROM sync_runs WHERE sync_run_id = ?',
      syncRunId,
    );
    const finishedAt = new Date().toISOString();
    const durationMs = started ? Date.parse(finishedAt) - Date.parse(started.started_at) : null;
    this.#db.run(
      `UPDATE sync_runs SET finished_at = ?, status = ?, created = ?, updated = ?, skipped = ?,
         errors = ?, duration_ms = ?, message = ?, details_json = ?, error_code = ? WHERE sync_run_id = ?`,
      finishedAt,
      status,
      counts.created,
      counts.updated,
      counts.skipped,
      counts.errors,
      durationMs,
      message,
      details ? JSON.stringify(details) : null,
      errorCode ?? null,
      syncRunId,
    );
  }

  get(syncRunId: string): SyncRunRow | null {
    return this.#db.get<SyncRunRow>('SELECT * FROM sync_runs WHERE sync_run_id = ?', syncRunId);
  }

  listForConnection(connectionId: string, limit = 50): SyncRunRow[] {
    return this.#db.all<SyncRunRow>(
      'SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT ?',
      connectionId,
      limit,
    );
  }

  listRecent(limit = 100): SyncRunRow[] {
    return this.#db.all<SyncRunRow>('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?', limit);
  }

  lastSuccessAt(): string | null {
    return (
      this.#db.get<{ finished_at: string | null }>(
        "SELECT finished_at FROM sync_runs WHERE status IN ('SUCCESS','PARTIAL') ORDER BY finished_at DESC LIMIT 1",
      )?.finished_at ?? null
    );
  }

  /** Un run resté 'RUNNING' (process tué) est marqué en échec au démarrage. */
  markStaleAsFailed(): number {
    const stale = this.#db.all<{ sync_run_id: string }>(
      "SELECT sync_run_id FROM sync_runs WHERE status = 'RUNNING'",
    );
    for (const row of stale) {
      this.#db.run(
        `UPDATE sync_runs SET status = 'FAILED', finished_at = ?, message = ?
          WHERE sync_run_id = ?`,
        new Date().toISOString(),
        'Interrompu (arrêt du serveur pendant la synchronisation)',
        row.sync_run_id,
      );
    }
    return stale.length;
  }
}

export interface ImportRowRecord {
  import_id: string;
  filename: string;
  format_id: string | null;
  account_id: string | null;
  connection_id: string | null;
  imported_at: string;
  created: number;
  skipped: number;
  errors: number;
  details_json: string | null;
}

export class ImportRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(input: {
    importId: string;
    filename: string;
    formatId: string | null;
    accountId: string | null;
    connectionId: string | null;
    created: number;
    skipped: number;
    errors: number;
    details?: unknown;
  }): void {
    this.#db.run(
      `INSERT INTO imports (import_id, filename, format_id, account_id, connection_id, imported_at,
         created, skipped, errors, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.importId,
      input.filename,
      input.formatId,
      input.accountId,
      input.connectionId,
      new Date().toISOString(),
      input.created,
      input.skipped,
      input.errors,
      input.details ? JSON.stringify(input.details) : null,
    );
  }

  list(limit = 100): ImportRowRecord[] {
    return this.#db.all<ImportRowRecord>('SELECT * FROM imports ORDER BY imported_at DESC LIMIT ?', limit);
  }

  /** Un fichier déjà importé exactement à l'identique (même nom + même volume) est signalé. */
  findByFilename(filename: string): ImportRowRecord | null {
    return this.#db.get<ImportRowRecord>(
      'SELECT * FROM imports WHERE filename = ? ORDER BY imported_at DESC LIMIT 1',
      filename,
    );
  }
}

export class AuditRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  log(input: {
    actor: string;
    action: string;
    entity?: string | null;
    entityId?: string | null;
    details?: unknown;
  }): void {
    this.#db.run(
      'INSERT INTO audit_log (at, actor, action, entity, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      input.actor,
      input.action,
      input.entity ?? null,
      input.entityId ?? null,
      input.details ? JSON.stringify(input.details) : null,
    );
  }

  list(limit = 200): {
    at: string;
    actor: string;
    action: string;
    entity: string | null;
    entity_id: string | null;
    details_json: string | null;
  }[] {
    return this.#db.all('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?', limit);
  }
}

export class SettingsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(key: string): string | null {
    return (
      this.#db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null
    );
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      new Date().toISOString(),
    );
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  all(): Record<string, string> {
    const rows = this.#db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
}