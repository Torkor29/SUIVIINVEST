import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeHttpClient } from '@suiviinvest/connectors';
import { authRequest, createTestApp, login } from './helpers.ts';

/**
 * Plateforme crypto par clé API, de bout en bout côté serveur : connexion,
 * synchronisation, patrimoine (positions + euros), puis vente d'un actif —
 * qui doit disparaître du patrimoine au lieu d'y rester figé.
 */
test('Kraken : positions et euros dans le patrimoine, actif vendu remis à zéro', async () => {
  let balances: Record<string, string> = { XXBT: '0.5', XETH: '2', ZEUR: '1000' };
  const http = new FakeHttpClient([
    { match: /exchange-rates/, respond: { data: { rates: { BTC: '0.00001', ETH: '0.0005' } } } },
    { match: /\/0\/private\/Balance/, respond: () => ({ status: 200, headers: {}, text: JSON.stringify({ error: [], result: balances }) }) },
  ]);
  const ctx = await createTestApp({ connectorHttp: http });
  try {
    const session = await login(ctx);
    const created = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/connections',
      payload: {
        providerId: 'kraken',
        label: 'Kraken',
        config: {},
        secrets: { kraken_api_key: 'cle', kraken_api_secret: Buffer.from('secret').toString('base64') },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json() as { id: string };

    const first = await authRequest(ctx, session, { method: 'POST', url: `/api/connections/${id}/sync` });
    assert.equal((first.json() as { status: string }).status, 'SUCCESS', first.body);
    // 0,5 BTC × 100 000 + 2 ETH × 2 000 + 1 000 € = 55 000 €.
    const before = (await authRequest(ctx, session, { method: 'GET', url: '/api/networth' })).json() as { total: number };
    assert.equal(before.total, 55_000);

    const crypto = (await authRequest(ctx, session, { method: 'GET', url: '/api/crypto' })).json() as {
      wallets: { name: string; assets: { symbol: string; quantity: number }[] }[];
    };
    assert.deepEqual(
      crypto.wallets[0]?.assets.map((asset) => asset.symbol).sort(),
      ['BTC', 'ETH'],
    );

    // L'ETH a été vendu et les euros retirés.
    balances = { XXBT: '0.5' };
    await authRequest(ctx, session, { method: 'POST', url: `/api/connections/${id}/sync` });
    const after = (await authRequest(ctx, session, { method: 'GET', url: '/api/networth' })).json() as { total: number };
    assert.equal(after.total, 50_000);
    // L'actif vendu disparaît sans avertissement parasite.
    const cryptoAfter = (await authRequest(ctx, session, { method: 'GET', url: '/api/crypto' })).json() as {
      wallets: { assets: { symbol: string }[] }[];
      warnings: string[];
    };
    assert.deepEqual(cryptoAfter.wallets[0]?.assets.map((asset) => asset.symbol), ['BTC']);
    assert.ok(!cryptoAfter.warnings.some((warning) => warning.includes('quantité inconnue')), cryptoAfter.warnings.join('\n'));
  } finally {
    await ctx.cleanup();
  }
});

test('Bitcoin : plusieurs wallets possibles, adresse publique seulement', async () => {
  const http = new FakeHttpClient([
    { match: /exchange-rates/, respond: { data: { rates: { BTC: '0.00001' } } } },
    {
      match: /mempool\.space\/api\/address\//,
      respond: {
        chain_stats: { funded_txo_sum: 10_000_000, spent_txo_sum: 0, tx_count: 1 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      },
    },
  ]);
  const ctx = await createTestApp({ connectorHttp: http });
  try {
    const session = await login(ctx);
    for (const address of ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA']) {
      const created = await authRequest(ctx, session, {
        method: 'POST',
        url: '/api/connections',
        payload: { providerId: 'bitcoin', label: 'Bitcoin', config: { addresses: address }, secrets: {} },
      });
      assert.equal(created.statusCode, 201);
      const { id } = created.json() as { id: string };
      const sync = await authRequest(ctx, session, { method: 'POST', url: `/api/connections/${id}/sync` });
      assert.equal((sync.json() as { status: string }).status, 'SUCCESS', sync.body);
    }
    const total = ((await authRequest(ctx, session, { method: 'GET', url: '/api/networth' })).json() as { total: number }).total;
    assert.equal(total, 20_000); // 2 × 0,1 BTC × 100 000 €
    // Les wallets Bitcoin ne sont pas listés parmi les portefeuilles EVM.
    const evm = (await authRequest(ctx, session, { method: 'GET', url: '/api/wallets' })).json() as unknown[];
    assert.equal(evm.length, 0);
  } finally {
    await ctx.cleanup();
  }
});
