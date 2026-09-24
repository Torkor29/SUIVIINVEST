import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type {
  AccountDto,
  AccountOverviewResponse,
  AuditEntryDto,
  BackupExportResponse,
  ConnectionDto,
  ConnectionTestResultDto,
  ConnectionsResponse,
  HealthResponse,
  OkResponse,
  SettingsDto,
  SyncAllResponse,
  SyncOutcomeDto,
} from '@suiviinvest/api-contract';
import type { ProviderId } from '@suiviinvest/core';
import type { ConnectorRegistry, Logger } from '@suiviinvest/connectors';
import type { Db } from '../db/database.ts';
import {
  ConnectionRepository,
  SettingsRepository,
  SyncRunRepository,
  AuditRepository,
} from '../repositories/connections.ts';
import { AccountRepository, type AccountRow } from '../repositories/accounts.ts';
import type { SecretsStore } from '../security/secrets.ts';
import type { BackupService } from '../services/backup.ts';
import type { ImportService } from '../services/imports.ts';
import type { MarketDataService } from '../services/marketdata.ts';
import { userActionFor, type SyncOutcome, type SyncService } from '../services/sync.ts';
import { ARGON2_DESCRIPTION } from '../security/password.ts';
import { sendError } from './auth.ts';

/**
 * Routes d'administration : connexions, synchronisations, imports, réglages,
 * market data et sauvegardes.
 */

/** Correspondance ligne SQL -> DTO, pour ne jamais exposer de snake_case. */
function toAccountDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    providerId: row.provider_id,
    currency: row.currency,
    initialBalance: row.initial_balance,
    isActive: row.is_active === 1,
    externalAccountId: row.external_account_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Résultat de synchronisation au format du contrat (interface). */
function toSyncOutcomeDto(outcome: SyncOutcome): SyncOutcomeDto {
  return {
    syncRunId: outcome.syncRunId,
    connectionId: outcome.connectionId,
    providerId: outcome.providerId,
    status: outcome.status,
    created: outcome.created,
    updated: outcome.updated,
    skipped: outcome.skipped,
    errors: outcome.errors,
    message: outcome.message,
    errorCode: outcome.errorCode,
    durationMs: outcome.durationMs,
    warnings: outcome.warnings,
  };
}

export interface AdminRoutesDeps {
  readonly db: Db;
  /** Base principale (santé du serveur, hors espace). */
  readonly mainDb: Db;
  readonly registry: ConnectorRegistry;
  readonly secrets: SecretsStore;
  readonly sync: SyncService;
  readonly imports: ImportService;
  readonly marketData: MarketDataService;
  readonly backups: { current(): BackupService };
  readonly audit: AuditRepository;
  readonly settings: SettingsRepository;
  readonly logger: Logger;
  readonly config: {
    baseCurrency: string;
    schedulerEnabled: boolean;
    schedulerCron: string;
    snapshotCron: string;
    backupCron: string;
    backupDirectory: string;
    backupRetentionDays: number;
    sessionTtlMinutes: number;
    backupsEncrypted: boolean;
    emailConfigured: boolean;
    databasePath: string;
    version: string;
  };
  readonly startedAt: number;
  readonly scheduler: { isRunning: () => boolean; nextRun: () => string | null; lastRun: () => string | null };
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  const connections = new ConnectionRepository(deps.db);
  const runs = new SyncRunRepository(deps.db);
  // /health est public (hors espace) : il ne lit que la base principale.
  const mainRuns = new SyncRunRepository(deps.mainDb);

  app.get('/health', async (_request, reply) => {
    const health = deps.mainDb.health();
    const payload: HealthResponse = {
      status: health.ok ? 'ok' : 'degraded',
      version: deps.config.version,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      database: health,
      connectors: deps.registry.list().length,
      lastSyncAt: mainRuns.lastSuccessAt(),
    };
    return reply.code(health.ok ? 200 : 503).send(payload);
  });

  app.get('/api/connections', async (_request, reply) => {
    const rows = connections.list();
    const list: ConnectionDto[] = rows.map((row) => {
      const connector = deps.registry.get(row.provider_id as ProviderId);
      return {
        id: row.id,
        providerId: row.provider_id,
        providerName: connector?.displayName ?? row.provider_id,
        label: row.label,
        status: row.status,
        lastSyncedAt: row.last_synced_at,
        lastError: row.last_error,
        requiresUserAction: row.requires_user_action === 1,
        needsReauth: row.status === 'AUTH_REQUIRED',
        config: parseConfig(row.config_json),
        secretNames: parseSecretNames(row.secret_refs_json),
        capabilities: connector?.capabilities ?? {
          accounts: false,
          balances: false,
          positions: false,
          transactions: false,
          income: false,
          api: false,
        },
        importFormats: (connector?.importFormats ?? []).map((format) => ({
          id: format.id,
          label: format.label,
          kind: format.kind,
        })),
      };
    });

    const payload: ConnectionsResponse = {
      connections: list,
      providers: deps.registry.list().map((connector) => ({
        providerId: connector.id,
        providerName: connector.displayName,
        implemented: true,
        apiSupported: connector.capabilities.api,
        importFormats: connector.importFormats.map((format) => format.label),
        requiredConfig: connector.requiredConfig,
        requiredSecrets: connector.requiredSecrets,
        notes: connector.capabilities.api
          ? 'Connecteur API — lecture seule.'
          : 'Import de fichiers uniquement (aucune API exploitable pour ce fournisseur).',
      })),
      scheduler: {
        enabled: deps.scheduler.isRunning(),
        cron: deps.config.schedulerCron,
        lastRunAt: deps.scheduler.lastRun(),
        nextRunAt: deps.scheduler.nextRun(),
      },
    };
    return reply.send(payload);
  });

  app.post('/api/connections', async (request, reply) => {
    const schema = z.object({
      providerId: z.string(),
      label: z.string().min(1).max(120),
      config: z.record(z.string()).default({}),
      secrets: z.record(z.string()).default({}),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Connexion invalide.');
    const connector = deps.registry.get(parsed.data.providerId as ProviderId);
    if (!connector) {
      return sendError(reply, 400, 'INVALID_REQUEST', `Fournisseur inconnu : ${parsed.data.providerId}`);
    }

    // Aucun champ de type seed/private key n'existe dans le schéma : on refuse
    // explicitement toute tentative d'en fournir un.
    const forbidden = Object.keys(parsed.data.config).filter((key) =>
      /(seed|mnemonic|private.?key|privatekey|passphrase)/i.test(key),
    );
    if (forbidden.length > 0) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Champs interdits (jamais stockés, par conception) : ${forbidden.join(', ')}. ` +
          'Une adresse publique suffit pour suivre un wallet.',
      );
    }

    const existingOfProvider = connections.list().filter((row) => row.provider_id === connector.id);
    // Une seule connexion pour les courtiers et banques historiques ; plusieurs
    // pour les wallets, plateformes crypto et banques open banking.
    const singleInstance = ['degiro', 'trade_republic', 'credit_agricole', 'revolut'];
    if (singleInstance.includes(connector.id) && existingOfProvider.length > 0) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        `Une connexion ${connector.displayName} existe déjà : supprimez-la avant d'en créer une nouvelle.`,
      );
    }

    const connection = connections.create({
      providerId: connector.id,
      label: parsed.data.label,
      config: parsed.data.config,
      secretNames: Object.keys(parsed.data.secrets),
    });
    for (const [name, value] of Object.entries(parsed.data.secrets)) {
      deps.secrets.set(`${connection.id}:${name}`, value);
    }
    deps.audit.log({
      actor: 'owner',
      action: 'connection.create',
      entity: 'connection',
      entityId: connection.id,
      details: { providerId: connector.id, label: parsed.data.label, secretNames: Object.keys(parsed.data.secrets) },
    });
    return reply.code(201).send({ id: connection.id, providerId: connection.provider_id });
  });

  app.delete('/api/connections/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const connection = connections.get(id);
    if (!connection) return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    for (const name of parseSecretNames(connection.secret_refs_json)) {
      deps.secrets.delete(`${id}:${name}`);
    }
    connections.delete(id);
    deps.audit.log({ actor: 'owner', action: 'connection.delete', entity: 'connection', entityId: id });
    return reply.code(204).send();
  });

  /**
   * Mise à jour des identifiants d'une connexion existante (reconnexion) : les
   * secrets fournis remplacent les anciens, la configuration non secrète est
   * fusionnée. Les comptes et l'historique déjà collectés sont conservés.
   */
  app.patch('/api/connections/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const connection = connections.get(id);
    if (!connection) return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    const parsed = z
      .object({
        config: z.record(z.string()).default({}),
        secrets: z.record(z.string()).default({}),
      })
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Identifiants invalides.');
    const forbidden = Object.keys(parsed.data.config).filter((key) =>
      /(seed|mnemonic|private.?key|privatekey|passphrase)/i.test(key),
    );
    if (forbidden.length > 0) {
      return sendError(reply, 400, 'INVALID_REQUEST', `Champs interdits : ${forbidden.join(', ')}.`);
    }
    const names = new Set(parseSecretNames(connection.secret_refs_json));
    for (const [name, value] of Object.entries(parsed.data.secrets)) {
      deps.secrets.set(`${id}:${name}`, value);
      names.add(name);
    }
    const currentConfig = JSON.parse(connection.config_json || '{}') as Record<string, string>;
    connections.updateConfig(id, { ...currentConfig, ...parsed.data.config }, [...names]);
    deps.audit.log({
      actor: 'owner',
      action: 'connection.credentials_updated',
      entity: 'connection',
      entityId: id,
      details: { secretNames: Object.keys(parsed.data.secrets) },
    });
    return reply.send({ id, providerId: connection.provider_id });
  });

  app.post('/api/connections/:id/test', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!connections.get(id)) return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    const result = await deps.sync.testConnection(id);
    const payload: ConnectionTestResultDto = {
      ok: result.ok,
      status: result.status,
      message: result.message,
      requiresUserAction: result.requiresUserAction ?? false,
      userAction: result.ok ? null : userActionFor(result.status === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'SYNC_ERROR'),
    };
    return reply.send(payload);
  });

  app.post('/api/connections/:id/sync', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!connections.get(id)) return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    const outcome = await deps.sync.syncConnection(id, 'MANUAL');
    const status = outcome.status === 'FAILED' ? 502 : 200;
    return reply.code(status).send(toSyncOutcomeDto(outcome));
  });

  app.post('/api/connections/sync-all', async (_request, reply) => {
    const outcomes = await deps.sync.syncAll('MANUAL');
    const payload: SyncAllResponse = {
      results: outcomes.map(toSyncOutcomeDto),
      summary: {
        total: outcomes.length,
        succeeded: outcomes.filter((outcome) => outcome.status === 'SUCCESS').length,
        partial: outcomes.filter((outcome) => outcome.status === 'PARTIAL').length,
        failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
        authRequired: outcomes.filter((outcome) => outcome.status === 'AUTH_REQUIRED').length,
        created: outcomes.reduce((acc, outcome) => acc + outcome.created, 0),
        updated: outcomes.reduce((acc, outcome) => acc + outcome.updated, 0),
      },
    };
    return reply.send(payload);
  });

  app.get('/api/connections/:id/runs', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!connections.get(id)) return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    return reply.send(
      runs.listForConnection(id).map((row) => ({
        syncRunId: row.sync_run_id,
        providerId: row.provider_id,
        connectionId: row.connection_id ?? '',
        trigger: row.trigger_type,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        created: row.created,
        updated: row.updated,
        skipped: row.skipped,
        errors: row.errors,
        durationMs: row.duration_ms,
        message: row.message,
        errorCode: row.error_code ?? null,
      })),
    );
  });

  app.get('/api/sync-runs', async (_request, reply) => {
    return reply.send(
      runs.listRecent(200).map((row) => ({
        syncRunId: row.sync_run_id,
        providerId: row.provider_id,
        connectionId: row.connection_id ?? '',
        trigger: row.trigger_type,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        created: row.created,
        updated: row.updated,
        skipped: row.skipped,
        errors: row.errors,
        durationMs: row.duration_ms,
        message: row.message,
        errorCode: row.error_code ?? null,
      })),
    );
  });

  /* --------------------------------------------------------------- imports */

  app.post('/api/imports/analyze', async (request, reply) => {
    const schema = z.object({
      filename: z.string().min(1).max(300),
      content: z.string().min(1).max(20_000_000),
      connectionId: z.string().optional(),
      accountId: z.string().optional(),
      forceFormatId: z.string().optional(),
      columnMap: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Fichier ou paramètres invalides.');
    }
    return reply.send(deps.imports.analyze(parsed.data));
  });

  app.post('/api/imports/commit', async (request, reply) => {
    const schema = z.object({
      filename: z.string().min(1).max(300),
      content: z.string().min(1).max(20_000_000),
      connectionId: z.string().optional(),
      accountId: z.string().optional(),
      forceFormatId: z.string().optional(),
      columnMap: z.record(z.string()).optional(),
      dryRun: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Fichier ou paramètres invalides.');
    }
    const result = deps.imports.commit(parsed.data);
    deps.audit.log({
      actor: 'owner',
      action: parsed.data.dryRun ? 'import.simulate' : 'import.commit',
      entity: 'import',
      entityId: result.importId,
      details: { filename: parsed.data.filename, created: result.created, skipped: result.skipped },
    });
    return reply.send(result);
  });

  app.get('/api/imports', async (_request, reply) => reply.send(deps.imports.history()));

  /* -------------------------------------------------------------- réglages */

  app.get('/api/settings', async (_request, reply) => {
    const theme = deps.settings.get('theme') ?? 'system';
    const payload: SettingsDto = {
      baseCurrency: deps.config.baseCurrency,
      theme: theme === 'light' || theme === 'dark' ? theme : 'system',
      marketDataProviders: deps.marketData.providers,
      backup: {
        enabled: deps.config.backupRetentionDays > 0,
        cron: deps.config.backupCron,
        directory: deps.config.backupDirectory,
        lastBackupAt: deps.backups.current().list()[0]?.createdAt ?? null,
        retentionDays: deps.config.backupRetentionDays,
      },
      scheduler: { enabled: deps.scheduler.isRunning(), cron: deps.config.schedulerCron },
      snapshotCron: deps.config.snapshotCron,
      security: {
        sessionTtlMinutes: deps.config.sessionTtlMinutes,
        argon2Params: ARGON2_DESCRIPTION,
        encryption: 'AES-256-GCM (clé dérivée HKDF-SHA256 depuis SUIVIINVEST_MASTER_KEY)',
        backupsEncrypted: deps.config.backupsEncrypted,
        emailConfigured: deps.config.emailConfigured,
      },
      version: deps.config.version,
      databasePath: deps.config.databasePath,
    };
    return reply.send(payload);
  });

  app.patch('/api/settings', async (request, reply) => {
    const schema = z.object({ theme: z.enum(['system', 'light', 'dark']).optional() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Réglage invalide.');
    if (parsed.data.theme) deps.settings.set('theme', parsed.data.theme);
    const payload: OkResponse = { ok: true };
    return reply.send(payload);
  });

  app.post('/api/market-data/refresh', async (request, reply) => {
    const query = z.object({ force: z.coerce.boolean().optional() }).parse(request.query);
    const result = await deps.marketData.refresh({ force: query.force ?? false });
    deps.audit.log({ actor: 'owner', action: 'marketdata.refresh', details: result });
    return reply.send(result);
  });

  /* ----------------------------------------------------------- sauvegardes */

  app.post('/api/backup/export', async (request, reply) => {
    const query = z.object({ kind: z.enum(['sqlite', 'json', 'csv', 'all']).optional() }).parse(request.query);
    const files = deps.backups.current().create(query.kind ?? 'all');
    deps.audit.log({ actor: 'owner', action: 'backup.create', details: { files: files.map((file) => file.name) } });
    const payload: BackupExportResponse = { files, excludedTables: deps.backups.current().excludedTables };
    return reply.send(payload);
  });

  app.get('/api/backup/list', async (_request, reply) => reply.send(deps.backups.current().list()));

  app.get('/api/audit', async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query);
    const entries: AuditEntryDto[] = deps.audit.list(query.limit ?? 200).map((row) => ({
      at: row.at,
      actor: row.actor,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      details: row.details_json ? safeJson(row.details_json) : null,
    }));
    return reply.send(entries);
  });

  app.get('/api/accounts/overview', async (_request, reply) => {
    const accounts = new AccountRepository(deps.db).list();
    const payload: AccountOverviewResponse = {
      count: accounts.length,
      accounts: accounts.map(toAccountDto),
    };
    return reply.send(payload);
  });

}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function parseConfig(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

function parseSecretNames(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}