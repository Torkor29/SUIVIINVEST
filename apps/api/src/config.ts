import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Configuration de l'application.
 *
 * Security-first :
 *  - aucun secret n'a de valeur par défaut utilisable en production ;
 *  - le master secret vient EXCLUSIVEMENT de l'environnement (jamais de la base) ;
 *  - la configuration est validée au démarrage : mieux vaut refuser de démarrer
 *    que tourner avec un chiffrement absent.
 */

export interface AppConfig {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  /** Clé maître de chiffrement des secrets (32 octets dérivés d'ici). */
  readonly masterKey: string;
  readonly baseCurrency: string;
  readonly sessionTtlMinutes: number;
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;
  readonly corsOrigins: readonly string[];
  readonly schedulerEnabled: boolean;
  readonly schedulerCron: string;
  readonly backupDirectory: string;
  readonly backupCron: string;
  /** Heure du relevé quotidien du patrimoine (Mission 2 §9). */
  readonly snapshotCron: string;
  /** Rafraîchissement des cours suivis et exécution des investissements programmés. */
  readonly pricesCron: string;
  readonly backupRetentionDays: number;
  readonly marketDataProviders: readonly string[];
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly staticDirectory: string | null;
  readonly version: string;
  /**
   * Clés d'API de fournisseurs tiers, lues depuis `SUIVIINVEST_KEY_<NOM>`.
   *
   * Un connecteur les demande par nom logique : `ctx.secrets.get('etherscan_api_key')`
   * résout d'abord un secret saisi dans l'interface (chiffré en base), puis cette
   * table issue de l'environnement. Les clés ne sont donc jamais en base ni en Git,
   * et restent remplaçables sans redéploiement du code.
   */
  readonly integrationKeys: Readonly<Record<string, string>>;
  /**
   * Active les connecteurs factices pour les tests de bout en bout.
   * Refusé en production (garde explicite dans `buildApp`).
   */
  readonly e2eConnectors: boolean;
  /**
   * Envoi d'e-mails (liens « mot de passe oublié »). Facultatif :
   * `smtp://utilisateur:motdepasse@smtp.exemple.fr:587` ou `smtps://…:465`.
   */
  readonly smtpUrl: string | null;
  readonly mailFrom: string | null;
  /** Adresse publique de l'application, pour construire les liens envoyés par e-mail. */
  readonly publicUrl: string | null;
  /**
   * Adresse de retour après autorisation bancaire (Enable Banking). Par défaut :
   * adresse publique + /connexions/banque. Elle doit être déclarée à l'identique
   * dans l'application Enable Banking.
   */
  readonly enableBankingRedirectUrl: string | null;
  /** Chiffre les sauvegardes sur le disque avec une clé dérivée de la clé maîtresse. */
  readonly backupEncryption: boolean;
}

const DEFAULTS = {
  port: 9123,
  baseCurrency: 'EUR',
  sessionTtlMinutes: 720,
  schedulerCron: '0 */6 * * *',
  backupCron: '30 3 * * *',
  snapshotCron: '15 0 * * *',
  // Cours du portefeuille saisi à la main + investissements programmés :
  // matin, midi, après la clôture européenne et après la clôture américaine.
  pricesCron: '5 8,13,18,23 * * *',
  backupRetentionDays: 30,
  logLevel: 'info' as const,
};

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  if (!value) return [...fallback];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function requireInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Valeur numérique invalide : ${value}`);
  }
  return parsed;
}

/** Extrait les clés `SUIVIINVEST_KEY_<NOM>` sans jamais les journaliser. */
function parseIntegrationKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const prefix = 'SUIVIINVEST_KEY_';
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || typeof value !== 'string') continue;
    const logicalName = name.slice(prefix.length).toLowerCase();
    if (logicalName === '' || value.trim() === '') continue;
    keys[logicalName] = value.trim();
  }
  return keys;
}

export class ConfigError extends Error {}

/**
 * Charge la configuration.
 *
 * En production, `SUIVIINVEST_MASTER_KEY` est obligatoire : sans elle les
 * identifiants des connecteurs ne peuvent pas être chiffrés, et refuser de
 * démarrer est le seul comportement acceptable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.NODE_ENV as AppConfig['env'] | undefined) ?? 'development';
  const isProduction = mode === 'production';

  let masterKey = env.SUIVIINVEST_MASTER_KEY ?? '';
  if (masterKey === '') {
    if (isProduction) {
      throw new ConfigError(
        'SUIVIINVEST_MASTER_KEY est obligatoire en production (chiffrement des secrets au repos). ' +
          'Générez-la avec : openssl rand -base64 48',
      );
    }
    // Développement uniquement : clé éphémère, donc les secrets deviennent
    // illisibles au redémarrage — c'est volontaire et journalisé au démarrage.
    masterKey = env.NODE_ENV === 'test' ? 'test-master-key-not-secret' : randomBytes(48).toString('base64');
  }
  if (masterKey.length < 16) {
    throw new ConfigError('SUIVIINVEST_MASTER_KEY trop courte : 32 caractères minimum.');
  }

  const databasePath = resolve(env.SUIVIINVEST_DB ?? './data/suiviinvest.db');
  mkdirSync(dirname(databasePath), { recursive: true });

  const backupDirectory = resolve(env.SUIVIINVEST_BACKUP_DIR ?? './data/backups');
  if (!existsSync(backupDirectory)) mkdirSync(backupDirectory, { recursive: true });

  const staticDirectory = env.SUIVIINVEST_WEB_DIR ? resolve(env.SUIVIINVEST_WEB_DIR) : null;

  return {
    env: mode,
    host: env.SUIVIINVEST_HOST ?? '0.0.0.0',
    port: requireInt(env.SUIVIINVEST_PORT, DEFAULTS.port),
    databasePath,
    masterKey,
    baseCurrency: (env.SUIVIINVEST_BASE_CURRENCY ?? DEFAULTS.baseCurrency).toUpperCase(),
    sessionTtlMinutes: requireInt(env.SUIVIINVEST_SESSION_TTL_MINUTES, DEFAULTS.sessionTtlMinutes),
    cookieSecure: parseBoolean(env.SUIVIINVEST_COOKIE_SECURE, isProduction),
    trustProxy: parseBoolean(env.SUIVIINVEST_TRUST_PROXY, isProduction),
    // CORS restrictif : par défaut aucune origine tierce. En dev, le serveur Vite.
    corsOrigins: parseList(env.SUIVIINVEST_CORS_ORIGINS, isProduction ? [] : ['http://localhost:5173']),
    schedulerEnabled: parseBoolean(env.SUIVIINVEST_SCHEDULER_ENABLED, true),
    schedulerCron: env.SUIVIINVEST_SCHEDULER_CRON ?? DEFAULTS.schedulerCron,
    backupDirectory,
    backupCron: env.SUIVIINVEST_BACKUP_CRON ?? DEFAULTS.backupCron,
    snapshotCron: env.SUIVIINVEST_SNAPSHOT_CRON ?? DEFAULTS.snapshotCron,
    pricesCron: env.SUIVIINVEST_PRICES_CRON ?? DEFAULTS.pricesCron,
    backupRetentionDays: requireInt(env.SUIVIINVEST_BACKUP_RETENTION_DAYS, DEFAULTS.backupRetentionDays),
    marketDataProviders: parseList(env.SUIVIINVEST_MARKET_PROVIDERS, ['yahoo', 'coingecko', 'ecb']),
    logLevel: (env.SUIVIINVEST_LOG_LEVEL as AppConfig['logLevel']) ?? DEFAULTS.logLevel,
    staticDirectory,
    version: env.SUIVIINVEST_VERSION ?? '0.2.0',
    integrationKeys: parseIntegrationKeys(env),
    e2eConnectors: parseBoolean(env.SUIVIINVEST_E2E_CONNECTORS, false),
    smtpUrl: nonEmpty(env.SUIVIINVEST_SMTP_URL),
    mailFrom: nonEmpty(env.SUIVIINVEST_MAIL_FROM),
    publicUrl: nonEmpty(env.SUIVIINVEST_PUBLIC_URL)?.replace(/\/+$/, '') ?? null,
    backupEncryption: parseBoolean(env.SUIVIINVEST_BACKUP_ENCRYPTION, true),
    enableBankingRedirectUrl: nonEmpty(env.SUIVIINVEST_ENABLEBANKING_REDIRECT_URL),
  };
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Résumé de configuration sûr à journaliser : jamais de valeur de secret.
 * Utilisé une seule fois au démarrage.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    databasePath: config.databasePath,
    baseCurrency: config.baseCurrency,
    masterKey: config.masterKey ? '***' : 'ABSENTE',
    scheduler: config.schedulerEnabled ? config.schedulerCron : 'désactivé',
    backup: `${config.backupDirectory} (${config.backupCron}, rétention ${config.backupRetentionDays} j)`,
    snapshotCron: config.snapshotCron,
    marketDataProviders: config.marketDataProviders,
    // Noms des clés présentes, jamais leurs valeurs.
    integrationKeys: Object.keys(config.integrationKeys).sort(),
    e2eConnectors: config.e2eConnectors,
    // Présence seulement : l'URL SMTP contient un mot de passe.
    email: config.smtpUrl ? 'configuré' : 'non configuré',
    publicUrl: config.publicUrl,
    backupEncryption: config.backupEncryption,
    staticDirectory: config.staticDirectory,
    version: config.version,
  };
}