import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequest, createTestApp, inMainSpace, login } from './helpers.ts';

/**
 * Cours en direct : le cours du jour suit la dernière cotation (portefeuille,
 * patrimoine et crypto deviennent « live »), et la courbe « 1 J » est tracée à
 * partir des relevés intrajournaliers.
 */

const DAYS: string[] = [];
for (let date = new Date('2025-03-03T00:00:00Z'); date < new Date('2025-03-20T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 1)) {
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) DAYS.push(date.toISOString().slice(0, 10));
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Marché simulé : NVIDIA clôture à 100 € la veille, puis cote `live.nvidia` ; Bitcoin à `live.bitcoin`. */
function fakeMarket(live: { nvidia: number; bitcoin: number; at: string }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/instruments/STOCK/92472/snapshot')) {
      return json({
        instrument: { name: 'Nvidia', isin: 'US67066G1040' },
        quoteList: {
          list: [{ market: { name: 'Tradegate BSX', codeMarket: '_GAT', idNotation: 1 }, isoCurrency: 'EUR', last: live.nvidia, datetimeLast: live.at }],
        },
      });
    }
    if (url.includes('/instruments/STOCK/92472/eod_history')) {
      return json({ isoCurrency: 'EUR', datetimeLast: DAYS.map((day) => Date.parse(`${day}T12:00:00Z`) / 1000), last: DAYS.map(() => 100) });
    }
    if (url.includes('/simple/price')) {
      return json({ bitcoin: { eur: live.bitcoin, last_updated_at: Date.parse(live.at) / 1000 } });
    }
    if (url.includes('/coins/bitcoin/market_chart')) {
      return json({ prices: DAYS.map((day) => [Date.parse(`${day}T00:00:00Z`), 50_000]) });
    }
    throw new Error(`URL inattendue : ${url}`);
  }) as typeof fetch;
}

test('cours en direct : valeurs « live » partout et courbe 1 J tracée depuis les relevés', async () => {
  const clock = { now: new Date('2025-03-20T09:00:00Z') };
  const live = { nvidia: 100, bitcoin: 50_000, at: '2025-03-20T09:00:00.000Z' };
  const ctx = await createTestApp({ marketFetch: fakeMarket(live), now: () => clock.now });
  try {
    const session = await login(ctx);
    const nvidia = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'onvista', priceSymbol: 'STOCK:92472', symbol: 'NVD', name: 'Nvidia', kind: 'EQUITY' },
    });
    const nvidiaId = (nvidia.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    await authRequest(ctx, session, { method: 'POST', url: '/api/holdings/operations', payload: { instrumentId: nvidiaId, type: 'BUY', date: '2025-03-10', quantity: 10 } });
    const bitcoin = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'coingecko', priceSymbol: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', kind: 'CRYPTO' },
    });
    const bitcoinId = (bitcoin.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    await authRequest(ctx, session, { method: 'POST', url: '/api/holdings/operations', payload: { instrumentId: bitcoinId, type: 'BUY', date: '2025-03-10', quantity: 0.1 } });

    // Premier relevé (via l'interface), puis deux relevés planifiés dans la matinée.
    const first = await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/live' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((first.json() as { updated: number }).updated, 2);
    for (const [at, nvidiaPrice, bitcoinPrice] of [
      ['2025-03-20T10:00:00.000Z', 104, 51_000],
      ['2025-03-20T11:00:00.000Z', 110, 52_000],
    ] as const) {
      clock.now = new Date(at);
      Object.assign(live, { at, nvidia: nvidiaPrice, bitcoin: bitcoinPrice });
      await inMainSpace(ctx, () => ctx.app.holdings.refreshLive({ minIntervalMs: 0 }));
    }

    // Valeur « live » : 10 × 110 + 0,1 × 52 000 = 6 300 €.
    const overview = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings' })).json() as {
      totals: { value: number; dayChange: number };
      positions: { name: string; lastPrice: number }[];
    };
    assert.equal(overview.totals.value, 6300);
    assert.deepEqual(overview.positions.map((position) => [position.name, position.lastPrice]).sort(), [['Bitcoin', 52_000], ['Nvidia', 110]]);

    // Courbe 1 J du portefeuille : départ à la clôture de la veille (10 × 100 + 0,1 × 50 000), puis chaque relevé.
    const day = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/history?period=1D' })).json() as {
      points: { date: string; value: number }[];
      change: number;
    };
    assert.deepEqual(
      day.points.map((point) => point.value),
      [6000, 6000, 6140, 6300, 6300],
    );
    assert.match(day.points[1]?.date ?? '', /^2025-03-20T09:00/);
    assert.equal(day.change, 300);

    // Fiche d'un actif, 1 J : cours relevés.
    const detail = (await authRequest(ctx, session, { method: 'GET', url: `/api/holdings/assets/${nvidiaId}?period=1D` })).json() as {
      prices: { total: number }[];
      priceChangePercent: number;
    };
    assert.deepEqual(detail.prices.map((point) => point.total), [100, 100, 104, 110, 110]);
    assert.equal(detail.priceChangePercent, 10);

    // Accueil : patrimoine au cours en direct et courbe 1 J qui suit les investissements.
    const networth = (await authRequest(ctx, session, { method: 'GET', url: '/api/networth?period=1D' })).json() as {
      total: number;
      series: { date: string; total: number }[];
    };
    assert.equal(networth.total, 6300);
    assert.deepEqual(networth.series.map((point) => point.total), [6000, 6000, 6140, 6300, 6300]);

    // Crypto : même cours en direct.
    const crypto = (await authRequest(ctx, session, { method: 'GET', url: '/api/crypto' })).json() as { totalEur: number };
    assert.equal(crypto.totalEur, 5200);

    // Limite : un nouvel appel de l'interface dans la minute n'interroge pas les sources.
    const throttled = (await authRequest(ctx, session, { method: 'GET', url: '/api/holdings/live' })).json() as { updated: number; at: string | null };
    assert.equal(throttled.updated, 0);
    assert.ok(throttled.at);
  } finally {
    await ctx.cleanup();
  }
});
