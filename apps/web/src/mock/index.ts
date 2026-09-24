/**
 * Routeur de la maquette : sert localement les réponses de l'API
 * quand le mode maquette est actif (VITE_MOCK=1 ou drapeau runtime).
 */
import type {
  HealthResponse,
  SessionResponse,
  SettingsDto,
  TransactionsQuery, ProfileResponse, DeviceSessionListResponse } from '@suiviinvest/api-contract';
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
import { assetSearch, demoAsset, holdingDetail, holdingsHistory, holdingsOverview } from './portfolio.ts';
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

/** Réponse de session simulée, complète (compte, rôle, nombre de comptes). */
function mockSession(authenticated: boolean): SessionResponse {
  return {
    authenticated,
    admin: authenticated,
    registrationOpen: false,
    csrfToken: authenticated ? MOCK_CSRF_TOKEN : null,
    needsSetup: false,
    username: 'proprietaire',
    role: 'OWNER',
    accountsCount: 1,
    usernameRequired: true,
    displayName: 'Compte démo',
    emailResetAvailable: false,
  };
}

/** Profil simulé du compte démo. */
function mockProfile(): ProfileResponse {
  return {
    id: 'owner',
    username: 'proprietaire',
    displayName: 'Compte démo',
    email: 'demo@exemple.fr',
    role: 'OWNER',
    createdAt: '2026-01-02T09:00:00.000Z',
    lastLoginAt: new Date().toISOString(),
    passwordChangedAt: '2026-01-02T09:00:00.000Z',
    hasRecoveryCode: true,
  };
}

/** Réponse simulée pour une requête donnée (aucune écriture réelle). */
export function mockRequest(url: string, method: string, body: unknown): unknown {
  const parsed = new URL(url, 'http://maquette.local');
  const path = parsed.pathname;
  const params = parsed.searchParams;

  if (path === '/api/auth/session') return mockSession(true) satisfies SessionResponse;
  if (path === '/api/auth/login' || path === '/api/auth/setup') {
    if (method === 'POST' && bodyField<string>(body, 'password', '') !== MOCK_PASSWORD && bodyField<string>(body, 'password', '') !== '') {
      return mockSession(true) satisfies SessionResponse;
    }
    return mockSession(true) satisfies SessionResponse;
  }
  if (path === '/api/auth/logout') return mockSession(false) satisfies SessionResponse;
  if (path === '/api/auth/google/status') return { enabled: false };
  if (path === '/api/auth/google/config') {
    return {
      configured: false,
      source: null,
      clientId: null,
      redirectUri: `${window.location.origin}/api/auth/google/callback`,
      origin: window.location.origin,
    };
  }
  if (path === '/api/auth/me') return mockProfile();
  if (path === '/api/auth/sessions') {
    return {
      sessions: [
        {
          id: 'demo',
          current: true,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          device: 'Ce navigateur',
          ip: null,
        },
      ],
    } satisfies DeviceSessionListResponse;
  }
  if (path === '/api/auth/accounts') return { accounts: [] };

  if (path === '/api/networth') return netWorthResponse(periodFrom(params));
  if (path === '/api/accounts') return accountsResponse();
  if (path === '/api/investments') return investmentsResponse(params.get('accountId'));
  if (path === '/api/holdings') return holdingsOverview();
  if (path === '/api/holdings/history') return holdingsHistory(periodFrom(params));
  if (path === '/api/holdings/search') return assetSearch(params.get('q') ?? '');
  if (path === '/api/holdings/refresh') return { instruments: 12, quotes: 12, errors: [], executions: 0 };
  if (path === '/api/holdings/plans') return holdingsOverview().plans;
  if (path === '/api/holdings/assets' && method === 'POST') {
    return { asset: demoAsset(bodyField<string>(body, 'symbol', 'NVDA')), quotes: 1250, warning: null };
  }
  if (path.startsWith('/api/holdings/assets/') && method === 'DELETE') return { ok: true, removedOperations: 0 };
  if (path.startsWith('/api/holdings/assets/') && !path.endsWith('/price')) {
    return holdingDetail(path.split('/')[4] ?? '', periodFrom(params));
  }
  if (path.startsWith('/api/holdings/')) {
    // Écritures de démonstration : acceptées, sans effet (aucune donnée réelle).
    if (path.startsWith('/api/holdings/plans')) return holdingsOverview().plans[0];
    if (path.startsWith('/api/holdings/operations') && method === 'POST') {
      return holdingDetail('ins-nvda', '1Y')?.operations[0];
    }
    return { ok: true };
  }
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
