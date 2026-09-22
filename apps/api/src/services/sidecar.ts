import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  redact,
  type Logger,
  type SidecarRequest,
  type SidecarResponse,
  type SidecarTransport,
} from '@suiviinvest/connectors';

/**
 * Transport vers un « sidecar » Python.
 *
 * Pourquoi un sidecar : DEGIRO et Trade Republic ne sont exploitables que par des
 * bibliothèques Python non officielles (`degiro-connector`, `pytr`) dont la licence
 * et le runtime ne doivent pas contaminer l'application Node. Le sidecar est donc
 * un **processus séparé** : l'application lui écrit une requête JSON sur l'entrée
 * standard et lit une réponse JSON sur la sortie standard — ou, si une URL locale
 * est configurée, un aller-retour HTTP. Le cœur de l'application ne connaît que
 * cette interface (`SidecarTransport`), qu'il peut simuler en test.
 *
 * Contrat (voir `docs/connectors/sidecars.md`) :
 *
 *   requête  : { operation, params, secrets, timeoutMs }
 *   succès   : { ok: true,  data: ..., warnings?: [...] }
 *   échec    : { ok: false, code, message, requiresUserAction?: boolean }
 *
 * `code` est un `ConnectorError['kind']`. Une réponse illisible ou incohérente est
 * traduite en `PROVIDER_BROKEN` ; un binaire absent en `NOT_SUPPORTED` avec un
 * message actionnable ; un dépassement de délai en `PROVIDER_DOWN`.
 *
 * Sécurité : les secrets voyagent DANS la requête (jamais par variables
 * d'environnement, jamais écrits sur disque), et aucune valeur secrète n'est
 * journalisée ni recopiée dans un message d'erreur (`scrubSecrets`).
 */

/* --------------------------------------------------------------- constantes */

/** Codes acceptés dans une réponse de sidecar, alignés sur `ConnectorError.kind`. */
const KNOWN_CODES = [
  'AUTH_REQUIRED',
  'MFA_REQUIRED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'PROVIDER_BROKEN',
  'PROVIDER_DOWN',
  'SYNC_ERROR',
  'NETWORK',
  'DATA',
  'NOT_SUPPORTED',
] as const;

type KnownCode = (typeof KNOWN_CODES)[number];

function isKnownCode(value: string): value is KnownCode {
  return (KNOWN_CODES as readonly string[]).includes(value);
}

const DEFAULT_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------- configuration */

/** Sidecar lancé comme un exécutable (stdin/stdout JSON). */
export interface SidecarExecConfig {
  readonly command: string;
  readonly args?: readonly string[];
  /** Variables d'environnement SUPPLÉMENTAIRES du processus (jamais des secrets). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Sidecar joignable en HTTP local (optionnel). */
export interface SidecarHttpConfig {
  readonly type: 'http';
  readonly url: string;
  readonly timeoutMs?: number;
}

export type SidecarEndpointConfig = SidecarExecConfig | SidecarHttpConfig;

export function isHttpEndpoint(config: SidecarEndpointConfig): config is SidecarHttpConfig {
  return (config as SidecarHttpConfig).type === 'http' || 'url' in config;
}

export interface SidecarTransportOptions {
  readonly name: string;
  readonly endpoint: SidecarEndpointConfig;
  readonly defaultTimeoutMs?: number;
  readonly logger?: Logger;
}

/* ------------------------------------------------------------ erreur interne */

class SidecarTimeoutError extends Error {
  constructor() {
    super('délai dépassé');
    this.name = 'SidecarTimeoutError';
  }
}

/* ------------------------------------------------------------- assainissement */

/**
 * Retire toute valeur secrète d'un texte avant qu'il ne parte dans un log ou un
 * message d'erreur : `redact()` masque les motifs connus, puis chaque secret
 * transmis est remplacé littéralement (un mot de passe ne ressemble à aucun motif).
 */
export function scrubSecrets(text: string, secrets?: Readonly<Record<string, string>>): string {
  let out = redact(text);
  for (const value of Object.values(secrets ?? {})) {
    if (typeof value === 'string' && value.length >= 2) {
      out = out.split(value).join('***');
    }
  }
  return out;
}

/* ------------------------------------------------------------ lecture réponse */

function broken(provider: string, detail: string): SidecarResponse<never> {
  return {
    ok: false,
    code: 'PROVIDER_BROKEN',
    message: `Réponse invalide du sidecar « ${provider} » : ${detail}`,
  };
}

/**
 * Valide une sortie brute de sidecar. Toute anomalie de forme devient
 * `PROVIDER_BROKEN` (le fournisseur est joignable mais son comportement a changé) :
 * aucune donnée n'est devinée à partir d'une réponse douteuse.
 */
export function parseSidecarResponse<T>(
  raw: string,
  provider: string,
  secrets?: Readonly<Record<string, string>>,
): SidecarResponse<T> {
  const trimmed = raw.trim();
  if (trimmed === '') return broken(provider, 'aucune sortie sur stdout');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return broken(provider, `JSON illisible (${scrubSecrets(trimmed.slice(0, 120), secrets)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return broken(provider, 'la réponse n’est pas un objet JSON');
  }

  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    if (!('data' in record)) return broken(provider, 'champ « data » absent malgré ok:true');
    const warnings = Array.isArray(record.warnings)
      ? record.warnings.map((item) => scrubSecrets(String(item), secrets))
      : undefined;
    return {
      ok: true,
      data: record.data as T,
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
  }

  if (record.ok === false) {
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (code === '') return broken(provider, 'échec sans champ « code »');
    if (!isKnownCode(code)) return broken(provider, `code d’erreur inconnu « ${code} »`);
    return {
      ok: false,
      code,
      message: message === '' ? `Échec du sidecar « ${provider} »` : scrubSecrets(message, secrets),
      requiresUserAction: record.requiresUserAction === true,
    };
  }

  return broken(provider, 'champ « ok » absent ou non booléen');
}

/* ---------------------------------------------------------------- transport */

/** Transport `SidecarTransport` : exécutable local ou service HTTP local. */
export class ProcessSidecarTransport implements SidecarTransport {
  readonly name: string;
  #endpoint: SidecarEndpointConfig;
  #defaultTimeoutMs: number;
  #logger: Logger | undefined;

  constructor(options: SidecarTransportOptions) {
    this.name = options.name;
    this.#endpoint = options.endpoint;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger;
  }

  /**
   * Le sidecar est « disponible » si son URL est renseignée ou si son binaire
   * existe. Un nom de commande nu (`python3`) est supposé résolvable via `PATH` :
   * on ne cherche pas à deviner, l'échec de spawn le signalera explicitement.
   */
  isAvailable(): boolean {
    if (isHttpEndpoint(this.#endpoint)) return this.#endpoint.url.trim() !== '';
    const command = this.#endpoint.command?.trim() ?? '';
    if (command === '') return false;
    if (command.includes('/') || command.includes('\\')) return existsSync(command);
    return true;
  }

  async call<T = unknown>(request: SidecarRequest): Promise<SidecarResponse<T>> {
    if (!this.isAvailable()) {
      return {
        ok: false,
        code: 'NOT_SUPPORTED',
        message: this.#unavailableMessage(),
      };
    }

    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const payload = JSON.stringify({
      operation: request.operation,
      params: request.params ?? {},
      secrets: request.secrets ?? {},
      timeoutMs,
    });

    // Aucune valeur secrète n'est journalisée : seuls le nom et l'opération le sont.
    this.#logger?.debug(`Sidecar ${this.name} : appel de « ${request.operation} »`, {
      provider: this.name,
      operation: request.operation,
      transport: isHttpEndpoint(this.#endpoint) ? 'http' : 'exec',
    });

    try {
      const raw = isHttpEndpoint(this.#endpoint)
        ? await this.#callHttp(this.#endpoint, payload, timeoutMs)
        : await this.#callExec(this.#endpoint, payload, timeoutMs);
      const response = parseSidecarResponse<T>(raw, this.name, request.secrets);
      if (!response.ok) {
        this.#logger?.warn(`Sidecar ${this.name} : échec normalisé (${response.code})`, {
          provider: this.name,
          operation: request.operation,
          code: response.code,
        });
      }
      return response;
    } catch (error) {
      return this.#transportFailure(error, request.secrets);
    }
  }

  #unavailableMessage(): string {
    if (isHttpEndpoint(this.#endpoint)) {
      return (
        `Sidecar « ${this.name} » non configuré : aucune URL ` +
        `(SUIVIINVEST_SIDECAR_${envSlug(this.name)}_URL) n’est définie. ` +
        'Voir docs/connectors/sidecars.md.'
      );
    }
    const command = this.#endpoint.command?.trim() ?? '';
    if (command === '') {
      return (
        `Sidecar « ${this.name} » non configuré : aucun exécutable ni URL n’est défini. ` +
        `Définissez SUIVIINVEST_SIDECAR_${envSlug(this.name)}_COMMAND ou ` +
        `SUIVIINVEST_SIDECAR_${envSlug(this.name)}_URL, après avoir installé les dépendances ` +
        'Python (voir sidecar/README.md).'
      );
    }
    return (
      `Sidecar « ${this.name} » non configuré : l’exécutable « ${command} » est introuvable. ` +
      `Définissez SUIVIINVEST_SIDECAR_${envSlug(this.name)}_COMMAND (ou _URL) et installez les ` +
      'dépendances Python (voir sidecar/README.md).'
    );
  }

  #transportFailure(error: unknown, secrets?: Readonly<Record<string, string>>): SidecarResponse<never> {
    if (error instanceof SidecarTimeoutError) {
      return {
        ok: false,
        code: 'PROVIDER_DOWN',
        message:
          `Sidecar « ${this.name} » : délai dépassé. ` +
          'Le fournisseur ne répond pas ; réessayez plus tard (`timeoutMs` ajustable).',
      };
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { ok: false, code: 'NOT_SUPPORTED', message: this.#unavailableMessage() };
    }
    if (code === 'EACCES') {
      return {
        ok: false,
        code: 'NOT_SUPPORTED',
        message:
          `Sidecar « ${this.name} » : exécutable non exécutable (permission refusée). ` +
          'Rendez-le exécutable ou lancez-le via un interpréteur (python3 …).',
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: 'PROVIDER_BROKEN',
      message: `Sidecar « ${this.name} » : échec d’exécution (${scrubSecrets(message, secrets)}).`,
    };
  }

  /** Lance l'exécutable, écrit la requête sur stdin, lit stdout ; délai strict. */
  async #callExec(
    endpoint: SidecarExecConfig,
    payload: string,
    timeoutMs: number,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(endpoint.command, [...(endpoint.args ?? [])], {
        cwd: endpoint.cwd,
        env: { ...process.env, ...(endpoint.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new SidecarTimeoutError());
      }, timeoutMs);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      // Éviter une EPIPE non gérée si le processus meurt avant de lire stdin.
      child.stdin?.on('error', () => undefined);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdout.trim() === '' && code !== 0) {
          reject(new Error(`sortie vide, code ${code ?? 'inconnu'} — ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin?.end(payload);
    });
  }

  /** Variante HTTP locale : POST du même objet JSON, réponse JSON en corps. */
  async #callHttp(endpoint: SidecarHttpConfig, payload: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok && text.trim() === '') {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

function envSlug(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Fabrique simple : un transport pour un sidecar nommé. */
export function createSidecarTransport(
  name: string,
  endpoint: SidecarEndpointConfig,
  options: { timeoutMs?: number; logger?: Logger } = {},
): SidecarTransport {
  return new ProcessSidecarTransport({
    name,
    endpoint,
    defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    logger: options.logger,
  });
}
