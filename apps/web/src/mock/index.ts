/**
 * Routeur de la maquette : sert localement les réponses de l'API
 * quand le mode maquette est actif (VITE_MOCK=1 ou drapeau runtime).
 */
import type {
  HealthResponse,
  SessionResponse,
  SettingsDto,
  TransactionsQuery,
} from '@suiviinvest/api-contract';
import {
  accountsResponse,
  cryptoResponse,
  investmentsResponse,
  netWorthResponse,
  propertyDto,
  realEstateResponse,
  transactionsResponse,
} from './selectors.ts';
import {
  analyzeImport,
  analyticsResponse,
  commitImport,
  connectionsResponse,
  healthResponse,
  importHistory,
  incomeResponse,
  marketRefresh,
  settingsDto,
  syncRuns,
} from './reporting.ts';
import { MOCK_WALLETS, mockSyncAllResponse, mockSyncOutcome, mockWalletResync } from './sync.ts';
import type { PeriodKey } from '@suiviinvest/api-contract';

export const MOCK_CSRF_TOKEN = 'mock-csrf-token';

export interface MockSession extends SessionResponse {
  readonly authenticated: boolean;
}

const MOCK_PASSWORD = 'patrimoine';

/** Contexte mutable minimal : la maquette « retient » le thème et les actions. */
const state: { theme: SettingsDto['theme']; lastSyncAt: string } = {
  theme: 'system',
  lastSyncAt: '2026-09-21T06:12:09Z',
};

function periodFrom(params: URLSearchParams): PeriodKey {
  const raw = params.get('period');
  const allowed: readonly PeriodKey[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'MAX'];
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as PeriodKey) : '1Y';
}

function queryFrom(params: URLSearchParams): TransactionsQuery {
  const numberOrUndefined = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const stringOrUndefined = (key: string): string | undefined => {
    const raw = params.get(key);
    return raw === null || raw === '' ? undefined : raw;
  };
  return {
    from: stringOrUndefined('from'),
    to: stringOrUndefined('to'),
    providerId: stringOrUndefined('providerId'),
    accountId: stringOrUndefined('accountId'),
    type: stringOrUndefined('type'),
    currency: stringOrUndefined('currency'),
    minAmount: numberOrUndefined('minAmount'),
    maxAmount: numberOrUndefined('maxAmount'),
    search: stringOrUndefined('search'),
    limit: numberOrUndefined('limit'),
    cursor: stringOrUndefined('cursor'),
  };
}

function bodyField<T>(body: unknown, field: string, fallback: T): T {
  if (body === null || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  const value = record[field];
  return (value === undefined || value === null ? fallback : (value as T));
}

/** Réponse simulée pour une requête donnée (aucune écriture réelle). */
export function mockRequest(url: string, method: string, body: unknown): unknown {
  const parsed = new URL(url, 'http://maquette.local');
  const path = parsed.pathname;
  const params = parsed.searchParams;

  if (path === '/api/auth/session') return { authenticated: true, csrfToken: MOCK_CSRF_TOKEN, needsSetup: false } satisfies SessionResponse;
  if (path === '/api/auth/login' || path === '/api/auth/setup') {
    if (method === 'POST' && bodyField<string>(body, 'password', '') !== MOCK_PASSWORD && bodyField<string>(body, 'password', '') !== '') {
      return { authenticated: true, csrfToken: MOCK_CSRF_TOKEN, needsSetup: false } satisfies SessionResponse;
    }
    return { authenticated: true, csrfToken: MOCK_CSRF_TOKEN, needsSetup: false } satisfies SessionResponse;
  }
  if (path === '/api/auth/logout') return { authenticated: true, csrfToken: MOCK_CSRF_TOKEN, needsSetup: false } satisfies SessionResponse;

  if (path === '/api/networth') return netWorthResponse(periodFrom(params));
  if (path === '/api/accounts') return accountsResponse();
  if (path === '/api/investments') return investmentsResponse(params.get('accountId'));
  if (path === '/api/crypto') return cryptoResponse();
  if (path === '/api/real-estate') return realEstateResponse();
  const propertyMatch = /^\/api\/real-estate\/([^/]+)$/.exec(path);
  if (propertyMatch !== null && propertyMatch[1] !== undefined) {
    const property = propertyDto(decodeURIComponent(propertyMatch[1]));
    if (property === null) return null;
    return property;
  }
  if (path.startsWith('/api/real-estate/') && path.endsWith('/cashflows')) return { ok: true };
  if (/^\/api\/real-estate\/[^/]+\/cashflows\/[^/]+$/.test(path)) return { ok: true };
  if (path === '/api/transactions') return transactionsResponse(queryFrom(params));
  if (path === '/api/income') return incomeResponse(periodFrom(params));
  if (path === '/api/analytics') return analyticsResponse(periodFrom(params));
  if (path === '/api/connections') return connectionsResponse();
  if (/^\/api\/connections\/[^/]+\/runs$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    return syncRuns(id === '' ? null : id);
  }
  if (/^\/api\/connections\/[^/]+\/(test|sync)$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    state.lastSyncAt = new Date().toISOString();
    return mockSyncOutcome(id);
  }
  if (path === '/api/connections/sync-all') {
    state.lastSyncAt = new Date().toISOString();
    return mockSyncAllResponse();
  }
  if (path === '/api/wallets') return [...MOCK_WALLETS];
  if (/^\/api\/wallets\/[^/]+\/resync$/.test(path)) {
    const accountId = decodeURIComponent(path.split('/')[3] ?? '');
    state.lastSyncAt = new Date().toISOString();
    return mockWalletResync(accountId);
  }
  if (/^\/api\/connections\/[^/]+$/.test(path)) {
    return method === 'DELETE' ? { ok: true } : { ok: true };
  }
  if (path === '/api/imports') return importHistory();
  if (path === '/api/imports/analyze') return analyzeImport(bodyField<string>(body, 'filename', 'import.csv'), bodyField<string>(body, 'content', ''));
  if (path === '/api/imports/commit') {
    return commitImport(
      bodyField<string>(body, 'filename', 'import.csv'),
      bodyField<string>(body, 'content', ''),
      bodyField<boolean>(body, 'dryRun', false),
    );
  }
  if (path === '/api/settings') {
    if (method === 'PATCH') {
      const theme = bodyField<SettingsDto['theme'] | null>(body, 'theme', null);
      if (theme !== null) state.theme = theme;
    }
    return { ...settingsDto(), theme: state.theme } satisfies SettingsDto;
  }
  if (path === '/api/market-data/refresh') return marketRefresh();
  if (path === '/api/backup/export') return { ok: true, path: '/var/lib/suiviinvest/backups/manuel.db' };
  if (path === '/health') return { ...healthResponse(), lastSyncAt: state.lastSyncAt } satisfies HealthResponse;

  return null;
}
