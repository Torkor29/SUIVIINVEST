import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestService } from '../src/services/ingest.ts';
import { createTestApp, login } from './helpers.ts';

/**
 * Positions crypto déclarées par une source.
 *
 * Un portefeuille observé par adresse ne peut pas être reconstitué depuis son
 * historique seul : un jeton natif (ETH, POL…) n'a pas d'adresse de contrat, donc
 * la transaction entrante ne porte aucun identifiant d'actif. La position
 * communiquée par le connecteur doit donc être conservée — quantité et prix
 * unitaire compris — et faire foi dans la vue crypto comme dans le patrimoine.
 */

const WALLET = '0xabc0000000000000000000000000000000000001';

const ingestOptions = {
  providerId: 'metamask' as const,
  connectionId: null,
  syncRunId: null,
  importId: null,
  baseCurrency: 'EUR',
  trigger: 'MANUAL' as const,
};

/** Un wallet avec 2 ETH natifs déclarés + le transfert entrant correspondant. */
function walletBatch() {
  return {
    accounts: [
      {
        externalAccountId: WALLET,
        name: 'Wallet E2E',
        type: 'CRYPTO' as const,
        currency: 'EUR',
        rawSourceType: 'TEST',
      },
    ],
    positions: [
      {
        externalAccountId: WALLET,
        externalAssetId: null,
        isin: null,
        symbol: 'ETH',
        name: 'Ether',
        kind: 'CRYPTO' as const,
        quantity: 2,
        unitPrice: 2500,
        currency: 'EUR',
        chain: 'ethereum',
        contractAddress: null,
        decimals: 18,
        rawSourceType: 'TEST',
      },
    ],
    transactions: [
      {
        externalAccountId: WALLET,
        externalTransactionId: '0xhash-1',
        externalAssetId: null,
        date: '2026-09-01',
        type: 'CRYPTO_TRANSFER' as const,
        description: 'Transfert entrant 2 ETH',
        quantity: 2,
        unitPrice: 2500,
        amount: 5000,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
        rawSourceType: 'TEST',
      },
    ],
  };
}

test('la quantité et le prix unitaire d’une position sont conservés', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());

  const report = new IngestService(ctx.db).ingestBatch(walletBatch(), ingestOptions);
  assert.equal(report.valuationsWritten, 1);

  const row = ctx.db.get<{ quantity: number | null; unit_price: number | null; value: number }>(
    `SELECT v.quantity, v.unit_price, v.value FROM valuations v
      JOIN instruments i ON i.id = v.instrument_id
     WHERE i.symbol = 'ETH'`,
  );
  assert.ok(row, 'la position doit être écrite');
  assert.equal(row.quantity, 2);
  assert.equal(row.unit_price, 2500);
  assert.equal(row.value, 5000);
});

test('un jeton natif déclaré apparaît dans la vue crypto (plus de jeton « — »)', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  new IngestService(ctx.db).ingestBatch(walletBatch(), ingestOptions);

  const response = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/crypto',
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    totalEur: number;
    warnings: string[];
    wallets: { name: string; chains: string[]; valueEur: number; assets: { symbol: string; quantity: number; price: number | null; chain: string; isNative: boolean; valueEur: number }[] }[];
  };

  assert.equal(body.wallets.length, 1);
  const wallet = body.wallets[0]!;
  assert.equal(wallet.name, 'Wallet E2E');
  assert.deepEqual(wallet.chains, ['ethereum']);
  assert.equal(wallet.assets.length, 1, 'aucune ligne parasite ne doit apparaître');
  const asset = wallet.assets[0]!;
  assert.equal(asset.symbol, 'ETH', 'le jeton natif doit être identifié');
  assert.equal(asset.quantity, 2);
  assert.equal(asset.price, 2500);
  assert.equal(asset.valueEur, 5000);
  assert.equal(asset.isNative, true);
  assert.equal(wallet.valueEur, 5000);
  assert.equal(body.totalEur, 5000);
  assert.deepEqual(body.warnings, [], 'aucun avertissement de prix manquant');
});

test('le patrimoine net valorise le wallet sur les positions déclarées', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  new IngestService(ctx.db).ingestBatch(walletBatch(), ingestOptions);

  const response = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth?period=MAX',
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { total: number };
  // Le transfert entrant ne doit pas être compté deux fois : le wallet vaut ses
  // positions (2 × 2 500 €), pas les positions plus le montant du transfert.
  assert.equal(body.total, 5000);
});

test('sans position déclarée, la vue crypto retombe sur l’historique', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  new IngestService(ctx.db).ingestBatch(
    {
      accounts: [
        {
          externalAccountId: '0xdef0000000000000000000000000000000000002',
          name: 'Wallet sans position',
          type: 'CRYPTO' as const,
          currency: 'EUR',
          rawSourceType: 'TEST',
        },
      ],
      transactions: [
        {
          externalAccountId: '0xdef0000000000000000000000000000000000002',
          externalTransactionId: '0xhash-2',
          // Identifiant d'actif fourni : l'instrument est résolu par symbole.
          externalAssetId: 'USDC',
          date: '2026-09-02',
          type: 'CRYPTO_TRANSFER' as const,
          description: 'Transfert entrant 200 USDC',
          quantity: 200,
          unitPrice: 1,
          amount: 200,
          currency: 'EUR',
          fees: 0,
          taxes: 0,
          rawSourceType: 'TEST',
        },
      ],
    },
    ingestOptions,
  );

  const response = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/crypto',
    headers: { cookie: session.cookie },
  });
  const body = response.json() as { totalEur: number; wallets: { assets: { symbol: string; quantity: number }[] }[] };
  assert.equal(body.wallets.length, 1);
  const assets = body.wallets[0]!.assets;
  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.symbol, 'USDC');
  assert.equal(assets[0]!.quantity, 200);
  assert.equal(body.totalEur, 200);
});
