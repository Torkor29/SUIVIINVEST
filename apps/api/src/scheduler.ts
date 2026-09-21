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
  readonly logger: Logger;
  readonly sync: SyncService;
  readonly backup: BackupService;
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
  #lastRunAt: string | null = null;

  constructor(options: SchedulerOptions) {
    this.#options = options;
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
          const outcomes = await sync.syncAll('SCHEDULED');
          logger.info('Synchronisation planifiée terminée', {
            total: outcomes.length,
            succeeded: outcomes.filter((outcome) => outcome.status === 'SUCCESS').length,
            failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
            created: outcomes.reduce((acc, outcome) => acc + outcome.created, 0),
          });
        } catch (error) {
          logger.error('Synchronisation planifiée en échec', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    this.#backupJob = new Cron(this.#options.backupCron, { protect: true }, () => {
      try {
        const files = backup.create('all');
        logger.info('Sauvegarde automatique effectuée', { files: files.map((file) => file.name) });
      } catch (error) {
        logger.error('Sauvegarde automatique en échec', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    logger.info('Ordonnanceur démarré', {
      syncCron: this.#options.syncCron,
      backupCron: this.#options.backupCron,
      nextSync: this.#syncJob.nextRun()?.toISOString() ?? null,
      nextBackup: this.#backupJob.nextRun()?.toISOString() ?? null,
    });
  }

  /** Exécute immédiatement une synchronisation complète (bouton « Synchroniser tout »). */
  async runSyncNow(): Promise<void> {
    await this.#options.sync.syncAll('MANUAL');
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
    this.#syncJob = null;
    this.#backupJob = null;
  }
}