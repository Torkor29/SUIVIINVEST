/**
 * Marché FACTICE des tests de bout en bout : recherche, cours et taux de change
 * déterministes, sans aucun appel réseau. Activé uniquement avec
 * `SUIVIINVEST_E2E_CONNECTORS=1` (jamais en production).
 *
 * NVDA : 100 $ le 2 janvier 2024, +0,1 $ par jour calendaire ; BTC : 50 000 €
 * +20 € par jour ; 1 $ = 0,9 €.
 */

const START = Date.parse('2024-01-02T00:00:00Z');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function days(until: number): number[] {
  const list: number[] = [];
  for (let time = START; time <= until; time += 86_400_000) list.push(time);
  return list;
}

export function createE2eMarketFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const now = Date.now();
    if (url.includes('/v1/finance/search')) {
      const q = new URL(url).searchParams.get('q')?.toLowerCase() ?? '';
      const quotes = [
        { symbol: 'NVDA', shortname: 'NVIDIA Corporation', longname: 'NVIDIA Corporation', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
        { symbol: 'CW8.PA', shortname: 'Amundi MSCI World', longname: 'Amundi MSCI World UCITS ETF', quoteType: 'ETF', exchDisp: 'Paris' },
      ].filter((item) => item.longname.toLowerCase().includes(q) || item.symbol.toLowerCase().includes(q));
      return json({ quotes });
    }
    if (url.includes('/v8/finance/chart/')) {
      const symbol = decodeURIComponent(url.split('/v8/finance/chart/')[1]?.split('?')[0] ?? '');
      const base = symbol === 'NVDA' ? 100 : 400;
      const list = days(now);
      return json({
        chart: {
          result: [
            {
              meta: { currency: symbol === 'NVDA' ? 'USD' : 'EUR' },
              timestamp: list.map((time) => time / 1000 + 50_000),
              indicators: { quote: [{ close: list.map((_, index) => Math.round((base + index * 0.1) * 100) / 100) }] },
            },
          ],
        },
      });
    }
    if (url.includes('api.frankfurter.dev')) {
      return json({ rates: Object.fromEntries(days(now).map((time) => [new Date(time).toISOString().slice(0, 10), { EUR: 0.9 }])) });
    }
    if (url.includes('api.coingecko.com/api/v3/search')) {
      const q = new URL(url).searchParams.get('query')?.toLowerCase() ?? '';
      return json({ coins: 'bitcoin'.includes(q) || q === 'btc' ? [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 }] : [] });
    }
    if (url.includes('/coins/bitcoin/market_chart')) {
      return json({ prices: days(now).map((time, index) => [time, 50_000 + index * 20]) });
    }
    return json({ error: 'hors catalogue E2E' }, 404);
  }) as typeof fetch;
}
