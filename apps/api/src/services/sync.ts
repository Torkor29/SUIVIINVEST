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
  /**
   * Clés d'API venues de l'environnement (`SUIVIINVEST_KEY_<NOM>`), utilisées en
   * repli quand aucun secret n'a été saisi dans l'interface pour cette connexion.
   */
  readonly integrationKeys?: Readonly<Record<string, string>>;
  /** Sidecars disponibles (DEGIRO, Trade Republic...), injectés pour être simulables en test. */
  readonly sidecars?: Readonly<Record<string, import('@suiviinvest/connectors').SidecarTransport>>;
  /** Client HTTP des connecteurs (tests : réponses simulées). Par défaut, `fetch`. */
  readonly http?: import('@suiviinvest/connectors').HttpClient;
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
  /** Message court, compréhensible par l'utilisateur (jamais une trace technique). */
  readonly message: string | null;
  /** Code d'erreur normalisé, `null` en cas de succès. */
  readonly errorCode: string | null;
  /** Consigne actionnable associée à l'erreur (« Validez dans l'application... »). */
  readonly userAction: string | null;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  /** Positions (avoirs) relevées à la source. */
  readonly positions?: number;
}

/** Traduit un code d'erreur technique en consigne utilisateur, sans jargon. */
export function userActionFor(errorCode: string | null): string | null {
  switch (errorCode) {
    case 'AUTH_REQUIRED':
      return 'Renseignez vos identifiants pour cette source, puis relancez la synchronisation.';
    case 'MFA_REQUIRED':
      return 'Validez la connexion dans l\'application du fournisseur, puis relancez la synchronisation.';
    case 'SESSION_EXPIRED':
      return 'Votre session a expiré : reconnectez-vous à cette source.';
    case 'RATE_LIMITED':
      return 'Le fournisseur limite temporairement les accès : réessayez dans quelques minutes.';
    case 'PROVIDER_DOWN':
      return 'Le service du fournisseur est injoignable : réessayez plus tard.';
    case 'PROVIDER_BROKEN':
      return 'Le format du fournisseur a changé : utilisez l\'import de fichier en attendant une mise à jour.';
    case 'NOT_SUPPORTED':
      return 'Cette source fonctionne par import de fichier : utilisez « Importer un fichier ».';
    case 'NETWORK':
      return 'Problème réseau de votre côté : vérifiez votre connexion.';
    case 'DATA':
      return 'Certaines données du fournisseur sont inexploitables : consultez le détail.';
    case 'SYNC_ERROR':
      return 'La synchronisation a échoué : consultez le détail et relancez.';
    default:
      return null;
  }
}

/** Libellé court d'un résultat de synchronisation, prêt à afficher. */
export function labelFor(status: SyncOutcome['status']): string {
  switch (status) {
    case 'SUCCESS':
      return 'Synchronisé';
    case 'PARTIAL':
      return 'Synchronisé avec avertissements';
    case 'AUTH_REQUIRED':
      return 'Validation requise';
    default:
      return 'Échec';
  }
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
          completePositions: connector.capabilities.completePositions === true,
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
          : `${report.created} ajout(s), ${report.updated} mise(s) à jour`,
        { warnings: report.warnings.slice(0, 50), cursor: transactions.cursor.value },
        null,
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
        errorCode: null,
        userAction: null,
        durationMs,
        warnings: report.warnings,
        positions: positions.length,
      };
    } catch (error) {
      const connectorError = error instanceof ConnectorError ? error : null;
      const kind = connectorError?.kind ?? 'DATA';
      const status =
        kind === 'AUTH_REQUIRED' || kind === 'MFA_REQUIRED' || kind === 'SESSION_EXPIRED'
          ? ('AUTH_REQUIRED' as const)
          : ('FAILED' as const);
      // Le message d'erreur technique n'est PAS renvoyé tel quel : il part dans les
      // logs, l'interface reçoit un message court + une consigne actionnable.
      const technical = connectorError
        ? connectorError.message
        : error instanceof Error
          ? error.message
          : 'erreur inconnue';
      // Connexion refusée, validation attendue, accès limité : le message du
      // connecteur (rédigé pour l'utilisateur, sans secret) dit précisément quoi faire.
      const friendly =
        connectorError && USER_FACING_KINDS.has(kind) && connectorError.message.length <= 400
          ? connectorError.message
          : describeError(kind);
      return this.#fail(syncRunId, connection, status, friendly, startedAt, 0, kind, technical);
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
    const envKeys = this.#options.integrationKeys ?? {};
    return {
      connectionId: connection.id,
      syncRunId,
      config: parseJson<Record<string, string>>(connection.config_json, {}),
      secrets: {
        /**
         * Résolution d'un secret par nom logique :
         *   1. secret saisi dans l'interface pour CETTE connexion (chiffré en base) ;
         *   2. clé d'API fournie par l'environnement (`SUIVIINVEST_KEY_<NOM>`).
         * La valeur n'est jamais journalisée ni renvoyée par l'API.
         */
        get: async (name: string) => {
          const stored = await secrets.get(`${prefix}${name}`);
          if (stored !== null) return stored;
          // Secret partagé par toutes les connexions d'un type (ex. l'application
          // Enable Banking), saisi une fois dans l'interface.
          const shared = await secrets.get(`global:${name}`);
          if (shared !== null) return shared;
          return envKeys[name.toLowerCase()] ?? null;
        },
      },
      http: this.#options.http ?? new FetchHttpClient({ providerId: connector.id }),
      logger: this.#options.logger,
      now: () => new Date(),
      ...(this.#options.sidecars ? { sidecars: this.#options.sidecars } : {}),
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
    errorCode: string | null = null,
    technical?: string,
  ): SyncOutcome {
    this.#runs.finish(
      syncRunId,
      status,
      { created: 0, updated: 0, skipped: 0, errors: errors || 1 },
      message,
      technical ? { technical: technical.slice(0, 500) } : undefined,
      errorCode,
    );
    this.#connections.updateStatus(connection.id, status === 'FAILED' ? 'ERROR' : 'AUTH_REQUIRED', {
      // On stocke le message utilisateur : l'interface ne montre jamais la trace brute.
      lastError: message,
      requiresUserAction: status === 'AUTH_REQUIRED',
    });
    // La cause technique est journalisée côté serveur uniquement.
    this.#options.logger.error('Synchronisation en échec', {
      syncRunId,
      provider: connection.provider_id,
      status,
      errorCode,
      cause: technical ?? message,
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
      errorCode,
      userAction: userActionFor(errorCode),
      durationMs: Date.now() - startedAt,
      warnings: [],
    };
  }
}

/** Codes pour lesquels le message du connecteur est montré tel quel à l'utilisateur. */
const USER_FACING_KINDS: ReadonlySet<string> = new Set(['AUTH_REQUIRED', 'MFA_REQUIRED', 'SESSION_EXPIRED', 'RATE_LIMITED']);

/** Message court présenté à l'utilisateur, dérivé du code d'erreur normalisé. */
function describeError(kind: string): string {
  switch (kind) {
    case 'AUTH_REQUIRED':
      return 'Identifiants requis ou refusés par le fournisseur.';
    case 'MFA_REQUIRED':
      return 'Une validation de votre part est nécessaire chez le fournisseur.';
    case 'SESSION_EXPIRED':
      return 'Session expirée chez le fournisseur.';
    case 'RATE_LIMITED':
      return 'Accès temporairement limité par le fournisseur.';
    case 'PROVIDER_DOWN':
      return 'Service du fournisseur injoignable.';
    case 'PROVIDER_BROKEN':
      return 'Le format ou le comportement du fournisseur a changé.';
    case 'NOT_SUPPORTED':
      return 'Cette source n\'est pas disponible en automatique.';
    case 'NETWORK':
      return 'Problème réseau pendant la synchronisation.';
    case 'DATA':
      return 'Données du fournisseur inexploitables.';
    case 'SYNC_ERROR':
      return 'La synchronisation a échoué.';
    default:
      return 'La synchronisation a échoué.';
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
