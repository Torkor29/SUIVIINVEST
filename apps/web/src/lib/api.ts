/**
 * Client HTTP typé : un seul point d'entrée pour tous les appels API.
 * - session par cookie (`credentials: 'include'`) ;
 * - en-tête `x-csrf-token` sur les écritures ;
 * - erreurs normalisées en `ApiError` (contrat partagé) ;
 * - mode maquette activable au démarrage (VITE_MOCK=1) ET à l'exécution.
 */
import type { ApiError, ApiErrorCode } from '@suiviinvest/api-contract';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly json?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

/** Erreur applicative : porte le code du contrat et le statut HTTP. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  if (value === null || typeof value !== 'object') return false;
  const candidate = (value as { error?: unknown }).error;
  if (candidate === null || typeof candidate !== 'object') return false;
  const record = candidate as { code?: unknown; message?: unknown };
  return typeof record.code === 'string' && typeof record.message === 'string';
}

let csrfToken: string | null = null;
const MOCK_FLAG_KEY = 'suiviinvest:mock';

/** Jeton CSRF, récupéré depuis GET /api/auth/session. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function readStoredMockFlag(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  const stored = localStorage.getItem(MOCK_FLAG_KEY);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return null;
}

/** Mode maquette : drapeau runtime prioritaire, sinon variable d'environnement. */
export function isMockEnabled(): boolean {
  const stored = readStoredMockFlag();
  if (stored !== null) return stored;
  return import.meta.env.VITE_MOCK === '1';
}

/** Bascule le mode maquette sans reconstruction (drapeau runtime). */
export function setMockEnabled(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MOCK_FLAG_KEY, enabled ? '1' : '0');
}

export function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, `${value}`);
  }
  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

function toApiError(payload: unknown, status: number): ApiRequestError {
  if (isApiError(payload)) {
    return new ApiRequestError(payload.error.code, payload.error.message, status, payload.error.details);
  }
  return new ApiRequestError('INTERNAL', `Réponse inattendue du serveur (HTTP ${status}).`, status, payload);
}

/**
 * Charge la maquette à la demande : le bundle principal n'embarque pas les
 * fixtures tant que le mode maquette n'est pas activé au démarrage.
 */
async function mockDispatch<T>(url: string, method: HttpMethod, body: unknown): Promise<T> {
  const { mockRequest } = await import('../mock/index.ts');
  const payload = mockRequest(url, method, body);
  if (payload === null) {
    throw new ApiRequestError('NOT_FOUND', `Maquette : aucune réponse simulée pour ${method} ${url}.`, 404);
  }
  return payload as T;
}

/** Appel typé vers l'API (ou vers la maquette si le mode maquette est actif). */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method: HttpMethod = options.method ?? 'GET';
  const url = `${path}${buildQuery(options.query)}`;

  if (isMockEnabled()) {
    await mockLatency();
    return mockDispatch<T>(url, method, options.json ?? null);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    if (csrfToken === null) await ensureCsrfToken();
    if (csrfToken !== null) headers['x-csrf-token'] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError('INTERNAL', 'API injoignable — vérifiez que le serveur est démarré.', 0, error);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text === '' ? null : safeJsonParse(text);

  if (!response.ok) {
    const error = toApiError(payload, response.status);
    if (error.code === 'UNAUTHENTICATED') setCsrfToken(null);
    throw error;
  }
  return payload as T;
}

/** Récupère (et mémorise) le jeton CSRF avant une écriture. */
export async function ensureCsrfToken(): Promise<string | null> {
  try {
    const session = await request<{ readonly csrfToken: string | null }>('/api/auth/session');
    setCsrfToken(session.csrfToken);
  } catch {
    setCsrfToken(null);
  }
  return csrfToken;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Latence simulée courte : les squelettes de chargement restent visibles. */
function mockLatency(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, 120 + Math.random() * 240);
  });
}

/** Message utilisateur lisible à partir d'une erreur quelconque. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'UNAUTHENTICATED':
        return 'Session expirée : reconnectez-vous.';
      case 'INVALID_CREDENTIALS':
        // Le serveur fournit déjà un message volontairement générique.
        return error.message;
      case 'FORBIDDEN':
        return 'Action non autorisée.';
      case 'INVALID_REQUEST':
        return `Requête refusée : ${error.message}`;
      case 'NOT_FOUND':
        return 'Donnée introuvable.';
      case 'RATE_LIMITED':
        return 'Trop de requêtes : réessayez dans quelques secondes.';
      case 'CONNECTOR_ERROR':
        return `Erreur de synchronisation : ${error.message}`;
      case 'INTERNAL':
        return error.status === 0 ? 'API injoignable — vérifiez que le serveur est démarré.' : `Erreur serveur : ${error.message}`;
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Erreur inattendue.';
}
