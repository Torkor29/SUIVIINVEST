/**
 * Limitation de débit et résilience réseau par provider EVM.
 *
 * Deux mécanismes complémentaires, tous deux branchés sur le client HTTP
 * INJECTABLE (`ctx.http`) — donc entièrement simulables en test :
 *
 *  1. **Token bucket** par provider : les APIs d'exploration plafonnent à
 *     quelques requêtes/seconde (Etherscan gratuit : 3 req/s). On lisse les
 *     appels au lieu de se faire bannir.
 *  2. **Retry avec backoff** sur `429` (trop de requêtes) et `5xx` (panne
 *     temporaire), avec respect de `Retry-After`, plus un **timeout** par
 *     requête pour qu'un provider qui pend ne fige jamais une synchronisation.
 *
 * Aucune erreur ne fuit : les messages passent par `redact()`.
 */

import {
  ConnectorError,
  redact,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
} from '../connector.ts';

/* ------------------------------------------------------------ politiques */

export interface RateLimitPolicy {
  /** Débit soutenu, en requêtes par seconde. */
  readonly requestsPerSecond: number;
  /** Rafale autorisée (jetons disponibles d'un coup). */
  readonly burst: number;
}

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Timeout par défaut appliqué à chaque requête. */
  readonly timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  timeoutMs: 20_000,
};

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = { requestsPerSecond: 3, burst: 3 };

/**
 * Plafonds par provider, alignés sur les limites documentées/raisonnables :
 *  - Etherscan V2 (palier gratuit) : 3 req/s, 100 000 appels/jour ;
 *  - Blockscout : publique, plus permissive mais non contractuelle ;
 *  - Alchemy : 10 req/s côté gratuit ;
 *  - Routescan : proche d'Etherscan.
 */
export const PROVIDER_RATE_LIMITS: Readonly<Record<string, RateLimitPolicy>> = {
  etherscan: { requestsPerSecond: 3, burst: 3 },
  blockscout: { requestsPerSecond: 5, burst: 5 },
  alchemy: { requestsPerSecond: 10, burst: 10 },
  routescan: { requestsPerSecond: 3, burst: 3 },
};

export function rateLimitFor(provider: string): RateLimitPolicy {
  return PROVIDER_RATE_LIMITS[provider] ?? DEFAULT_RATE_LIMIT;
}

/* ------------------------------------------------------------ token bucket */

export type SleepFn = (ms: number) => Promise<void>;

/**
 * Token bucket à refill continu. L'horloge est injectable : en test, elle est
 * figée et `sleep` est instantané, donc aucun test ne dure réellement.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(policy: RateLimitPolicy = DEFAULT_RATE_LIMIT, now: () => number = Date.now) {
    this.#capacity = Math.max(policy.burst, 1);
    this.#refillPerMs = Math.max(policy.requestsPerSecond, 1) / 1000;
    this.#now = now;
    this.#tokens = this.#capacity;
    this.#lastRefill = now();
  }

  /** Jeton disponible immédiatement ? */
  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = now;
  }

  /** Attend (via `sleep`) qu'un jeton soit disponible. */
  async acquire(sleep: SleepFn): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const missing = 1 - this.#tokens;
      const waitMs = Math.max(1, Math.ceil(missing / this.#refillPerMs));
      await sleep(waitMs);
    }
  }
}

/* -------------------------------------------------- client HTTP protégé */

export interface ProviderHttpOptions {
  readonly provider: string;
  readonly rateLimit?: RateLimitPolicy;
  readonly retry?: RetryPolicy;
  /** Horloge pour le token bucket (injectable en test). */
  readonly now?: () => number;
  /** Observabilité : appelé avant chaque tentative de retry (jamais de secret). */
  readonly onRetry?: (event: {
    provider: string;
    attempt: number;
    status: number | null;
    delayMs: number;
    url: string;
  }) => void;
}

export interface AttemptRecord {
  readonly url: string;
  readonly attempt: number;
  readonly status: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(headers: Readonly<Record<string, string>>, maxDelayMs: number): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxDelayMs);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxDelayMs);
  return null;
}

/**
 * Enveloppe un `HttpClient` avec limitation de débit, retry et timeout.
 * Le client sous-jacent reste injectable : on n'archive jamais `fetch` en direct.
 */
export class ProviderHttpClient {
  readonly provider: string;
  readonly attempts: AttemptRecord[] = [];
  readonly #http: HttpClient;
  readonly #bucket: TokenBucket;
  readonly #retry: RetryPolicy;
  readonly #onRetry: ProviderHttpOptions['onRetry'];

  constructor(http: HttpClient, options: ProviderHttpOptions) {
    this.#http = http;
    this.provider = options.provider;
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#bucket = new TokenBucket(options.rateLimit ?? rateLimitFor(options.provider), options.now);
    this.#onRetry = options.onRetry;
  }

  #delay(attempt: number, headers?: Readonly<Record<string, string>>): number {
    const fromHeader = headers ? retryAfterMs(headers, this.#retry.maxDelayMs) : null;
    if (fromHeader !== null) return fromHeader;
    return Math.min(this.#retry.baseDelayMs * 2 ** attempt, this.#retry.maxDelayMs);
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const timeoutMs = options.timeoutMs ?? this.#retry.timeoutMs;
    let attempt = 0;

    for (;;) {
      await this.#bucket.acquire((ms) => this.#http.sleep(ms));
      this.attempts.push({ url: redact(url), attempt, status: 0 });

      let response: HttpResponse;
      try {
        response = await this.#http.request(url, { ...options, timeoutMs });
      } catch (error) {
        // Erreur d'E/S (timeout, DNS, connexion coupée) : nouvelle tentative.
        if (attempt < this.#retry.maxRetries) {
          const delay = this.#delay(attempt);
          this.#onRetry?.({ provider: this.provider, attempt, status: null, delayMs: delay, url: redact(url) });
          await this.#http.sleep(delay);
          attempt += 1;
          continue;
        }
        if (error instanceof ConnectorError) throw error;
        const message = error instanceof Error ? redact(error.message) : 'erreur inconnue';
        throw new ConnectorError(
          this.provider,
          'NETWORK',
          `Requête impossible vers ${redact(url)} après ${attempt + 1} tentative(s) : ${message}`,
          { cause: error },
        );
      }

      const record = this.attempts[this.attempts.length - 1];
      if (record) (record as { status: number }).status = response.status;

      if (isRetryableStatus(response.status) && attempt < this.#retry.maxRetries) {
        const delay = this.#delay(attempt, response.headers);
        this.#onRetry?.({
          provider: this.provider,
          attempt,
          status: response.status,
          delayMs: delay,
          url: redact(url),
        });
        await this.#http.sleep(delay);
        attempt += 1;
        continue;
      }

      if (response.status === 429) {
        throw new ConnectorError(
          this.provider,
          'RATE_LIMITED',
          `Le fournisseur ${this.provider} limite le débit (429) sur ${redact(url)} après réessais.`,
        );
      }
      if (response.status >= 500) {
        throw new ConnectorError(
          this.provider,
          'PROVIDER_DOWN',
          `Le fournisseur ${this.provider} est en panne (${response.status}) sur ${redact(url)}.`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ConnectorError(
          this.provider,
          'AUTH_REQUIRED',
          `Accès refusé (${response.status}) par ${this.provider} : clé d'API manquante ou invalide.`,
        );
      }
      return response;
    }
  }

  /** `request` + décodage JSON : une réponse non JSON est une erreur explicite. */
  async json<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.request(url, options);
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new ConnectorError(
        this.provider,
        'PROVIDER_BROKEN',
        `Réponse non JSON de ${this.provider} (${response.status}) sur ${redact(url)} — format probablement modifié.`,
      );
    }
  }
}
