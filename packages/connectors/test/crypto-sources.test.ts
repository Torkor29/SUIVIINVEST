/**
 * Sources crypto ajoutées : Bitcoin (adresses, xpub/ypub/zpub), Solana,
 * Binance, Kraken, Coinbase, Bitpanda. Tout est simulé : aucun appel réseau.
 */
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  binanceConnector,
  bitcoinConnector,
  bitpandaConnector,
  coinbaseConnector,
  krakenConnector,
  solanaConnector,
} from '../src/index.ts';
import { deriveAddress, parseBitcoinConfig } from '../src/providers/bitcoin.ts';
import { coinbaseJwt, collectBitpandaWallets, krakenSignature, krakenSymbol } from '../src/providers/exchanges.ts';
import { jsonResponse, makeTestContext } from './helpers.ts';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/** 1 EUR = 0.00001 BTC → 100 000 € le bitcoin ; 1 EUR = 0.01 SOL → 100 € le SOL. */
const COINBASE_RATES = {
  match: /api\.coinbase\.com\/v2\/exchange-rates/,
  respond: { data: { currency: 'EUR', rates: { BTC: '0.00001', SOL: '0.01', ETH: '0.0005', USDC: '1.08', USD: '1.08' } } },
};

function stats(sats: number, txCount: number) {
  return {
    chain_stats: { funded_txo_sum: sats, spent_txo_sum: 0, tx_count: txCount },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
  };
}

test('Bitcoin : dérivation BIP44/49/84 conforme aux vecteurs officiels', () => {
  assert.equal(deriveAddress(ZPUB, 0, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(deriveAddress(ZPUB, 1, 0), 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  assert.equal(
    deriveAddress(
      'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP',
      0,
      0,
    ),
    '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
  );
  assert.equal(
    deriveAddress(
      'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj',
      0,
      0,
    ),
    '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
  );
});

test('Bitcoin : clé privée et phrase de récupération refusées', () => {
  assert.throws(() => parseBitcoinConfig('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'), /PRIVÉE/);
  assert.throws(() => parseBitcoinConfig('adresse-invalide'), /invalide/);
  assert.deepEqual(parseBitcoinConfig(`bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu, ${ZPUB}`), {
    addresses: ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'],
    extendedKeys: [ZPUB],
  });
});

test('Bitcoin : une zpub parcourt ses adresses (limite de 20 vierges) et valorise en euros', async () => {
  const used = new Map([
    [deriveAddress(ZPUB, 0, 0), stats(50_000_000, 2)], // 0,5 BTC
    [deriveAddress(ZPUB, 0, 1), stats(0, 3)], // utilisée puis vidée
    [deriveAddress(ZPUB, 0, 2), stats(25_000_000, 1)], // 0,25 BTC
    [deriveAddress(ZPUB, 1, 0), stats(10_000_000, 1)], // monnaie rendue : 0,1 BTC
  ]);
  const { ctx, http } = makeTestContext({
    config: { addresses: ZPUB },
    routes: [
      COINBASE_RATES,
      {
        match: /mempool\.space\/api\/address\//,
        respond: (url: string) => jsonResponse(used.get(url.split('/').pop() ?? '') ?? stats(0, 0)),
      },
    ],
  });
  const accounts = await bitcoinConnector.syncAccounts(ctx);
  const positions = await bitcoinConnector.syncPositions(ctx, accounts);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.symbol, 'BTC');
  assert.ok(Math.abs((positions[0]?.quantity ?? 0) - 0.85) < 1e-12);
  assert.ok(Math.abs((positions[0]?.unitPrice ?? 0) - 100_000) < 1e-6);
  // Lots de 10 : réception 0-29 (3 utilisées + 20 vierges → 30 appels) ; monnaie 0-29 (idem).
  const explorerCalls = http.requests.filter((request) => request.url.includes('mempool.space')).length;
  assert.equal(explorerCalls, 30 + 30);
});

test('Solana : SOL natif et jetons SPL ; jetons inconnus sans cotation (spam) écartés', async () => {
  const address = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
  const { ctx } = makeTestContext({
    config: { address },
    routes: [
      COINBASE_RATES,
      { match: /coingecko\.com\/api\/v3\/simple\/token_price/, respond: {} },
      {
        match: /api\.mainnet-beta\.solana\.com/,
        respond: (url: string) => jsonResponse({ result: { value: 2_500_000_000 }, url }),
      },
    ],
  });
  // Le même point d'entrée RPC répond selon la méthode : on remplace `json` pour router le corps.
  const original = ctx.http.json.bind(ctx.http);
  ctx.http.json = async <T,>(url: string, options?: { body?: string }): Promise<T> => {
    if (url.includes('solana.com')) {
      const method = (JSON.parse(options?.body ?? '{}') as { method: string; params: unknown[] }).method;
      if (method === 'getBalance') return { result: { value: 2_500_000_000 } } as T;
      const program = ((JSON.parse(options?.body ?? '{}') as { params: [string, { programId: string }] }).params[1]).programId;
      if (program.startsWith('Tokenkeg')) {
        return {
          result: {
            value: [
              { account: { data: { parsed: { info: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenAmount: { uiAmount: 108, uiAmountString: '108', decimals: 6 } } } } } },
              { account: { data: { parsed: { info: { mint: 'Inconnu1111111111111111111111111111111111', tokenAmount: { uiAmount: 42, uiAmountString: '42', decimals: 0 } } } } } },
              { account: { data: { parsed: { info: { mint: 'Vide111111111111111111111111111111111111111', tokenAmount: { uiAmount: 0, uiAmountString: '0', decimals: 0 } } } } } },
            ],
          },
        } as T;
      }
      return { result: { value: [] } } as T;
    }
    return original<T>(url, options);
  };
  const positions = await solanaConnector.syncPositions(ctx, await solanaConnector.syncAccounts(ctx));
  const bySymbol = Object.fromEntries(positions.map((position) => [position.symbol, position]));
  assert.equal(bySymbol.SOL?.quantity, 2.5);
  assert.equal(bySymbol.SOL?.unitPrice, 100);
  assert.equal(bySymbol.USDC?.quantity, 108);
  assert.ok(Math.abs((bySymbol.USDC?.unitPrice ?? 0) - 1 / 1.08) < 1e-12);
  assert.equal(positions.find((position) => position.contractAddress === 'Inconnu1111111111111111111111111111111111'), undefined);
  assert.equal(positions.length, 2);
});

test('Kraken : signature conforme à la documentation officielle et codes d’actifs normalisés', () => {
  assert.equal(
    krakenSignature(
      '/0/private/AddOrder',
      '1616492376594',
      'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
      'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
    ),
    '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
  );
  assert.equal(krakenSymbol('XXBT'), 'BTC');
  assert.equal(krakenSymbol('ETH.F'), 'ETH');
  assert.equal(krakenSymbol('DOT.S'), 'DOT');
  assert.equal(krakenSymbol('ZEUR'), 'EUR');
  assert.equal(krakenSymbol('SOL'), 'SOL');
});

test('Kraken : soldes, épargne regroupée, euros en trésorerie, clé refusée signalée', async () => {
  const { ctx, http } = makeTestContext({
    secrets: { kraken_api_key: 'cle-publique', kraken_api_secret: Buffer.from('secret-de-test').toString('base64') },
    routes: [
      COINBASE_RATES,
      { match: /api\.kraken\.com\/0\/private\/Balance/, respond: { error: [], result: { XXBT: '0.5', 'XBT.F': '0.1', ZEUR: '250.40', 'ETH.F': '2' } } },
    ],
  });
  const accounts = await krakenConnector.syncAccounts(ctx);
  const positions = await krakenConnector.syncPositions(ctx, accounts);
  const balances = await krakenConnector.syncBalances(ctx, accounts);
  assert.deepEqual(
    positions.map((position) => [position.symbol, position.quantity]).sort(),
    [['BTC', 0.6], ['ETH', 2]],
  );
  assert.equal(balances[0]?.cash, 250.4);
  const request = http.requests.find((row) => row.url.includes('/private/Balance'));
  assert.equal(request?.options.headers?.['API-Key'], 'cle-publique');
  assert.ok(request?.options.headers?.['API-Sign']);

  const refused = makeTestContext({
    secrets: { kraken_api_key: 'x', kraken_api_secret: 'eA==' },
    routes: [{ match: /Balance/, respond: { error: ['EGeneral:Permission denied'] } }],
  });
  const result = await krakenConnector.testConnection(refused.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'AUTH_REQUIRED');
  assert.match(result.message, /Query Funds/);
});

test('Binance : requête signée HMAC, épargne et financement additionnés, LD* non doublé', async () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const { ctx, http } = makeTestContext({
    secrets: { binance_api_key: 'cle-binance', binance_api_secret: secret },
    routes: [
      COINBASE_RATES,
      { match: /\/api\/v3\/account/, respond: { balances: [{ asset: 'BTC', free: '0.1', locked: '0' }, { asset: 'LDBTC', free: '0.2', locked: '0' }, { asset: 'EUR', free: '10', locked: '0' }] } },
      { match: /simple-earn\/flexible/, respond: { rows: [{ asset: 'BTC', totalAmount: '0.2' }] } },
      { match: /simple-earn\/locked/, respond: { rows: [{ asset: 'ETH', amount: '1' }] } },
      { match: /get-funding-asset/, respond: [{ asset: 'USDC', free: '50', locked: '0', freeze: '0' }] },
    ],
  });
  const accounts = await binanceConnector.syncAccounts(ctx);
  const positions = await binanceConnector.syncPositions(ctx, accounts);
  const quantities = Object.fromEntries(positions.map((position) => [position.symbol, position.quantity]));
  assert.ok(Math.abs((quantities.BTC ?? 0) - 0.3) < 1e-12);
  assert.equal(quantities.ETH, 1);
  assert.equal(quantities.USDC, 50);
  // Signature : HMAC-SHA256 de la chaîne de requête, recalculée ici.
  const url = new URL(http.requests.find((row) => row.url.includes('/api/v3/account'))?.url ?? '');
  const signature = url.searchParams.get('signature');
  url.searchParams.delete('signature');
  assert.equal(signature, createHmac('sha256', secret).update(url.searchParams.toString()).digest('hex'));
  assert.equal(http.requests[0]?.options.headers?.['X-MBX-APIKEY'], 'cle-binance');
});

test('Coinbase : JWT ES256 et Ed25519 vérifiables, pagination des comptes', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString();
  const jwt = coinbaseJwt('organizations/o/apiKeys/k', pem, 'GET', '/api/v3/brokerage/accounts', new Date('2026-09-23T12:00:00Z'));
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).uri, 'GET api.coinbase.com/api/v3/brokerage/accounts');
  assert.ok(
    verify('sha256', Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
  );

  const ed = generateKeyPairSync('ed25519');
  const jwk = ed.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const raw = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64');
  const edJwt = coinbaseJwt('cle-ed', raw, 'GET', '/api/v3/brokerage/accounts', new Date());
  const [edHeader, edPayload, edSignature] = edJwt.split('.') as [string, string, string];
  assert.equal(JSON.parse(Buffer.from(edHeader, 'base64url').toString()).alg, 'EdDSA');
  assert.ok(verify(null, Buffer.from(`${edHeader}.${edPayload}`), ed.publicKey, Buffer.from(edSignature, 'base64url')));

  let page = 0;
  const { ctx } = makeTestContext({
    secrets: { coinbase_api_key_name: 'organizations/o/apiKeys/k', coinbase_api_private_key: pem },
    routes: [
      COINBASE_RATES,
      {
        match: /brokerage\/accounts/,
        respond: () => {
          page += 1;
          return jsonResponse(
            page === 1
              ? { accounts: [{ currency: 'BTC', available_balance: { value: '0.1' }, hold: { value: '0.05' } }], has_next: true, cursor: 'suite' }
              : { accounts: [{ currency: 'EUR', available_balance: { value: '12.5' }, hold: { value: '0' } }], has_next: false },
          );
        },
      },
    ],
  });
  const accounts = await coinbaseConnector.syncAccounts(ctx);
  const positions = await coinbaseConnector.syncPositions(ctx, accounts);
  const balances = await coinbaseConnector.syncBalances(ctx, accounts);
  assert.ok(Math.abs((positions[0]?.quantity ?? 0) - 0.15) < 1e-12);
  assert.equal(balances[0]?.cash, 12.5);
  assert.equal(page, 2);
});

test('Bitpanda : portefeuilles d’actifs imbriqués et cours Bitpanda', async () => {
  const assetWallets = {
    data: {
      attributes: {
        cryptocoin: { attributes: { wallets: [{ id: 'w1', type: 'wallet', attributes: { cryptocoin_symbol: 'BTC', balance: '0.02', name: 'BTC Wallet', deleted: false } }] } },
        commodity: { metal: { attributes: { wallets: [{ id: 'w2', type: 'wallet', attributes: { cryptocoin_symbol: 'XAU', balance: '3', name: 'Or', deleted: false } }] } } },
      },
    },
  };
  assert.equal(collectBitpandaWallets(assetWallets).size, 2);
  const { ctx } = makeTestContext({
    secrets: { bitpanda_api_key: 'cle-bitpanda' },
    routes: [
      COINBASE_RATES,
      { match: /v1\/asset-wallets/, respond: assetWallets },
      { match: /v1\/fiatwallets/, respond: { data: [{ id: 'f1', attributes: { fiat_symbol: 'EUR', balance: '99.90' } }] } },
      { match: /v1\/ticker/, respond: { BTC: { EUR: '80000' }, XAU: { EUR: '110' } } },
    ],
  });
  const accounts = await bitpandaConnector.syncAccounts(ctx);
  const positions = await bitpandaConnector.syncPositions(ctx, accounts);
  const balances = await bitpandaConnector.syncBalances(ctx, accounts);
  const bySymbol = Object.fromEntries(positions.map((position) => [position.symbol, position]));
  assert.equal(bySymbol.BTC?.unitPrice, 80000);
  assert.equal(bySymbol.XAU?.quantity, 3);
  assert.equal(balances[0]?.cash, 99.9);
});

test('les clés manquantes donnent une consigne claire, pas une erreur technique', async () => {
  const { ctx } = makeTestContext();
  for (const connector of [binanceConnector, krakenConnector, coinbaseConnector, bitpandaConnector]) {
    const result = await connector.testConnection(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'AUTH_REQUIRED');
    assert.match(result.message, /manquant/);
  }
});
