import { buildApp } from './app.ts';
import { describeConfig, loadConfig } from './config.ts';
import { Db } from './db/database.ts';
import { createLogger } from './logger.ts';
import { SyncRunRepository } from './repositories/connections.ts';
import { Scheduler } from './scheduler.ts';

/**
 * Point d'entrée du serveur.
 *
 * Séquence de démarrage : configuration validée -> migrations -> application ->
 * ordonnanceur -> écoute. En cas d'échec de configuration (par exemple clé
 * maîtresse absente en production), le processus s'arrête : on ne démarre jamais
 * une application financière dans un état dégradé silencieux.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  logger.info('Démarrage de SuiviInvest', describeConfig(config));

  const db = new Db(config.databasePath);
  const applied = db.migrate();
  if (applied.length > 0) {
    logger.info('Migrations appliquées', {
      migrations: applied.map((migration) => `${migration.version}:${migration.name}`),
    });
  }

  // Une synchronisation laissée « en cours » par un arrêt brutal est marquée en
  // échec, sinon l'interface afficherait indéfiniment un état « Syncing ».
  const stale = new SyncRunRepository(db).markStaleAsFailed();
  if (stale > 0) logger.warn('Synchronisations interrompues marquées en échec', { count: stale });

  const schedulerState: { current: Scheduler | null } = { current: null };
  const built = await buildApp({ db, config, logger, schedulerState });

  const scheduler = new Scheduler({
    enabled: config.schedulerEnabled,
    syncCron: config.schedulerCron,
    backupCron: config.backupCron,
    snapshotCron: config.snapshotCron,
    logger,
    sync: built.sync,
    backup: built.backup,
    // Le relevé quotidien est enregistré par l'application : il est marqué
    // `RECORDED`, par opposition à l'historique reconstruit depuis les activités.
    snapshots: {
      recordDailySnapshot: () => built.portfolio.recordDailySnapshot(),
    },
  });
  scheduler.start();
  schedulerState.current = scheduler;

  await built.app.listen({ host: config.host, port: config.port });
  logger.info('Serveur à l\'écoute', { host: config.host, port: config.port });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('Arrêt demandé', { signal });
    scheduler.stop();
    try {
      await built.app.close();
      db.close();
      logger.info('Arrêt propre terminé');
      process.exit(0);
    } catch (error) {
      logger.error('Erreur pendant l\'arrêt', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Promesse rejetée non gérée', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((error: unknown) => {
  // Dernier filet : une erreur de démarrage doit être visible et non silencieuse.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'Échec du démarrage', error: message })}\n`);
  process.exit(1);
});