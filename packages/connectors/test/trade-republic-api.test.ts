import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorError,
  type ConnectorContext,
  type SidecarRequest,
  type SidecarResponse,
  type SidecarTransport,
} from '../src/index.ts';
import {
  fetchTradeRepublicSavingsPlans,
  tradeRepublicConnector,
} from '../src/providers/trade-republic.ts';
import { makeTestContext } from './helpers.ts';

/**
 * Mode API du connecteur Trade Republic, testé hors ligne avec un sidecar SIMULÉ.
 * Vérifie notamment que la validation mobile remonte « Validation Trade Republic
 * requise » avec `requiresUserAction: true`, et que la synchronisation REPREND
 * au second appel.
 */

interface Recording {
  readonly transport: SidecarTransport;
  readonly calls: SidecarRequest[];
}

function fakeTransport(
  handler: (request: SidecarRequest) => SidecarResponse | Promise<SidecarResponse>,
  options: { available?: boolean } = {},
): Recording {
  const calls: SidecarRequest[] = [];
  const transport: SidecarTransport = {
    name: 'trade-republic',
    isAvailable: () => options.available ?? true,
    async call<T = unknown>(request: SidecarRequest): Promise<SidecarResponse<T>> {
      calls.push(request);
      return (await handler(request)) as SidecarResponse<T>;
    },
  };
  return { transport, calls };
}

function ctxWithSidecar(
  transport: SidecarTransport,
  secrets: Record<string, string> = {},
): { ctx: ConnectorContext; lines: { level: string; message: string; meta?: Record<string, unknown> }[] } {
  const { ctx, lines } = makeTestContext({ secrets });
  return { ctx: { ...ctx, sidecars: { 'trade-republic': transport } }, lines };
}

const SUCCESS_DATA: Readonly<Record<string, unknown>> = {
  test: { library: 'pytr', readOnly: true },
  portfolio: {
    accounts: [
      { id: 'securities', name: 'Portefeuille Trade Republic', currency: 'EUR', type: 'SECURITIES', balance: 1200 },
      { id: 'cash', name: 'Compte espèces Trade Republic', currency: 'EUR', type: 'CASH', balance: 500.25 },
    ],
    positions: [
      {
        accountId: 'securities',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 1.23456789,
        price: 97.42,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  cash: { balances: [{ accountId: 'cash', date: '2026-04-15', cash: 500.25, currency: 'EUR' }] },
  positions: {
    positions: [
      {
        accountId: 'securities',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 1.23456789,
        price: 97.42,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  transactions: {
    transactions: [
      {
        accountId: 'securities',
        id: 'tr-tx-1',
        date: '2026-04-01',
        category: 'TRADING',
        type: 'BUY',
        description: 'Achat Exemple Monde UCITS ETF',
        name: 'Exemple Monde UCITS ETF',
        isin: 'FR0000000001',
        quantity: 5,
        price: 100,
        amount: -500,
        currency: 'EUR',
        fees: 0.99,
        taxes: 0,
      },
      {
        accountId: 'cash',
        id: 'tr-tx-2',
        date: '2026-04-05',
        category: 'CASH',
        type: 'TRANSFER_INSTANT_INBOUND',
        description: 'Virement reçu',
        amount: 300,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
      },
    ],
    cursor: null,
  },
  income: {
    income: [
      {
        accountId: 'cash',
        id: 'tr-div-1',
        date: '2026-04-09',
        type: 'DIVIDEND',
        description: 'Dividende Exemple Monde',
        amount: 4.56,
        currency: 'EUR',
        withholdingTax: 0.68,
      },
    ],
  },
  savingsplans: {
    savingsPlans: [
      {
        id: 'sp-1',
        isin: 'FR0000000001',
        name: 'Plan Exemple Monde',
        amount: 50,
        interval: 'MONTHLY',
        currency: 'EUR',
        active: true,
      },
    ],
  },
};

function successHandler(request: SidecarRequest): SidecarResponse {
  const data = SUCCESS_DATA[request.operation];
  if (data === undefined) return { ok: false, code: 'NOT_SUPPORTED', message: `inconnu: ${request.operation}` };
  return { ok: true, data };
}

test('TR API : succès complet — normalisation et opérations attendues', async () => {
  const { transport, calls } = fakeTransport(successHandler);
  const { ctx } = ctxWithSidecar(transport, {
    trade_republic_phone: '+33000000000',
    trade_republic_pin: '0000',
  });

  const accounts = await tradeRepublicConnector.syncAccounts(ctx);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.externalAccountId, 'trade-republic-securities');
  assert.equal(accounts[1]?.type, 'CASH');

  const balances = await tradeRepublicConnector.syncBalances(ctx, accounts);
  assert.equal(balances[0]?.externalAccountId, 'trade-republic-cash');
  assert.equal(balances[0]?.cash, 500.25);

  const positions = await tradeRepublicConnector.syncPositions(ctx, accounts);
  assert.equal(positions[0]?.isin, 'FR0000000001');
  assert.equal(positions[0]?.kind, 'ETF');
  assert.equal(positions[0]?.quantity, 1.23456789);

  const transactions = await tradeRepublicConnector.syncTransactions(ctx, { since: '2026-01-01' });
  assert.equal(transactions.items.length, 2);
  const buy = transactions.items.find((item) => item.type === 'BUY');
  assert.equal(buy?.externalAccountId, 'trade-republic-securities');
  assert.equal(buy?.amount, -500);
  assert.equal(buy?.fees, 0.99);
  const transfer = transactions.items.find((item) => item.type === 'TRANSFER_IN');
  assert.equal(transfer?.externalAccountId, 'trade-republic-cash');
  assert.equal(transfer?.amount, 300);

  const income = await tradeRepublicConnector.syncIncome(ctx, {});
  assert.equal(income[0]?.type, 'DIVIDEND');
  assert.equal(income[0]?.withholdingTax, 0.68);

  const plans = await fetchTradeRepublicSavingsPlans(ctx);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.isin, 'FR0000000001');
  assert.equal(plans[0]?.amount, 50);
  assert.equal(plans[0]?.active, true);

  assert.deepEqual(
    calls.map((call) => call.operation),
    ['portfolio', 'cash', 'positions', 'transactions', 'income', 'savingsplans'],
  );
});

test('TR API : validation mobile — message exact et requiresUserAction, puis reprise', async () => {
  let attempt = 0;
  const { transport } = fakeTransport(() => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        code: 'MFA_REQUIRED',
        message: 'Validation Trade Republic requise',
        requiresUserAction: true,
      };
    }
    return { ok: true, data: SUCCESS_DATA.test };
  });
  const { ctx } = ctxWithSidecar(transport);

  const first = await tradeRepublicConnector.testConnection(ctx);
  assert.equal(first.ok, false);
  assert.equal(first.status, 'AUTH_REQUIRED');
  assert.equal(first.requiresUserAction, true);
  assert.equal(first.message, 'Validation Trade Republic requise');

  // L'utilisateur approuve dans l'app, la session (cookie pytr) est reprise.
  const second = await tradeRepublicConnector.testConnection(ctx);
  assert.equal(second.ok, true);
  assert.equal(second.status, 'CONNECTED');
});

test('TR API : SESSION_EXPIRED et RATE_LIMITED traduits en ConnectorError', async () => {
  const expired = fakeTransport(() => ({
    ok: false,
    code: 'SESSION_EXPIRED',
    message: 'Session Trade Republic expirée : reconnectez-vous.',
  }));
  await assert.rejects(
    tradeRepublicConnector.syncTransactions(ctxWithSidecar(expired.transport).ctx, {}),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'SESSION_EXPIRED',
  );

  const limited = fakeTransport(() => ({
    ok: false,
    code: 'RATE_LIMITED',
    message: 'HTTP 429 : trop de requêtes.',
  }));
  await assert.rejects(
    tradeRepublicConnector.syncAccounts(ctxWithSidecar(limited.transport).ctx),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'RATE_LIMITED',
  );
});

test('TR API : les identifiants circulent dans la requête mais ne sont jamais journalisés', async () => {
  const { transport, calls } = fakeTransport(successHandler);
  const SECRET_PIN = 'pin-tres-secret-42';
  const { ctx, lines } = ctxWithSidecar(transport, {
    trade_republic_phone: '+33000000000',
    trade_republic_pin: SECRET_PIN,
  });
  await tradeRepublicConnector.syncAccounts(ctx);
  assert.equal(calls[0]?.secrets?.pin, SECRET_PIN);
  for (const line of lines) {
    assert.equal(
      JSON.stringify(line).includes(SECRET_PIN),
      false,
      'aucune ligne de journal ne doit contenir le secret',
    );
  }
});

test('TR API : sans sidecar, NOT_SUPPORTED actionnable ; le CSV reste le repli', async () => {
  const { ctx } = makeTestContext();
  assert.equal(tradeRepublicConnector.capabilities.api, false);
  assert.deepEqual(tradeRepublicConnector.requiredSecrets, []);
  await assert.rejects(
    tradeRepublicConnector.syncAccounts(ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.kind === 'NOT_SUPPORTED' &&
      /trade-republic-csv-en/.test(error.message) &&
      /SUIVIINVEST_SIDECAR_TRADE_REPUBLIC/.test(error.message),
  );
  // Les plans d'épargne ne lèvent pas : ils renvoient simplement une liste vide.
  assert.deepEqual(await fetchTradeRepublicSavingsPlans(ctx), []);
});

test('TR API : capabilities.api suit la disponibilité réelle du sidecar', async (t) => {
  t.after(() => tradeRepublicConnector.configureSidecar(null));
  const { transport } = fakeTransport(successHandler);
  assert.equal(tradeRepublicConnector.capabilities.api, false);
  tradeRepublicConnector.configureSidecar(transport);
  assert.equal(tradeRepublicConnector.capabilities.api, true);
  assert.equal(tradeRepublicConnector.capabilities.positions, true);

  const unavailable = fakeTransport(successHandler, { available: false });
  tradeRepublicConnector.configureSidecar(unavailable.transport);
  assert.equal(tradeRepublicConnector.capabilities.api, false, 'un sidecar indisponible ne compte pas');
});
