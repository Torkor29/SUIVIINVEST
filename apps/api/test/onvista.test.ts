import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequest, createTestApp, login } from './helpers.ts';

/**
 * Onvista, source principale des titres : recherche (sans jetons « actions
 * tokenisées » côté crypto), cours en euros, bascule automatique d'un actif
 * Yahoo quand Yahoo refuse (HTTP 429), retrait d'un investissement.
 */

const NOW = new Date('2025-03-20T12:00:00Z');
const DAYS: string[] = [];
for (let date = new Date('2025-01-02T00:00:00Z'); date <= NOW; date.setUTCDate(date.getUTCDate() + 1)) {
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) DAYS.push(date.toISOString().slice(0, 10));
}
/** NVIDIA sur Tradegate : 90 € + 1 € par séance. */
const PRICE = new Map(DAYS.map((day, index) => [day, 90 + index]));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NVIDIA = {
  entityType: 'STOCK',
  entityValue: '92472',
  name: 'Nvidia',
  isin: 'US67066G1040',
  symbol: 'NVD',
};

function fakeMarket(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('finance.yahoo.com')) return new Response('Too Many Requests', { status: 429 });
    if (url.includes('api.onvista.de/api/v1/instruments/search/facet')) {
      const query = decodeURIComponent(new URL(url).searchParams.get('searchValue') ?? '').toLowerCase();
      const nvidia = ['nvidia', 'nvda', 'us67066g1040', 'nvidia corporation'].includes(query);
      return json({
        facets: [
          { type: 'STOCK', results: nvidia ? [NVIDIA] : [] },
          { type: 'BOND', results: [{ entityType: 'BOND', entityValue: '1', name: 'NVIDIA Notes 2031' }] },
          { type: 'ETF', results: null },
        ],
      });
    }
    if (url.includes('/instruments/STOCK/92472/snapshot')) {
      return json({
        instrument: { name: 'Nvidia', isin: 'US67066G1040' },
        quoteList: {
          list: [
            { market: { name: 'Nasdaq', codeMarket: '_NMS', idNotation: 1 }, isoCurrency: 'USD', last: 150 },
            {
              market: { name: 'Tradegate BSX', codeMarket: '_GAT', idNotation: 9386126 },
              isoCurrency: 'EUR',
              last: 200,
              datetimeLast: '2025-03-20T15:00:00.000+00:00',
            },
          ],
        },
      });
    }
    if (url.includes('/instruments/STOCK/92472/eod_history')) {
      assert.match(url, /idNotation=9386126/, 'place en euros choisie');
      const days = DAYS.filter((day) => day < '2025-03-20');
      return json({
        isoCurrency: 'EUR',
        datetimeLast: days.map((day) => Date.parse(`${day}T12:00:00Z`) / 1000),
        last: days.map((day) => PRICE.get(day)),
      });
    }
    if (url.includes('api.coingecko.com/api/v3/search')) {
      return json({
        coins: [
          { id: 'nvidia-xstock', symbol: 'nvdax', name: 'NVIDIA xStock', market_cap_rank: 564 },
          { id: 'nvidia-ondo-tokenized-stock', symbol: 'nvdaon', name: 'NVIDIA (Ondo Tokenized Stock)', market_cap_rank: 602 },
          { id: 'nvidia-backpack-securities', symbol: 'nvda', name: 'Nvidia (Backpack Securities)', market_cap_rank: 900 },
        ],
      });
    }
    throw new Error(`URL inattendue : ${url}`);
  }) as typeof fetch;
}

test('recherche : l’action NVIDIA via Onvista, jamais un jeton crypto qui l’imite', async () => {
  const calls: string[] = [];
  const ctx = await createTestApp({ marketFetch: fakeMarket(calls), now: () => NOW });
  try {
    const session = await login(ctx);
    const response = await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/search?q=nvidia' });
    const body = response.json() as { results: { source: string; priceSymbol: string; kind: string; isin: string | null }[]; unavailable: string[] };
    assert.deepEqual(
      body.results.map((item) => [item.source, item.priceSymbol, item.kind, item.isin]),
      [['onvista', 'STOCK:92472', 'EQUITY', 'US67066G1040']],
    );
    assert.deepEqual(body.unavailable, []);
    assert.ok(!calls.some((url) => url.includes('finance.yahoo.com')), 'Yahoo non sollicité quand Onvista répond');
  } finally {
    await ctx.cleanup();
  }
});

test('actif Onvista : cours en euros jusqu’à aujourd’hui, rangé dans les titres (pas en crypto)', async () => {
  const ctx = await createTestApp({ marketFetch: fakeMarket([]), now: () => NOW });
  try {
    const session = await login(ctx);
    const added = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'onvista', priceSymbol: 'STOCK:92472', symbol: 'NVD', name: 'Nvidia', kind: 'EQUITY', isin: 'US67066G1040' },
    });
    assert.equal(added.statusCode, 201, added.body);
    const { asset, warning } = added.json() as { asset: { instrumentId: string; quoteCurrency: string }; warning: string | null };
    assert.equal(warning, null);
    assert.equal(asset.quoteCurrency, 'EUR');

    const buy = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: asset.instrumentId, type: 'BUY', date: '2025-01-02', quantity: 2 },
    });
    assert.equal(buy.statusCode, 201, buy.body);
    assert.equal((buy.json() as { unitPrice: number }).unitPrice, 90);

    const overview = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as {
      positions: { name: string; value: number; lastPrice: number }[];
    };
    assert.equal(overview.positions[0]?.lastPrice, 200, 'cours de la séance en cours');
    assert.equal(overview.positions[0]?.value, 400);

    const crypto = (await authRequest(ctx, session, { method: 'GET', url: '/api/crypto' })).json() as { wallets: unknown[]; totalEur: number };
    assert.deepEqual([crypto.wallets.length, crypto.totalEur], [0, 0]);
  } finally {
    await ctx.cleanup();
  }
});

test('Yahoo refuse (429) : l’actif bascule sur Onvista (même titre retrouvé par son ticker)', async () => {
  const ctx = await createTestApp({ marketFetch: fakeMarket([]), now: () => NOW });
  try {
    const session = await login(ctx);
    const added = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'yahoo', priceSymbol: 'NVDA', symbol: 'NVDA', name: 'NVIDIA Corporation', kind: 'EQUITY' },
    });
    assert.equal(added.statusCode, 201, added.body);
    const { asset, warning } = added.json() as {
      asset: { instrumentId: string; priceSource: string; priceSymbol: string; isin: string | null };
      warning: string | null;
    };
    assert.equal(warning, null);
    assert.deepEqual([asset.priceSource, asset.priceSymbol, asset.isin], ['onvista', 'STOCK:92472', 'US67066G1040']);
  } finally {
    await ctx.cleanup();
  }
});

test('retirer un investissement : opérations saisies et plans supprimés, l’actif disparaît', async () => {
  const ctx = await createTestApp({ marketFetch: fakeMarket([]), now: () => NOW });
  try {
    const session = await login(ctx);
    const added = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'onvista', priceSymbol: 'STOCK:92472', symbol: 'NVD', name: 'Nvidia', kind: 'EQUITY' },
    });
    const id = (added.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    await authRequest(ctx, session, { method: 'POST', url: '/api/holdings/operations', payload: { instrumentId: id, type: 'BUY', date: '2025-01-02', quantity: 1 } });
    const plan = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/plans',
      payload: { instrumentId: id, amount: 100, currency: 'EUR', frequency: 'MONTHLY', dayOfMonth: 5, startDate: '2025-02-05' },
    });
    assert.equal(plan.statusCode, 201, plan.body);

    const removed = await authRequest(ctx, session, { method: 'DELETE', url: `/api/holdings/assets/${id}` });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((removed.json() as { removedOperations: number }).removedOperations, 3, '1 achat + 2 échéances');
    const overview = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as { positions: unknown[] };
    assert.equal(overview.positions.length, 0);
    assert.equal(((await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/plans' })).json() as unknown[]).length, 0);
    assert.equal((await authRequest(ctx, session, { method: 'GET', url: `/api/holdings/assets/${id}` })).statusCode, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('écritures usuelles des indices : « snp500 », « ishares sp 500 »… deviennent « S&P 500 »', async () => {
  const { normalizeSecurityQuery } = await import('../src/services/market-client.ts');
  const cases: [string, string][] = [
    ['snp500', 'S&P 500'],
    ['SNP 500', 'S&P 500'],
    ['sp500', 'S&P 500'],
    ['s&p500', 'S&P 500'],
    ['s and p 500', 'S&P 500'],
    ['ishares snp 500', 'ishares S&P 500'],
    ['nasdaq100', 'Nasdaq 100'],
    ['msciworld', 'MSCI World'],
    ['cac40', 'CAC 40'],
    ['nvidia', 'nvidia'],
    ['spotify', 'spotify'],
  ];
  for (const [query, expected] of cases) assert.equal(normalizeSecurityQuery(query), expected, query);
});
