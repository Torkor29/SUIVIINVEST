import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectorRegistry,
  createDefaultRegistry,
  type Connector,
  type ConnectorContext,
  type NormalizedTransaction,
} from '@suiviinvest/connectors';
import type { AssetKind, AccountType, ProviderId } from '@suiviinvest/core';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/database.ts';
import { createSilentLogger } from '../src/logger.ts';
import { StaticPriceProvider } from '../src/services/marketdata.ts';
import type { Mailer } from '../src/services/mailer.ts';

/**
 * Utilitaires de test.
 *
 * Chaque test travaille sur une base SQLite temporaire réelle (pas un mock) :
 * les migrations, les index uniques et les transactions sont donc exercés pour
 * de vrai. Les connecteurs sont remplacés par des doublures déterministes, ce qui
 * garantit qu'aucun test n'a besoin d'identifiants ni d'accès réseau.
 */

export interface TestContext {
  readonly app: BuiltApp;
  readonly db: Db;
  readonly directory: string;
  readonly registry: ConnectorRegistry;
  cleanup(): Promise<void>;
}

export interface TestConnectorOptions {
  readonly id?: ProviderId;
  readonly displayName?: string;
  readonly accounts?: readonly {
    externalAccountId: string;
    name: string;
    type: AccountType;
    currency: string;
  }[];
  readonly transactions?: readonly NormalizedTransaction[];
  readonly failWith?: Error;
  readonly onAccountsCalled?: () => void;
}

/** Connecteur factice configurable : erreurs, latence et données contrôlées. */
export function createTestConnector(options: TestConnectorOptions = {}): Connector {
  const id = options.id ?? 'degiro';
  return {
    id,
    displayName: options.displayName ?? `Test ${id}`,
    capabilities: {
      accounts: true,
      balances: false,
      positions: true,
      transactions: true,
      income: false,
      api: true,
    },
    importFormats: [],
    requiredConfig: [],
    requiredSecrets: [],
    async testConnection() {
      if (options.failWith) return { ok: false, status: 'ERROR', message: options.failWith.message };
      return { ok: true, status: 'CONNECTED', message: 'ok' };
    },
    async syncAccounts() {
      options.onAccountsCalled?.();
      if (options.failWith) throw options.failWith;
      return (options.accounts ?? []).map((account) => ({
        externalAccountId: account.externalAccountId,
        name: account.name,
        type: account.type,
        currency: account.currency,
        rawSourceType: 'TEST',
      }));
    },
    async syncBalances() {
      return [];
    },
    async syncPositions() {
      if (options.failWith) throw options.failWith;
      return [];
    },
    async syncTransactions() {
      if (options.failWith) throw options.failWith;
      return { items: options.transactions ?? [], cursor: { value: null } };
    },
    async syncIncome() {
      return [];
    },
    async getSyncStatus(_ctx: ConnectorContext) {
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message: 'ok',
        requiresUserAction: false,
      };
    },
  };
}

export interface TestAppOptions {
  readonly connectors?: readonly Connector[];
  readonly providers?: Parameters<typeof buildApp>[0]['providers'];
  readonly env?: Record<string, string>;
  readonly mailer?: Mailer;
  readonly connectorHttp?: Parameters<typeof buildApp>[0]['connectorHttp'];
  /** Google simulé (connexion avec Google). */
  readonly googleFetch?: typeof fetch;
  /** Réseau des cours (portefeuille saisi à la main) ; par défaut : aucun accès. */
  readonly marketFetch?: typeof fetch;
  readonly now?: () => Date;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestContext> {
  const directory = mkdtempSync(join(tmpdir(), 'suiviinvest-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    SUIVIINVEST_DB: join(directory, 'test.db'),
    SUIVIINVEST_BACKUP_DIR: join(directory, 'backups'),
    SUIVIINVEST_MASTER_KEY: 'cle-de-test-suffisamment-longue-pour-hkdf',
    SUIVIINVEST_SCHEDULER_ENABLED: '0',
    SUIVIINVEST_LOG_LEVEL: 'error',
    ...(options.env ?? {}),
  });
  const db = new Db(config.databasePath);
  db.migrate();
  // Par défaut on utilise les connecteurs réels (test d'intégration) ; les tests
  // qui ont besoin de données contrôlées passent leurs propres doublures.
  const registry = options.connectors
    ? new ConnectorRegistry(options.connectors)
    : createDefaultRegistry();
  const app = await buildApp({
    db,
    config,
    logger: createSilentLogger(),
    registry,
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.connectorHttp ? { connectorHttp: options.connectorHttp } : {}),
    marketFetch:
      options.marketFetch ??
      (async () => {
        throw new Error('Réseau désactivé en test');
      }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.googleFetch ? { googleFetch: options.googleFetch } : {}),
    providers: options.providers ?? [
      new StaticPriceProvider({
        quotes: { unset: [] },
        fx: [{ base: 'USD', quote: 'EUR', date: '2024-01-01', rate: 0.9, source: 'test' }],
      }),
    ],
  });

  return {
    app,
    db,
    directory,
    registry,
    async cleanup() {
      await app.app.close();
      try {
        db.close();
      } catch {
        // base déjà fermée
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Authentifie un client de test et retourne le cookie + le jeton CSRF. */
export async function login(
  context: TestContext,
  password = 'mot-de-passe-de-test',
): Promise<{ cookie: string; csrfToken: string }> {
  const setup = await context.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password },
  });
  const cookie = extractCookie(setup.headers['set-cookie']);
  const body = setup.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

export function extractCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? (header[0] as string) : (header ?? '');
  return value.split(';')[0] ?? '';
}

/** Requête authentifiée : injecte cookie et jeton CSRF automatiquement. */
export async function authRequest(
  context: TestContext,
  session: { cookie: string; csrfToken: string },
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ statusCode: number; json: () => unknown; body: string }> {
  const response = await context.app.app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
    },
  });
  return { statusCode: response.statusCode, json: () => response.json(), body: response.body };
}

/** Crée un compte directement en base (raccourci pour les tests de calcul). */
export function seedAccount(
  db: Db,
  input: {
    id?: string;
    name: string;
    type: AccountType;
    providerId?: ProviderId;
    currency?: string;
    initialBalance?: number;
    externalAccountId?: string | null;
  },
): string {
  const id = input.id ?? `acc-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO accounts (id, name, type, provider_id, currency, initial_balance, is_active,
       external_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    id,
    input.name,
    input.type,
    input.providerId ?? 'manual',
    input.currency ?? 'EUR',
    input.initialBalance ?? 0,
    input.externalAccountId ?? null,
    now,
    now,
  );
  return id;
}

export function seedInstrument(
  db: Db,
  input: { id?: string; name: string; isin?: string | null; symbol?: string | null; kind?: AssetKind; currency?: string },
): string {
  const id = input.id ?? `ins-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO instruments (id, kind, symbol, isin, name, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.kind ?? 'EQUITY',
    input.symbol ?? null,
    input.isin ?? null,
    input.name,
    input.currency ?? 'EUR',
    now,
    now,
  );
  return id;
}

export function seedQuote(db: Db, instrumentId: string, date: string, close: number): void {
  db.run(
    `INSERT INTO quotes (instrument_id, date, close, currency, provider, fetched_at) VALUES (?, ?, ?, 'EUR', 'test', ?)
     ON CONFLICT(instrument_id, date) DO UPDATE SET close = excluded.close`,
    instrumentId,
    date,
    close,
    new Date().toISOString(),
  );
}

export function seedFx(db: Db, base: string, quote: string, date: string, rate: number): void {
  db.run(
    `INSERT INTO fx_rates (base, quote, date, rate, source) VALUES (?, ?, ?, ?, 'test')
     ON CONFLICT(base, quote, date, source) DO UPDATE SET rate = excluded.rate`,
    base,
    quote,
    date,
    rate,
  );
}

export function seedActivity(
  db: Db,
  input: {
    id?: string;
    accountId: string;
    instrumentId?: string | null;
    type: string;
    date: string;
    quantity?: number | null;
    unitPrice?: number | null;
    amount: number;
    currency?: string;
    fees?: number;
    providerId?: string;
  },
): string {
  const id = input.id ?? `act-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO activities (id, account_id, instrument_id, type, date, quantity, unit_price, amount,
       currency, fees, taxes, provider_id, last_synced_at, dedup_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    id,
    input.accountId,
    input.instrumentId ?? null,
    input.type,
    input.date,
    input.quantity ?? null,
    input.unitPrice ?? null,
    input.amount,
    input.currency ?? 'EUR',
    input.fees ?? 0,
    input.providerId ?? 'manual',
    now,
    `seed-${id}`,
    now,
    now,
  );
  return id;
}