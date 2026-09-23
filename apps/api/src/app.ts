import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  ConnectorRegistry,
  createDefaultRegistry,
  type ConnectorRegistry as RegistryType,
  type Logger,
} from '@suiviinvest/connectors';
import type { AppConfig } from './config.ts';
import { Db } from './db/database.ts';
import { AuditRepository, SettingsRepository } from './repositories/connections.ts';
import { PropertyRepository } from './repositories/properties.ts';
import { createLogger } from './logger.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAuthRoutes, sendError } from './routes/auth.ts';
import { registerManualRoutes } from './routes/manual.ts';
import { registerWealthRoutes } from './routes/wealth.ts';
import { registerWalletRoutes } from './routes/wallets.ts';
import { registerEnableBankingRoutes } from './routes/enable-banking.ts';
import type { HttpClient } from '@suiviinvest/connectors';
import { AuthService, SESSION_COOKIE } from './security/sessions.ts';
import { API_RATE_LIMIT, RateLimiter } from './security/rate-limit.ts';
import { SecretsStore } from './security/secrets.ts';
import { BackupService } from './services/backup.ts';
import { CryptoService } from './services/crypto.ts';
import { ImportService } from './services/imports.ts';
import { MarketDataService, type PriceProvider } from './services/marketdata.ts';
import { HoldingsService } from './services/holdings.ts';
import { MarketClient } from './services/market-client.ts';
import { registerHoldingsRoutes } from './routes/holdings.ts';
import { PortfolioService } from './services/portfolio.ts';
import { RealEstateService } from './services/realestate.ts';
import { SyncService } from './services/sync.ts';
import { createSidecarTransports } from './services/sidecar-registry.ts';
import { createMailer, type Mailer } from './services/mailer.ts';
import { createE2eConnectors } from './testing/e2e-connectors.ts';

/**
 * Assemblage de l'application HTTP.
 *
 * `buildApp()` retourne une instance Fastify non démarrée : les tests utilisent
 * `app.inject()` (aucun port ouvert, aucun réseau), le serveur l'écoute.
 *
 * Sécurité transverse, appliquée ici et pas dans les routes :
 *  - authentification exigée sur `/api/*` sauf `/api/auth/*` ;
 *  - jeton CSRF exigé sur toute méthode d'écriture ;
 *  - CORS restrictif (liste blanche explicite) ;
 *  - limitation de débit globale ;
 *  - erreurs normalisées et nettoyées : aucun détail interne ne fuit, aucun
 *    secret ne peut apparaître dans une réponse d'erreur.
 */

export interface AppDeps {
  readonly db: Db;
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly registry?: RegistryType;
  readonly providers?: readonly PriceProvider[];
  readonly now?: () => Date;
  /**
   * État de l'ordonnanceur, fourni par le serveur après construction : les routes
   * lisent l'état réel au moment de la requête (démarrer l'ordonnanceur après
   * `buildApp` ne doit pas figer une valeur `false`).
   */
  /** Envoi d'e-mails (tests : `MemoryMailer`). Par défaut, déduit de la configuration. */
  readonly mailer?: Mailer;
  /** Client HTTP des routes Enable Banking et des connecteurs (tests : réponses simulées). */
  readonly connectorHttp?: HttpClient;
  /** `fetch` des cours du portefeuille saisi à la main (tests : réponses simulées). */
  readonly marketFetch?: typeof fetch;
  readonly schedulerState?: { current: { isRunning: () => boolean; nextRun: () => string | null; lastRun: () => string | null } | null };
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly auth: AuthService;
  readonly secrets: SecretsStore;
  readonly sync: SyncService;
  readonly imports: ImportService;
  readonly marketData: MarketDataService;
  readonly backup: BackupService;
  readonly portfolio: PortfolioService;
  readonly crypto: CryptoService;
  readonly realEstate: RealEstateService;
  readonly settings: SettingsRepository;
  readonly audit: AuditRepository;
  readonly properties: PropertyRepository;
  readonly holdings: HoldingsService;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { db, config } = deps;
  const logger = deps.logger ?? createLogger({ level: config.logLevel });
  // Connecteurs factices réservés aux tests de bout en bout. Garde explicite :
  // jamais de doublure en production, même si la variable est mal configurée.
  const useE2eConnectors = config.e2eConnectors && config.env !== 'production';
  if (config.e2eConnectors && config.env === 'production') {
    logger.warn('SUIVIINVEST_E2E_CONNECTORS ignoré en production');
  }
  const registry =
    deps.registry ?? (useE2eConnectors ? new ConnectorRegistry(createE2eConnectors()) : createDefaultRegistry());
  if (useE2eConnectors) {
    logger.warn('Connecteurs FACTICES activés (tests de bout en bout) : aucun service réel n\'est contacté');
  }

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024 * 1024, // les exports CSV volumineux passent par le corps JSON
    ajv: { customOptions: { allErrors: true, removeAdditional: false } },
  });

  await app.register(cookie);

  const secrets = new SecretsStore(db, config.masterKey);
  const auth = new AuthService(db, {
    ttlMinutes: config.sessionTtlMinutes,
    cookieSecure: config.cookieSecure,
    masterKey: config.masterKey,
  });
  const mailer = deps.mailer ?? createMailer({ smtpUrl: config.smtpUrl, from: config.mailFrom });
  const audit = new AuditRepository(db);
  const settings = new SettingsRepository(db);
  const properties = new PropertyRepository(db);
  const portfolio = new PortfolioService(db, { baseCurrency: config.baseCurrency });
  const crypto = new CryptoService(db, { baseCurrency: config.baseCurrency });
  const realEstate = new RealEstateService(db);
  const marketData = new MarketDataService({
    db,
    ...(deps.providers ? { providers: deps.providers } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const holdings = new HoldingsService(db, {
    client: new MarketClient({
      ...(deps.marketFetch ? { fetchImpl: deps.marketFetch, retryDelayMs: 0 } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  // Sidecars Python (DEGIRO, Trade Republic) : branchés seulement sur le registre
  // réel. Non configurés, ils restent inertes et le connecteur le dit en clair.
  const sidecars =
    deps.registry === undefined && !useE2eConnectors ? createSidecarTransports({ logger }) : undefined;
  const sync = new SyncService(db, registry, secrets, {
    baseCurrency: config.baseCurrency,
    logger,
    integrationKeys: config.integrationKeys,
    ...(sidecars ? { sidecars: { ...sidecars } } : {}),
    ...(deps.connectorHttp ? { http: deps.connectorHttp } : {}),
  });
  const imports = new ImportService(db, { baseCurrency: config.baseCurrency, registry });
  const backup = new BackupService(db, {
    directory: config.backupDirectory,
    retentionDays: config.backupRetentionDays,
    ...(config.backupEncryption ? { masterKey: config.masterKey } : {}),
  });

  // Les synchronisations interrompues par un arrêt brutal sont marquées en échec.
  const staleRuns = db;
  const stale = staleRuns.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sync_runs WHERE status = 'RUNNING'",
  );
  if ((stale?.count ?? 0) > 0) {
    logger.warn('Synchronisations restées en cours au démarrage', { count: stale?.count });
  }

  /* ------------------------------------------------------------- middleware */

  const apiLimiter = new RateLimiter(API_RATE_LIMIT);

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    // Même origine (le site qui sert l'application) : ce n'est pas du CORS. Les
    // navigateurs envoient pourtant `Origin` sur les POST et les modules JS ;
    // les refuser casserait l'appli derrière un tunnel ou un domaine qui change.
    if (origin && isSameOrigin(origin, request.headers, config)) return undefined;
    if (origin) {
      if (!config.corsOrigins.includes(origin)) {
        // CORS restrictif : aucune origine tierce n'est autorisée par défaut.
        reply.header('vary', 'Origin');
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Origine non autorisée.' },
        });
      }
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-allow-headers', 'content-type, x-csrf-token');
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
    return undefined;
  });

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (path === '/health' || path.startsWith('/assets/') || path === '/' || path === '/index.html') {
      return undefined;
    }
    if (!path.startsWith('/api/')) return undefined;

    const limit = apiLimiter.record(request.ip);
    if (!limit.allowed) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Trop de requêtes, ralentissez.');
    }

    if (path.startsWith('/api/auth/')) {
      // Seul /api/auth/logout est protégé par CSRF plus bas (via session valide).
      return undefined;
    }

    const session = auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
    if (!session) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Session expirée ou absente.');
    }

    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    if (isWrite) {
      const token = request.headers['x-csrf-token'];
      if (!auth.verifyCsrf(session, typeof token === 'string' ? token : null)) {
        return sendError(reply, 403, 'FORBIDDEN', 'Jeton CSRF manquant ou invalide.');
      }
    }
    (request as { session?: unknown }).session = session;
    return undefined;
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof z.ZodError) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Requête invalide.', error.flatten());
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const rawMessage = error instanceof Error ? error.message : 'erreur inconnue';
    const message = status >= 500 ? 'Erreur interne du serveur.' : rawMessage;
    logger.error('Requête en erreur', {
      method: request.method,
      url: request.url.split('?')[0] ?? request.url,
      status,
      message: rawMessage,
    });
    return sendError(reply, status, status >= 500 ? 'INTERNAL' : 'INVALID_REQUEST', message);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return sendError(reply, 404, 'NOT_FOUND', 'Ressource inconnue.');
    }
    // SPA : toute route non-API renvoie l'index de l'application.
    if (config.staticDirectory && existsSync(`${config.staticDirectory}/index.html`)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Ressource inconnue.' } });
  });

  /* ----------------------------------------------------------------- routes */

  await registerAuthRoutes(app, { auth, audit, mailer, publicUrl: config.publicUrl, logger });
  await registerWealthRoutes(app, { db, portfolio, crypto, realEstate, properties });
  // Saisie manuelle : indispensable pour les sources qui ne fournissent pas les
  // positions (Crédit Agricole) — l'utilisateur complète ce que l'API ne donne pas.
  await registerManualRoutes(app, { db });
  // Portefeuille saisi à la main : actifs, achats, ventes, investissements programmés.
  await registerHoldingsRoutes(app, { holdings, audit });
  // Portefeuilles EVM : état par chaîne et resynchronisation d'un wallet.
  await registerWalletRoutes(app, { db, sync });
  // Banques via Enable Banking : configuration, choix de la banque, retour d'autorisation.
  await registerEnableBankingRoutes(app, {
    db,
    secrets,
    sync,
    logger,
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    redirectUrl: config.enableBankingRedirectUrl,
    integrationKeys: config.integrationKeys,
    ...(deps.connectorHttp ? { http: deps.connectorHttp } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  await registerAdminRoutes(app, {
    db,
    registry,
    secrets,
    sync,
    imports,
    marketData,
    backup,
    audit,
    settings,
    logger,
    config: {
      baseCurrency: config.baseCurrency,
      schedulerEnabled: config.schedulerEnabled,
      schedulerCron: config.schedulerCron,
      snapshotCron: config.snapshotCron,
      backupCron: config.backupCron,
      backupDirectory: config.backupDirectory,
      backupRetentionDays: config.backupRetentionDays,
      sessionTtlMinutes: config.sessionTtlMinutes,
      backupsEncrypted: config.backupEncryption,
      emailConfigured: mailer.configured,
      databasePath: config.databasePath,
      version: config.version,
    },
    startedAt: Date.now(),
    scheduler: {
      isRunning: () => deps.schedulerState?.current?.isRunning() ?? config.schedulerEnabled,
      nextRun: () => deps.schedulerState?.current?.nextRun() ?? null,
      lastRun: () => deps.schedulerState?.current?.lastRun() ?? null,
    },
  });

  if (config.staticDirectory && existsSync(config.staticDirectory)) {
    await app.register(fastifyStatic, {
      root: config.staticDirectory,
      prefix: '/',
      wildcard: false,
      setHeaders: (response, path) => {
        if (path.endsWith('.html')) {
          response.setHeader('cache-control', 'no-cache');
        }
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('referrer-policy', 'same-origin');
      },
    });
  }

  return { app, db, auth, secrets, sync, imports, marketData, backup, portfolio, crypto, realEstate, settings, audit, properties, holdings };
}

/**
 * L'origine de la requête est-elle le site lui-même ?
 *
 * Comparée à l'hôte demandé (`Host`, ou `X-Forwarded-Host` derrière un proxy de
 * confiance) et à `SUIVIINVEST_PUBLIC_URL`. Un autre site reste refusé.
 */
export function isSameOrigin(
  origin: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  config: Pick<AppConfig, 'trustProxy' | 'publicUrl'>,
): boolean {
  let originHost: string;
  let originUrl: string;
  try {
    const parsed = new URL(origin);
    originHost = parsed.host.toLowerCase();
    originUrl = parsed.origin.toLowerCase();
  } catch {
    return false;
  }
  if (config.publicUrl !== null) {
    try {
      if (new URL(config.publicUrl).origin.toLowerCase() === originUrl) return true;
    } catch {
      /* adresse publique mal formée : ignorée */
    }
  }
  const first = (value: string | string[] | undefined): string | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw === undefined || raw === '' ? null : (raw.split(',')[0] ?? '').trim().toLowerCase();
  };
  const candidates = [first(headers.host)];
  if (config.trustProxy) candidates.push(first(headers['x-forwarded-host']));
  return candidates.some((host) => host !== null && host === originHost);
}
