import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequest, createTestApp, login, type TestContext } from './helpers.ts';

/**
 * Portefeuille saisi à la main, de bout en bout côté API, avec un réseau
 * simulé (Yahoo, CoinGecko, Frankfurter) : recherche, ajout d'un actif, cours
 * convertis en euros, achat, vente, investissement programmé rattrapé, courbes.
 */

const NOW = new Date('2025-03-20T12:00:00Z');

/** Jours ouvrés du 2 janvier au 20 mars 2025, NVDA de 100 $ + 1 $ par séance. */
function tradingDays(): string[] {
  const days: string[] = [];
  for (let date = new Date('2025-01-02T00:00:00Z'); date <= NOW; date.setUTCDate(date.getUTCDate() + 1)) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10));
  }
  return days;
}
const DAYS = tradingDays();
const NVDA_USD = new Map(DAYS.map((day, index) => [day, 100 + index]));
const USD_EUR = 0.9;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeMarket(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('/v1/finance/search')) {
      return json({
        quotes: [
          { symbol: 'NVDA', shortname: 'NVIDIA Corporation', longname: 'NVIDIA Corporation', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
          { symbol: 'NVD.DE', shortname: 'NVIDIA CORP', quoteType: 'EQUITY', exchDisp: 'XETRA' },
          { symbol: 'NVDA260320C00100000', quoteType: 'OPTION' },
        ],
      });
    }
    if (url.includes('/v8/finance/chart/NVDA')) {
      return json({
        chart: {
          result: [
            {
              meta: { currency: 'USD', longName: 'NVIDIA Corporation' },
              timestamp: DAYS.map((day) => Date.parse(`${day}T14:30:00Z`) / 1000),
              indicators: { quote: [{ close: DAYS.map((day) => NVDA_USD.get(day)) }] },
            },
          ],
        },
      });
    }
    if (url.includes('api.frankfurter.dev')) {
      return json({ rates: Object.fromEntries(DAYS.map((day) => [day, { EUR: USD_EUR }])) });
    }
    if (url.includes('api.coingecko.com/api/v3/search')) {
      return json({ coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 }] });
    }
    if (url.includes('/coins/bitcoin/market_chart')) {
      return json({ prices: DAYS.map((day) => [Date.parse(`${day}T00:00:00Z`), 90_000]) });
    }
    return json({ error: 'inconnu' }, 404);
  }) as typeof fetch;
}

async function setup(calls?: string[]): Promise<{ ctx: TestContext; session: { cookie: string; csrfToken: string } }> {
  const ctx = await createTestApp({ marketFetch: fakeMarket(calls), now: () => NOW });
  const session = await login(ctx);
  return { ctx, session };
}

async function addNvidia(ctx: TestContext, session: { cookie: string; csrfToken: string }): Promise<string> {
  const response = await authRequest(ctx, session, {
    method: 'POST',
    url: '/api/holdings/assets',
    payload: { source: 'yahoo', priceSymbol: 'NVDA', symbol: 'NVDA', name: 'NVIDIA Corporation', kind: 'EQUITY' },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { asset: { instrumentId: string } }).asset.instrumentId;
}

test('recherche : actions (Yahoo) et cryptos (CoinGecko), sans les options', async () => {
  const { ctx, session } = await setup();
  try {
    const nvidia = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/search?q=nvidia' })).json() as {
      results: { symbol: string; kind: string; source: string }[];
      unavailable: string[];
    };
    assert.deepEqual(nvidia.results.filter((item) => item.source === 'yahoo').map((item) => item.symbol), ['NVDA', 'NVD.DE']);
    assert.ok(nvidia.results.some((item) => item.source === 'coingecko' && item.kind === 'CRYPTO'));
    assert.deepEqual(nvidia.unavailable, []);
  } finally {
    await ctx.cleanup();
  }
});

test('actif coté en dollars : cours stockés en euros, achat au cours du jour, valeur à jour', async () => {
  const { ctx, session } = await setup();
  try {
    const id = await addNvidia(ctx, session);
    const lastUsd = NVDA_USD.get('2025-03-20') as number;

    // Achat de 10 titres le 2 janvier, au cours de clôture (100 $ = 90 €), 1 € de frais.
    const buy = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: id, type: 'BUY', date: '2025-01-02', quantity: 10, fees: 1 },
    });
    assert.equal(buy.statusCode, 201, buy.body);
    assert.equal((buy.json() as { amount: number }).amount, -901);

    const overview = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as {
      totals: { value: number; invested: number; pnl: number };
      positions: { symbol: string; quantity: number; lastPrice: number; editable: boolean; accounts: string[] }[];
    };
    const position = overview.positions[0];
    assert.equal(position?.symbol, 'NVDA');
    assert.equal(position?.quantity, 10);
    assert.equal(position?.lastPrice, lastUsd * USD_EUR);
    assert.equal(position?.editable, true);
    assert.deepEqual(position?.accounts, ['Mes investissements']);
    assert.equal(overview.totals.invested, 901);
    assert.equal(overview.totals.value, Math.round(10 * lastUsd * USD_EUR * 100) / 100);

    // Le patrimoine global inclut ce compte, sans rien configurer.
    const networth = (await authRequest(ctx, session, { method: 'GET', url: '/api/accounts' })).json() as {
      accounts: { name: string; value: number }[];
    };
    assert.ok(networth.accounts.some((account) => account.name === 'Mes investissements' && account.value > 0));

    // Vente impossible au-delà de la quantité détenue ; vente partielle acceptée.
    const tooMuch = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: id, type: 'SELL', date: '2025-03-03', quantity: 11 },
    });
    assert.equal(tooMuch.statusCode, 400);
    const sell = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: id, type: 'SELL', date: '2025-03-03', quantity: 4, unitPrice: 150, currency: 'USD' },
    });
    assert.equal(sell.statusCode, 201, sell.body);
    assert.equal((sell.json() as { amount: number }).amount, 4 * 150 * USD_EUR);

    const detail = (await authRequest(ctx, session, { method: 'GET', url: `/api/holdings/assets/${id}?period=3M` })).json() as {
      position: { quantity: number; realizedPnl: number };
      operations: { type: string }[];
      prices: { date: string; total: number }[];
      history: { date: string; value: number; invested: number }[];
    };
    assert.equal(detail.position.quantity, 6);
    assert.ok(detail.position.realizedPnl > 0);
    assert.deepEqual(detail.operations.map((operation) => operation.type), ['SELL', 'BUY']);
    assert.equal(detail.prices.at(-1)?.total, lastUsd * USD_EUR);
    const before = detail.history.find((point) => point.date === '2025-01-01');
    const after = detail.history.find((point) => point.date === '2025-01-02');
    assert.equal(before?.value ?? 0, 0);
    assert.equal(after?.invested, 901);
  } finally {
    await ctx.cleanup();
  }
});

test('investissement programmé : 200 $ le 11 du mois, échéances passées rattrapées au jour de bourse suivant', async () => {
  const calls: string[] = [];
  const { ctx, session } = await setup(calls);
  try {
    const id = await addNvidia(ctx, session);
    const created = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/plans',
      payload: { instrumentId: id, amount: 200, currency: 'USD', frequency: 'MONTHLY', dayOfMonth: 11, startDate: '2025-01-11' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const plan = created.json() as { id: string; executions: number; investedEur: number; nextDate: string; pending: number };
    // 11 janvier = samedi -> lundi 13 ; 11 février (mardi) ; 11 mars (mardi).
    assert.equal(plan.executions, 3);
    assert.equal(plan.investedEur, 3 * 200 * USD_EUR);
    assert.equal(plan.nextDate, '2025-04-11');
    assert.equal(plan.pending, 0);

    const detail = (await authRequest(ctx, session, { method: 'GET', url: `/api/holdings/assets/${id}?period=MAX` })).json() as {
      operations: { date: string; quantity: number; unitPrice: number; typeLabel: string; planId: string }[];
    };
    const dates = detail.operations.map((operation) => operation.date).sort();
    assert.deepEqual(dates, ['2025-01-13', '2025-02-11', '2025-03-11']);
    const january = detail.operations.find((operation) => operation.date === '2025-01-13');
    const priceJan13 = (NVDA_USD.get('2025-01-13') as number) * USD_EUR;
    assert.equal(january?.unitPrice, priceJan13);
    assert.equal(january?.quantity, Math.round(((200 * USD_EUR) / priceJan13) * 1e8) / 1e8);
    assert.equal(january?.typeLabel, 'Achat programmé');
    assert.equal(january?.planId, plan.id);

    // Relancer ne crée pas de doublon.
    const refresh = (await authRequest(ctx, session, { method: 'POST', url: '/api/holdings/refresh' })).json() as { executions: number };
    assert.equal(refresh.executions, 0);

    // Pause puis suppression avec ses achats.
    const paused = (await authRequest(ctx, session, { method: 'PATCH', url: `/api/holdings/plans/${plan.id}`, payload: { active: false } })).json() as {
      active: boolean;
      nextDate: string | null;
    };
    assert.equal(paused.active, false);
    assert.equal(paused.nextDate, null);
    const removed = await authRequest(ctx, session, { method: 'DELETE', url: `/api/holdings/plans/${plan.id}?removeOperations=true` });
    assert.equal(removed.statusCode, 200);
    const after = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as { positions: unknown[]; plans: unknown[] };
    assert.equal(after.positions.length, 0);
    assert.equal(after.plans.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('crypto (CoinGecko) et obligation à cours manuel ; courbe du portefeuille', async () => {
  const { ctx, session } = await setup();
  try {
    const btc = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'coingecko', priceSymbol: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', kind: 'CRYPTO' },
    });
    assert.equal(btc.statusCode, 201, btc.body);
    const btcId = (btc.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    // Montant investi plutôt qu'une quantité : 450 € -> 0,005 BTC.
    const buy = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: btcId, type: 'BUY', date: '2025-02-03', amount: 450 },
    });
    assert.equal((buy.json() as { quantity: number }).quantity, 0.005);

    const bond = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'manual', name: 'OAT 3 % 2034', kind: 'BOND', currency: 'EUR', price: 98.5, priceDate: '2025-03-01' },
    });
    assert.equal(bond.statusCode, 201, bond.body);
    const bondId = (bond.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    const bondBuy = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: bondId, type: 'BUY', date: '2025-03-01', quantity: 10 },
    });
    assert.equal(bondBuy.statusCode, 201, bondBuy.body);
    await authRequest(ctx, session, { method: 'POST', url: `/api/holdings/assets/${bondId}/price`, payload: { date: '2025-03-15', price: 101 } });

    const overview = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as {
      totals: { value: number; invested: number };
      positions: { kind: string; value: number }[];
      allocation: { label: string }[];
    };
    assert.equal(overview.positions.find((position) => position.kind === 'CRYPTO')?.value, 450);
    assert.equal(overview.positions.find((position) => position.kind === 'BOND')?.value, 1010);
    assert.equal(overview.totals.invested, 450 + 985);
    assert.deepEqual(overview.allocation.map((slice) => slice.label).sort(), ['Crypto', 'Obligation']);

    const history = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/history?period=MAX' })).json() as {
      points: { date: string; value: number; invested: number }[];
    };
    assert.equal(history.points[0]?.date, '2025-02-03');
    assert.equal(history.points.at(-1)?.value, 1460);
    assert.equal(history.points.at(-1)?.invested, 1435);

    // Opération d'une source synchronisée : non supprimable ici (et inconnue -> 404).
    assert.equal((await authRequest(ctx, session, { method: 'DELETE', url: '/api/holdings/operations/inconnue' })).statusCode, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('sources muettes : recherche dégradée annoncée, achat sans cours refusé proprement', async () => {
  const ctx = await createTestApp({ now: () => NOW });
  try {
    const session = await login(ctx);
    const search = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/search?q=nvidia' })).json() as {
      results: unknown[];
      unavailable: string[];
    };
    assert.equal(search.results.length, 0);
    assert.equal(search.unavailable.length, 2);

    const added = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'yahoo', priceSymbol: 'NVDA', name: 'NVIDIA', kind: 'EQUITY' },
    });
    assert.equal(added.statusCode, 201);
    assert.match((added.json() as { warning: string }).warning, /indisponibles/);
    const id = (added.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    const buy = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: id, type: 'BUY', date: '2025-01-02', quantity: 1 },
    });
    assert.equal(buy.statusCode, 400);
    assert.match((buy.json() as { error: { message: string } }).error.message, /prix payé/);
    // Avec le prix payé, l'achat passe même sans cours.
    const withPrice = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: id, type: 'BUY', date: '2025-01-02', quantity: 1, unitPrice: 120 },
    });
    assert.equal(withPrice.statusCode, 201, withPrice.body);
  } finally {
    await ctx.cleanup();
  }
});
