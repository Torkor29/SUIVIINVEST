import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequest, createTestApp, login, seedAccount, seedActivity, seedInstrument } from './helpers.ts';

/**
 * Historique incomplet d'une source (ex. Trade Republic : relevé limité, achat
 * sans ISIN) : une vente dépasse la quantité connue. Aucune page ne doit tomber
 * en « erreur interne » ; l'anomalie est signalée en clair.
 */
test('une vente sans achat connu ne rend aucune page inaccessible', async () => {
  const ctx = await createTestApp();
  try {
    const session = await login(ctx);
    const account = seedAccount(ctx.db, { name: 'Trade Republic', type: 'SECURITIES', providerId: 'trade_republic' });
    const etf = seedInstrument(ctx.db, { name: 'Core S&P 500', isin: 'IE00B5BMR087', kind: 'ETF' });
    seedActivity(ctx.db, { accountId: account, instrumentId: etf, type: 'BUY', date: '2026-01-05', quantity: 2, unitPrice: 500, amount: -1000 });
    // Vente de 5 alors que seuls 2 titres sont connus.
    seedActivity(ctx.db, { accountId: account, instrumentId: etf, type: 'SELL', date: '2026-03-02', quantity: 5, unitPrice: 600, amount: 3000 });

    for (const url of ['/api/networth', '/api/accounts', '/api/investments', '/api/holdings', '/api/holdings/history?period=1Y', '/api/analytics', '/api/crypto']) {
      const response = await authRequest(ctx, session, { method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} : ${response.body}`);
    }
    const investments = (await authRequest(ctx, session, { method: 'GET', url: '/api/investments' })).json() as { warnings: string[] };
    assert.ok(
      investments.warnings.some((warning) => warning.includes('dépasse la quantité connue')),
      investments.warnings.join('\n'),
    );
  } finally {
    await ctx.cleanup();
  }
});
