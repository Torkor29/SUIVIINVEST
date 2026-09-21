import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WalletResyncResponse, WalletStatusDto } from '@suiviinvest/api-contract';
import { registerWalletRoutes } from '../src/routes/wallets.ts';
import { WalletStatusService, humanizeWalletError } from '../src/services/evm/wallet-status.ts';
import { InstrumentRepository } from '../src/repositories/accounts.ts';
import { authRequest, createTestApp, createTestConnector, login, seedAccount, seedActivity, seedQuote } from './helpers.ts';

/**
 * Wallets EVM côté API : état (`WalletStatusDto`) + resynchronisation via
 * `SyncService`. Aucun réseau : la base est réelle (SQLite temporaire) et le
 * connecteur est une doublure déterministe.
 */

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';
const MTK = '0x7777777777777777777777777777777777777777';

test('wallet-status : les erreurs techniques sont traduites, jamais affichées', () => {
  assert.equal(humanizeWalletError(null), null);
  assert.equal(
    humanizeWalletError('[metamask/PROVIDER_DOWN] Le fournisseur etherscan est en panne (503) sur https://x'),
    'Le service d’exploration est temporairement injoignable : réessayez plus tard.',
  );
  assert.equal(
    humanizeWalletError('[metamask/RATE_LIMITED] trop de requêtes'),
    'Le fournisseur limite temporairement les accès : réessayez dans quelques minutes.',
  );
  // Aucun message retourné ne doit contenir de crochet, d'URL ou de pile d'appel.
  for (const raw of ['trace inconnue', '[metamask/DATA] x', 'Error: at foo.ts:12']) {
    const message = humanizeWalletError(raw);
    assert.ok(message);
    assert.equal(/[\[\]]|https?:|at .*:\d+/.test(message), false, `fuite technique : ${message}`);
  }
});

test('wallet-status : un wallet vide est décrit sans rien inventer', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  seedAccount(ctx.db, { name: 'Wallet vide', type: 'CRYPTO', providerId: 'metamask', currency: 'EUR', externalAccountId: WALLET });

  const wallets = new WalletStatusService(ctx.db).list();
  assert.equal(wallets.length, 1);
  const wallet = wallets[0] as WalletStatusDto;
  assert.equal(wallet.address, WALLET);
  assert.equal(wallet.tokenCount, 0);
  assert.equal(wallet.valueEur, 0);
  assert.deepEqual(wallet.chains, []);
  assert.equal(wallet.lastSyncedAt, null);
  assert.equal(wallet.error, null);
});

test('wallet-status : multi-chaînes, jetons, valeur EUR et dernière synchro par chaîne', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());

  const now = new Date().toISOString();
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, config_json, secret_refs_json, status, last_error, created_at, updated_at)
     VALUES ('c-wallet','metamask','Wallet EVM','{"address":"${WALLET}"}','[]','ERROR','[metamask/PROVIDER_DOWN] injoignable',?,?)`,
    now,
    now,
  );
  const accountId = seedAccount(ctx.db, {
    name: 'Wallet EVM',
    type: 'CRYPTO',
    providerId: 'metamask',
    currency: 'EUR',
    externalAccountId: WALLET,
  });
  ctx.db.run('UPDATE accounts SET connection_id = ? WHERE id = ?', 'c-wallet', accountId);

  ctx.db.run(
    `INSERT INTO chain_sync_state (connection_id, chain, address, last_block, last_synced_at, cursor) VALUES
     ('c-wallet','ethereum','${WALLET}',21000000,'2026-04-01T00:00:00.000Z',NULL),
     ('c-wallet','polygon','${WALLET}',63000000,'2026-04-02T10:00:00.000Z',NULL)`,
  );

  const instruments = new InstrumentRepository(ctx.db);
  const usdc = instruments.upsert({
    kind: 'CRYPTO',
    name: 'Exemple USD Coin',
    currency: 'USDC',
    symbol: 'USDC',
    chain: 'ethereum',
    contractAddress: USDC,
    decimals: 6,
  });
  const mtk = instruments.upsert({
    kind: 'CRYPTO',
    name: 'Exemple Polygon Token',
    currency: 'MTK',
    symbol: 'MTK',
    chain: 'polygon',
    contractAddress: MTK,
    decimals: 18,
  });
  seedActivity(ctx.db, { accountId, instrumentId: usdc.id, type: 'BUY', date: '2026-03-01', quantity: 100, amount: -100, currency: 'EUR' });
  seedActivity(ctx.db, { accountId, instrumentId: mtk.id, type: 'BUY', date: '2026-03-02', quantity: 2, amount: -10, currency: 'EUR' });
  seedQuote(ctx.db, usdc.id, '2026-04-10', 1);
  seedQuote(ctx.db, mtk.id, '2026-04-10', 5);

  const wallet = new WalletStatusService(ctx.db).forAccount(accountId);
  assert.ok(wallet);
  assert.equal(wallet.tokenCount, 2);
  assert.equal(wallet.valueEur, 110);
  assert.equal(wallet.lastSyncedAt, '2026-04-02T10:00:00.000Z');
  assert.equal(wallet.error, 'Le service d’exploration est temporairement injoignable : réessayez plus tard.');

  const byChain = new Map(wallet.chains.map((chain) => [chain.chain, chain]));
  assert.equal(byChain.get('ethereum')?.tokens, 1);
  assert.equal(byChain.get('ethereum')?.valueEur, 100);
  assert.equal(byChain.get('ethereum')?.lastBlock, 21000000);
  assert.equal(byChain.get('polygon')?.tokens, 1);
  assert.equal(byChain.get('polygon')?.valueEur, 10);
  assert.equal(byChain.get('polygon')?.lastSyncedAt, '2026-04-02T10:00:00.000Z');
});

test('routes : GET /api/wallets exige une session', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await registerWalletRoutes(ctx.app.app, { db: ctx.db, sync: ctx.app.sync });

  const response = await ctx.app.app.inject({ method: 'GET', url: '/api/wallets' });
  assert.equal(response.statusCode, 401);
});

test('routes : resynchronisation d\'un wallet puis dédoublonnage au second passage', async (t) => {
  const connector = createTestConnector({
    id: 'metamask',
    displayName: 'Wallet EVM (test)',
    accounts: [{ externalAccountId: WALLET, name: 'Wallet EVM', type: 'CRYPTO', currency: 'ETH' }],
    transactions: [
      {
        externalAccountId: WALLET,
        externalTransactionId: '0xaaaa000000000000000000000000000000000000000000000000000000000001:0',
        externalAssetId: USDC,
        date: '2026-03-01',
        type: 'CRYPTO_TRANSFER',
        description: 'Réception USDC',
        quantity: 100,
        unitPrice: null,
        amount: 100,
        currency: 'USDC',
        fees: 0,
        taxes: 0,
        rawSourceType: 'evm.onchain',
      },
    ],
  });
  const ctx = await createTestApp({ connectors: [connector] });
  t.after(() => ctx.cleanup());

  const now = new Date().toISOString();
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, config_json, secret_refs_json, status, created_at, updated_at)
     VALUES ('c-mm','metamask','Wallet EVM','{"address":"${WALLET}"}','[]','DISCONNECTED',?,?)`,
    now,
    now,
  );
  const accountId = seedAccount(ctx.db, {
    name: 'Wallet EVM',
    type: 'CRYPTO',
    providerId: 'metamask',
    currency: 'ETH',
    externalAccountId: WALLET,
  });
  ctx.db.run('UPDATE accounts SET connection_id = ? WHERE id = ?', 'c-mm', accountId);

  await registerWalletRoutes(ctx.app.app, { db: ctx.db, sync: ctx.app.sync });
  const session = await login(ctx);

  const first = await authRequest(ctx, session, { method: 'POST', url: `/api/wallets/${accountId}/resync` });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as WalletResyncResponse;
  // Le taux USDC→EUR n'est pas fourni en test : la ligne est signalée (PARTIAL),
  // jamais inventée. L'essentiel est qu'elle soit créée et non en échec.
  assert.notEqual(firstBody.outcome.status, 'FAILED');
  assert.equal(firstBody.outcome.created, 1);
  assert.equal(firstBody.wallet.accountId, accountId);
  assert.equal(firstBody.wallet.address, WALLET);
  assert.equal(firstBody.wallet.tokenCount, 1);

  const countAfterFirst = ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM activities')?.c;
  assert.equal(countAfterFirst, 1);

  // Deuxième synchronisation : AUCUN doublon.
  const second = await authRequest(ctx, session, { method: 'POST', url: `/api/wallets/${accountId}/resync` });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as WalletResyncResponse;
  assert.equal(secondBody.outcome.created, 0);
  assert.equal(secondBody.outcome.skipped, 1);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM activities')?.c, 1);

  const list = await authRequest(ctx, session, { method: 'GET', url: '/api/wallets' });
  assert.equal(list.statusCode, 200);
  const wallets = list.json() as WalletStatusDto[];
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0]?.address, WALLET);
});

test('routes : resynchroniser un compte inexistant ou non-crypto est refusé proprement', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await registerWalletRoutes(ctx.app.app, { db: ctx.db, sync: ctx.app.sync });
  const session = await login(ctx);

  const missing = await authRequest(ctx, session, { method: 'POST', url: '/api/wallets/inconnu/resync' });
  assert.equal(missing.statusCode, 404);

  const cashId = seedAccount(ctx.db, { name: 'Livret', type: 'CASH', providerId: 'manual', currency: 'EUR' });
  const notWallet = await authRequest(ctx, session, { method: 'POST', url: `/api/wallets/${cashId}/resync` });
  assert.equal(notWallet.statusCode, 400);
});
