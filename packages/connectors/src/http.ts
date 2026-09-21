import { ConnectorError, redact, type HttpClient, type HttpResponse, type HttpRequestOptions } from './connector.ts';

/**
 * Client HTTP par défaut.
 *
 * - `fetch` natif (Node 22+) : aucune dépendance externe ;
 * - timeouts par requête (un fournisseur qui pend ne bloque pas une synchro) ;
 * - retry avec backoff sur 429/5xx uniquement (jamais sur 4xx métier) ;
 * - respect de `Retry-After` ;
 * - toute erreur est passée par `redact()` avant de devenir un message.
 */

export interface FetchHttpClientOptions {
  readonly providerId: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** En-tête `User-Agent` : certains fournisseurs refusent les clients anonymes. */
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  /** Hook d'observabilité : appelé pour chaque requête (méthode, URL redigée, statut). */
  readonly onRequest?: (event: { method: string; url: string; status: number; durationMs: number }) => void;
}

export class FetchHttpClient implements HttpClient {
  readonly #providerId: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #onRequest: FetchHttpClientOptions['onRequest'];

  constructor(options: FetchHttpClientOptions) {
    this.#providerId = options.providerId;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#userAgent = options.userAgent ?? 'SuiviInvest/0.1 (read-only personal finance)';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#onRequest = options.onRequest;
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const method = options.method ?? 'GET';
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= this.#maxRetries) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          method,
          headers: {
            'User-Agent': this.#userAgent,
            Accept: 'application/json, text/csv, text/plain, */*',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: options.body } : {}),
          signal: controller.signal,
          redirect: 'follow',
        });
        const text = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        this.#onRequest?.({ method, url: redact(url), status: response.status, durationMs: Date.now() - started });

        if (response.status === 429 || response.status >= 500) {
          if (attempt < this.#maxRetries) {
            await this.sleep(this.#retryDelay(headers, attempt));
            attempt++;
            continue;
          }
        }
        if (response.status === 401 || response.status === 403) {
          throw new ConnectorError(
            this.#providerId,
            'AUTH_REQUIRED',
            `Accès refusé (${response.status}) sur ${redact(url)} : authentification ou consentement à renouveler`,
          );
        }
        return { status: response.status, headers, text };
      } catch (error) {
        lastError = error;
        if (error instanceof ConnectorError) throw error;
        if (attempt < this.#maxRetries) {
          await this.sleep(this.#retryDelay({}, attempt));
          attempt++;
          continue;
        }
        const message = error instanceof Error ? redact(error.message) : 'erreur inconnue';
        throw new ConnectorError(this.#providerId, 'NETWORK', `Échec de la requête ${redact(url)} : ${message}`, {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ConnectorError(this.#providerId, 'PROVIDER_BROKEN', `Échec après ${this.#maxRetries + 1} tentatives`, {
      cause: lastError,
    });
  }

  async json<T>(url: string, options?: HttpRequestOptions): Promise<T> {
    const response = await this.request(url, options);
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new ConnectorError(
        this.#providerId,
        'PROVIDER_BROKEN',
        `Réponse non JSON (${response.status}) sur ${redact(url)} — format probablement modifié`,
      );
    }
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  #retryDelay(headers: Readonly<Record<string, string>>, attempt: number): number {
    const retryAfter = headers['retry-after'];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    }
    return Math.min(1000 * 2 ** attempt, 15_000);
  }
}

/** Client HTTP de test : réponses scriptées par URL, aucune sortie réseau. */
export class FakeHttpClient implements HttpClient {
  readonly requests: { url: string; options: HttpRequestOptions }[] = [];
  readonly #routes: { match: RegExp; respond: HttpResponse | ((url: string) => HttpResponse) }[] = [];

  constructor(routes: { match: RegExp | string; respond: HttpResponse | unknown }[] = []) {
    for (const route of routes) {
      const match = typeof route.match === 'string' ? new RegExp(route.match) : route.match;
      const respond =
        typeof route.respond === 'object' && route.respond !== null && 'status' in route.respond
          ? (route.respond as HttpResponse)
          : ({ status: 200, headers: {}, text: JSON.stringify(route.respond) } satisfies HttpResponse);
      this.#routes.push({ match, respond });
    }
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.requests.push({ url, options });
    for (const route of this.#routes) {
      if (route.match.test(url)) {
        return typeof route.respond === 'function' ? route.respond(url) : route.respond;
      }
    }
    return { status: 404, headers: {}, text: JSON.stringify({ error: 'not_mocked', url }) };
  }

  async json<T>(url: string, options?: HttpRequestOptions): Promise<T> {
    const response = await this.request(url, options);
    return JSON.parse(response.text) as T;
  }

  async sleep(): Promise<void> {
    // pas d'attente en test
  }
}

/** Journal de test : capture les lignes pour les assertions. */
export function createTestLogger(): {
  logger: import('./connector.ts').Logger;
  lines: { level: string; message: string; meta?: Record<string, unknown> }[];
} {
  const lines: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    lines.push({ level, message: redact(message), ...(meta ? { meta } : {}) });
  };
  return {
    lines,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}