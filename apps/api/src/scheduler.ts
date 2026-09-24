import { Cron } from 'croner';
import type { Logger } from '@suiviinvest/connectors';
import type { BackupService } from './services/backup.ts';
import type { SyncService } from './services/sync.ts';

/**
 * Ordonnanceur serveur : synchronisations automatiques et sauvegardes quotidiennes.
 *
 * Choix : un ordonnanceur en processus (pas de démon externe, pas de Redis pour
 * une application mono-utilisateur). Les jobs sont déclenchés séquentiellement
 * et ne peuvent pas se chevaucher (`protect: true`), ce qui évite deux
 * synchronisations concurrentes du même fournisseur.
 */

export interface SchedulerOptions {
  readonly enabled: boolean;
  readonly syncCron: string;
  readonly backupCron: string;
  /** Relevé quotidien du patrimoine : une fois par jour, valeur totale et par compte. */
  readonly snapshotCron: string;
  readonly snapshots: { recordDailySnapshot(): { date: string; total: number; accounts: number } };
  /** Cours suivis + investissements programmés (portefeuille saisi à la main). */
  readonly pricesCron?: string;
  readonly holdings?: {
    refreshAll(): Promise<{ instruments: number; quotes: number; errors: string[]; executions: number }>;
    refreshLive?(options: { minIntervalMs?: number; securities?: boolean }): Promise<{ updated: number; at: string | null }>;
  };
  /** Cours en direct (toutes les 5 minutes par défaut) ; « off » pour désactiver. */
  readonly liveCron?: string;
  readonly logger: Logger;
  readonly sync: SyncService;
  readonly backup: Pick<BackupService, 'create'>;
  /**
   * Exécute une tâche dans chaque espace (une base par personne inscrite).
   * Absent : une seule exécution (installation mono-espace, tests).
   */
  readonly forEachTenant?: (work: () => Promise<void> | void) => Promise<void>;
  /** Fuseau horaire des tâches planifiées (par défaut : celui du serveur). */
  readonly timezone?: string;
}

export interface SchedulerState {
  isRunning(): boolean;
  nextRun(): string | null;
  lastRun(): string | null;
}

export class Scheduler implements SchedulerState {
  readonly #options: SchedulerOptions;
  #syncJob: Cron | null = null;
  #backupJob: Cron | null = null;
  #snapshotJob: Cron | null = null;
  #pricesJob: Cron | null = null;
  #liveJob: Cron | null = null;
  #lastRunAt: string | null = null;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  async #everywhere(work: () => Promise<void> | void): Promise<void> {
    if (this.#options.forEachTenant) await this.#options.forEachTenant(work);
    else await work();
  }

  start(): void {
    if (!this.#options.enabled) {
      this.#options.logger.info('Ordonnanceur désactivé (SUIVIINVEST_SCHEDULER_ENABLED=0)');
      return;
    }
    const { logger, sync, backup } = this.#options;

    this.#syncJob = new Cron(
      this.#options.syncCron,
      {
        protect: true,
        ...(this.#options.timezone ? { timezone: this.#options.timezone } : {}),
      },
      async () => {
        this.#lastRunAt = new Date().toISOString();
        logger.info('Synchronisation planifiée démarrée', { cron: this.#options.syncCron });
        try {
          await this.#everywhere(async () => {
            const outcomes = await sync.syncAll('SCHEDULED');
            if (outcomes.length === 0) return;
            logger.info('Synchronisation planifiée terminée', {
              total: outcomes.length,
              succeeded: outcomes.filter((outcome) => outcome.status === 'SUCCESS').length,
              failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
              created: outcomes.reduce((acc, outcome) => acc + outcome.created, 0),
            });
          });
        } catch (error) {
          logger.error('Synchronisation planifiée en échec', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    this.#backupJob = new Cron(this.#options.backupCron, { protect: true }, async () => {
      try {
        await this.#everywhere(() => {
          const files = backup.create('all');
          logger.info('Sauvegarde automatique effectuée', { files: files.map((file) => file.name) });
        });
      } catch (error) {
        logger.error('Sauvegarde automatique en échec', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.#snapshotJob = new Cron(this.#options.snapshotCron, { protect: true }, async () => {
      try {
        await this.#everywhere(() => {
          const result = this.#options.snapshots.recordDailySnapshot();
          logger.info('Relevé de patrimoine enregistré', result);
        });
      } catch (error) {
        logger.error('Relevé de patrimoine en échec', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const holdings = this.#options.holdings;
    if (holdings && this.#options.pricesCron) {
      this.#pricesJob = new Cron(this.#options.pricesCron, { protect: true }, async () => {
        await this.refreshPrices();
      });
      // Au démarrage : cours à jour et échéances manquées pendant l'arrêt rattrapées.
      setTimeout(() => void this.refreshPrices(), 5_000).unref();
    }
    if (holdings?.refreshLive && this.#options.liveCron && this.#options.liveCron !== 'off') {
      this.#liveJob = new Cron(this.#options.liveCron, { protect: true }, async () => {
        await this.refreshLive();
      });
    }

    logger.info('Ordonnanceur démarré', {
      syncCron: this.#options.syncCron,
      backupCron: this.#options.backupCron,
      nextSync: this.#syncJob.nextRun()?.toISOString() ?? null,
      nextBackup: this.#backupJob.nextRun()?.toISOString() ?? null,
      nextSnapshot: this.#snapshotJob.nextRun()?.toISOString() ?? null,
    });
  }

  /**
   * Cours en direct de chaque espace. Titres pendant les heures de bourse
   * européennes élargies (7 h – 23 h, heure de Paris), cryptos à toute heure.
   * Ne lève jamais.
   */
  async refreshLive(now = new Date()): Promise<void> {
    const refresh = this.#options.holdings?.refreshLive;
    if (!refresh) return;
    const parisHour = Number(new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', hour12: false, timeZone: 'Europe/Paris' }).format(now));
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/Paris' }).format(now);
    const securities = parisHour >= 7 && parisHour < 23 && weekday !== 'Sat' && weekday !== 'Sun';
    try {
      await this.#everywhere(async () => {
        await refresh.call(this.#options.holdings, { minIntervalMs: 0, securities });
      });
    } catch (error) {
      this.#options.logger.warn('Cours en direct indisponibles', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Cours suivis et investissements programmés ; ne lève jamais. */
  async refreshPrices(): Promise<void> {
    const holdings = this.#options.holdings;
    if (!holdings) return;
    try {
      await this.#everywhere(async () => {
        const result = await holdings.refreshAll();
        if (result.instruments === 0) return;
        this.#options.logger.info('Cours et investissements programmés à jour', {
          instruments: result.instruments,
          quotes: result.quotes,
          executions: result.executions,
          errors: result.errors.length,
        });
        for (const error of result.errors.slice(0, 5)) this.#options.logger.warn(error);
      });
    } catch (error) {
      this.#options.logger.error('Mise à jour des cours en échec', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Exécute immédiatement une synchronisation complète (bouton « Synchroniser tout »). */
  async runSyncNow(): Promise<void> {
    await this.#everywhere(async () => {
      await this.#options.sync.syncAll('MANUAL');
    });
  }

  isRunning(): boolean {
    return this.#options.enabled && this.#syncJob !== null;
  }

  nextRun(): string | null {
    return this.#syncJob?.nextRun()?.toISOString() ?? null;
  }

  lastRun(): string | null {
    return this.#lastRunAt;
  }

  stop(): void {
    this.#syncJob?.stop();
    this.#backupJob?.stop();
    this.#snapshotJob?.stop();
    this.#pricesJob?.stop();
    this.#pricesJob = null;
    this.#liveJob?.stop();
    this.#liveJob = null;
    this.#syncJob = null;
    this.#backupJob = null;
    this.#snapshotJob = null;
  }
}