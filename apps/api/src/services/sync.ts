import type { ProviderId } from '@suiviinvest/core';
import {
  ConnectorError,
  FetchHttpClient,
  type ConnectionTestResult,
  type Connector,
  type ConnectorContext,
  type ConnectorRegistry,
  type Logger,
  type SyncStatusReport,
} from '@suiviinvest/connectors';
import type { Db } from '../db/database.ts';
import {
  ConnectionRepository,
  SyncRunRepository,
  type ConnectionRow,
} from '../repositories/connections.ts';
import type { SecretsStore } from '../security/secrets.ts';
import { IngestService, isoDay } from './ingest.ts';

/**
 * Moteur de synchronisation.
 *
 * Garanties exigées par le cahier des charges, implémentées ici :
 *  - **isolation** : chaque connexion est synchronisée dans son propre essai.
 *    Une panne DEGIRO n'empêche jamais MetaMask ou Trade Republic de se
 *    synchroniser (`syncAll` n'interrompt pas la boucle sur erreur) ;
 *  - **journalisation** : chaque essai crée un `syncRunId` avec compteurs et
 *    message d'erreur, consultable dans l'historique ;
 *  - **incrémental** : la fenêtre repart de la dernière synchro réussie, avec un
 *    chevauchement de quelques jours pour rattraper les opérations valorisées
 *    après coup ;
 *  - **relançable et sans doublon** : l'écriture finale passe par
 *    `IngestService`, donc par la déduplication par identifiant externe ;
 *  - **read-only** : seules les méthodes de lecture du connecteur sont appelées.
 *    Aucun chemin de code ne peut déclencher un ordre.
 */

export interface SyncServiceOptions {
  readonly baseCurrency: string;
  /** Chevauchement de la fenêtre incrémentale, en jours. */
  readonly overlapDays?: number;
  readonly logger: Logger;
}

export interface SyncOutcome {
  readonly syncRunId: string;
  readonly connectionId: string;
  readonly providerId: string;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'AUTH_REQUIRED';
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
  readonly message: string | null;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

export interface SyncConnectionDto {
  readonly connectionId: string;
  readonly providerId: string;
  readonly label: string;
  readonly lastSyncAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
}

export class SyncService {
  readonly #registry: ConnectorRegistry;
  readonly #secrets: SecretsStore;
  readonly #connections: ConnectionRepository;
  readonly #runs: SyncRunRepository;
  readonly #ingest: IngestService;
  readonly #options: SyncServiceOptions;

  constructor(
    db: Db,
    registry: ConnectorRegistry,
    secrets: SecretsStore,
    options: SyncServiceOptions,
  ) {
    this.#registry = registry;
    this.#secrets = secrets;
    this.#connections = new ConnectionRepository(db);
    this.#runs = new SyncRunRepository(db);
    this.#ingest = new IngestService(db);
    this.#options = options;
  }

  /** Synchronise toutes les connexions, séquentiellement et sans effet de bord croisé. */
  async syncAll(trigger: 'MANUAL' | 'SCHEDULED'): Promise<SyncOutcome[]> {
    const connections = this.#connections.list();
    const outcomes: SyncOutcome[] = [];
    for (const connection of connections) {
      try {
        outcomes.push(await this.syncConnection(connection.id, trigger));
      } catch (error) {
        // Filet de sécurité : une exception non prévue ne doit pas interrompre
        // les autres fournisseurs.
        this.#options.logger.error('Synchronisation interrompue par une erreur inattendue', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  }

  async syncConnection(connectionId: string, trigger: 'MANUAL' | 'SCHEDULED'): Promise<SyncOutcome> {
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connexion inconnue : ${connectionId}`);
    }
    const connector = this.#registry.get(connection.provider_id as ProviderId);
    if (!connector) {
      throw new Error(`Connecteur non enregistré : ${connection.provider_id}`);
    }

    const syncRunId = this.#runs.start({
      providerId: connection.provider_id,
      connectionId,
      trigger,
    });
    const startedAt = Date.now();
    this.#connections.updateStatus(connectionId, 'SYNCING');

    try {
      const ctx = this.#buildContext(connection, connector, syncRunId);

      if (connector.capabilities.api && !connector.importFormats.length) {
        // Aucun chemin de repli : on vérifie la connexion avant d'aller plus loin.
        const test = await connector.testConnection(ctx);
        if (!test.ok && test.requiresUserAction) {
          return this.#fail(syncRunId, connection, 'AUTH_REQUIRED', test.message, startedAt, 0);
        }
      }

      const accounts = connector.capabilities.accounts ? await connector.syncAccounts(ctx) : [];
      const balances = connector.capabilities.balances
        ? await connector.syncBalances(ctx, accounts)
        : [];
      const positions = connector.capabilities.positions
        ? await connector.syncPositions(ctx, accounts)
        : [];
      const window = this.#syncWindow(connection);
      const transactions = connector.capabilities.transactions
        ? await connector.syncTransactions(ctx, window)
        : { items: [], cursor: { value: null } };
      const income = connector.capabilities.income ? await connector.syncIncome(ctx, window) : [];

      const report = this.#ingest.ingestBatch(
        {
          accounts,
          balances,
          positions,
          transactions: transactions.items,
          income,
        },
        {
          providerId: connection.provider_id as ProviderId,
          connectionId,
          syncRunId,
          importId: null,
          baseCurrency: this.#options.baseCurrency,
          trigger,
        },
      );

      const durationMs = Date.now() - startedAt;
      const status = report.errors > 0 || report.warnings.length > 0 ? 'PARTIAL' : 'SUCCESS';
      this.#runs.finish(
        syncRunId,
        status,
        report,
        report.warnings.length
          ? `${report.warnings.length} avertissement(s) — voir le détail`
          : null,
        { warnings: report.warnings.slice(0, 50), cursor: transactions.cursor.value },
      );
      this.#connections.updateStatus(connectionId, 'SYNCED', {
        lastError: null,
        syncedAt: new Date().toISOString(),
        requiresUserAction: false,
      });

      this.#options.logger.info('Synchronisation terminée', {
        syncRunId,
        provider: connection.provider_id,
        status,
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
        warnings: report.warnings.length,
        durationMs,
      });

      return {
        syncRunId,
        connectionId,
        providerId: connection.provider_id,
        status,
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
        errors: report.errors,
        message: report.warnings.length ? `${report.warnings.length} avertissement(s)` : null,
        durationMs,
        warnings: report.warnings,
      };
    } catch (error) {
      const kind = error instanceof ConnectorError ? error.kind : 'DATA';
      const status =
        kind === 'AUTH_REQUIRED' || kind === 'MFA_REQUIRED'
          ? 'AUTH_REQUIRED'
          : ('FAILED' as 'FAILED' | 'AUTH_REQUIRED');
      const message =
        error instanceof ConnectorError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'erreur inconnue';
      return this.#fail(syncRunId, connection, status, message, startedAt, 0);
    }
  }

  async testConnection(connectionId: string): Promise<ConnectionTestResult> {
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error(`Connexion inconnue : ${connectionId}`);
    const connector = this.#registry.require(connection.provider_id as ProviderId);
    const ctx = this.#buildContext(connection, connector, 'test');
    try {
      const result = await connector.testConnection(ctx);
      this.#connections.updateStatus(connectionId, result.ok ? 'CONNECTED' : result.status, {
        lastError: result.ok ? null : result.message,
        requiresUserAction: result.requiresUserAction ?? false,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erreur inconnue';
      this.#connections.updateStatus(connectionId, 'ERROR', { lastError: message });
      return { ok: false, status: 'ERROR', message };
    }
  }

  async getStatus(connectionId: string): Promise<SyncStatusReport | null> {
    const connection = this.#connections.get(connectionId);
    if (!connection) return null;
    const connector = this.#registry.get(connection.provider_id as ProviderId);
    if (!connector) return null;
    return connector.getSyncStatus(this.#buildContext(connection, connector, 'status'));
  }

  /**
   * Contexte d'exécution d'un connecteur.
   *
   * Les secrets sont lus sous la forme `${connectionId}:${nom}` : deux connexions
   * du même fournisseur (deux comptes DEGIRO) ne partagent donc jamais leurs
   * identifiants.
   */
  #buildContext(connection: ConnectionRow, connector: Connector, syncRunId: string): ConnectorContext {
    const secrets = this.#secrets;
    const prefix = `${connection.id}:`;
    return {
      connectionId: connection.id,
      syncRunId,
      config: parseJson<Record<string, string>>(connection.config_json, {}),
      secrets: {
        get: (name: string) => secrets.get(`${prefix}${name}`),
      },
      http: new FetchHttpClient({ providerId: connector.id }),
      logger: this.#options.logger,
      now: () => new Date(),
    };
  }

  #syncWindow(connection: ConnectionRow): { since: string | null; cursor: string | null } {
    const overlap = this.#options.overlapDays ?? 5;
    if (!connection.last_synced_at) return { since: null, cursor: null };
    const since = new Date(
      Date.parse(connection.last_synced_at) - overlap * 86_400_000,
    );
    return { since: isoDay(since), cursor: null };
  }

  #fail(
    syncRunId: string,
    connection: ConnectionRow,
    status: 'FAILED' | 'AUTH_REQUIRED',
    message: string,
    startedAt: number,
    errors: number,
  ): SyncOutcome {
    this.#runs.finish(syncRunId, status, { created: 0, updated: 0, skipped: 0, errors: errors || 1 }, message);
    this.#connections.updateStatus(connection.id, status === 'FAILED' ? 'ERROR' : 'AUTH_REQUIRED', {
      lastError: message,
      requiresUserAction: status === 'AUTH_REQUIRED',
    });
    this.#options.logger.error('Synchronisation en échec', {
      syncRunId,
      provider: connection.provider_id,
      status,
      message,
    });
    return {
      syncRunId,
      connectionId: connection.id,
      providerId: connection.provider_id,
      status,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: errors || 1,
      message,
      durationMs: Date.now() - startedAt,
      warnings: [],
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
