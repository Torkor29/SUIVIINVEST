import {
  degiroConnector,
  tradeRepublicConnector,
  type Logger,
  type SidecarTransport,
} from '@suiviinvest/connectors';
import {
  createSidecarTransport,
  type SidecarEndpointConfig,
  type SidecarExecConfig,
} from './sidecar.ts';

/**
 * Fabrique des transports de sidecar pour les sources qui n'existent qu'en Python.
 *
 * Elle ne dépend d'aucun framework : l'agent d'intégration l'appelle au démarrage
 * (`createSidecarTransports(config)`) et injecte le résultat dans
 * `SyncServiceOptions.sidecars`. Les clés sont les noms de sidecar attendus par les
 * connecteurs — `degiro` et `trade-republic` — et non les identifiants de
 * fournisseur (`trade_republic`) :
 *
 *   const sidecars = createSidecarTransports({ logger });
 *   new SyncService(db, registry, secrets, { baseCurrency: 'EUR', logger, sidecars });
 *
 * Configuration par variables d'environnement (aucun secret ici) :
 *
 *   SUIVIINVEST_SIDECAR_DEGIRO_COMMAND=/opt/sidecar/degiro/sidecar.py
 *   SUIVIINVEST_SIDECAR_DEGIRO_ARGS=["python3"]        (facultatif, JSON)
 *   SUIVIINVEST_SIDECAR_DEGIRO_URL=http://127.0.0.1:9310   (mode HTTP, prioritaire)
 *   SUIVIINVEST_SIDECAR_TRADE_REPUBLIC_COMMAND=…
 *
 * Un sidecar non configuré reste présent dans le dictionnaire retourné : son
 * `isAvailable()` vaut `false` et ses appels renvoient `NOT_SUPPORTED` avec un
 * message expliquant comment l'activer, plutôt que de faire échouer le démarrage.
 *
 * Les transports configurés sont aussi déclarés aux connecteurs concernés, afin
 * que `capabilities.api` reflète la réalité (`true` seulement si le sidecar est
 * réellement disponible). Voir `docs/connectors/sidecars.md`.
 */

export const SIDECAR_PROVIDERS = ['degiro', 'trade-republic'] as const;
export type SidecarProviderName = (typeof SIDECAR_PROVIDERS)[number];

/** Sidecar que `Connector` accepte de configurer (méthode ajoutée par les providers). */
interface SidecarAware {
  configureSidecar(transport: SidecarTransport | null): void;
}

export interface SidecarProviderConfig {
  /** Exécutable à lancer (chemin ou commande du PATH). */
  readonly command?: string;
  /** Arguments de la commande (ex. `['sidecar/degiro/sidecar.py']`). */
  readonly args?: readonly string[];
  /** Variables d'environnement supplémentaires — jamais des identifiants. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** URL du service HTTP local (prioritaire sur `command`). */
  readonly url?: string | null;
  readonly timeoutMs?: number;
}

export interface SidecarTransportsConfig {
  readonly degiro?: SidecarProviderConfig;
  readonly 'trade-republic'?: SidecarProviderConfig;
  /** Délai par défaut de tous les sidecars, en millisecondes. */
  readonly timeoutMs?: number;
  /** Environnement consulté en repli (par défaut `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  /**
   * Déclarer les transports aux connecteurs pour ajuster `capabilities.api`.
   * `true` par défaut ; passer `false` pour ne pas muter l'état global (tests).
   */
  readonly register?: boolean;
}

export interface SidecarTransports {
  readonly degiro: SidecarTransport;
  readonly 'trade-republic': SidecarTransport;
}

/** Préfixe d'environnement d'un sidecar : `SUIVIINVEST_SIDECAR_DEGIRO`. */
export function sidecarEnvPrefix(provider: SidecarProviderName): string {
  return `SUIVIINVEST_SIDECAR_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Résout l'endpoint d'un sidecar : paramètre explicite d'abord, puis environnement
 * (`…_URL` prioritaire, sinon `…_COMMAND`). Retourne `null` si rien n'est configuré.
 */
export function resolveSidecarEndpoint(
  provider: SidecarProviderName,
  config: SidecarProviderConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
  defaultTimeoutMs?: number,
): SidecarEndpointConfig | null {
  const prefix = sidecarEnvPrefix(provider);
  const url = config?.url ?? env[`${prefix}_URL`] ?? null;
  const command = config?.command ?? env[`${prefix}_COMMAND`] ?? null;
  const timeoutMs =
    config?.timeoutMs ?? parseTimeout(env[`${prefix}_TIMEOUT_MS`]) ?? defaultTimeoutMs;

  if (typeof url === 'string' && url.trim() !== '') {
    return { type: 'http', url: url.trim(), ...(timeoutMs ? { timeoutMs } : {}) };
  }
  if (typeof command === 'string' && command.trim() !== '') {
    const args = config?.args ?? parseArgs(env[`${prefix}_ARGS`]);
    const exec: SidecarExecConfig = {
      command: command.trim(),
      ...(args ? { args } : {}),
      ...(config?.env ? { env: config.env } : {}),
      ...(config?.cwd ? { cwd: config.cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    return exec;
  }
  return null;
}

/**
 * Construit les deux transports (`degiro`, `trade-republic`) et, sauf
 * `register: false`, les déclare aux connecteurs. Un transport non configuré est
 * inerte : `isAvailable() === false` et ses appels renvoient `NOT_SUPPORTED`.
 */
export function createSidecarTransports(config: SidecarTransportsConfig = {}): SidecarTransports {
  const env = config.env ?? process.env;
  const register = config.register ?? true;

  const build = (provider: SidecarProviderName): SidecarTransport => {
    const endpoint = resolveSidecarEndpoint(
      provider,
      config[provider],
      env,
      config.timeoutMs,
    );
    const logger = config.logger;
    const transport = createSidecarTransport(
      provider,
      // Endpoint inerte quand rien n'est configuré : le message d'erreur reste
      // actionnable (voir ProcessSidecarTransport#unavailableMessage).
      endpoint ?? { command: '' },
      { ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}), ...(logger ? { logger } : {}) },
    );
    return transport;
  };

  const degiro = build('degiro');
  const tradeRepublic = build('trade-republic');

  if (register) {
    (degiroConnector as unknown as SidecarAware).configureSidecar(degiro);
    (tradeRepublicConnector as unknown as SidecarAware).configureSidecar(tradeRepublic);
  }

  return { degiro, 'trade-republic': tradeRepublic };
}
