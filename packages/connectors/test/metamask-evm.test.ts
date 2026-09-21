import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorError,
  FakeHttpClient,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
} from '../src/index.ts';
import {
  DEFAULT_CHAIN_IDS,
  DEFAULT_PROVIDER_ORDER,
  EvmProviderRegistry,
  ProviderHttpClient,
  TokenBucket,
  alchemyProvider,
  blockscoutProvider,
  defaultEvmProviders,
  etherscanProvider,
  getChain,
  listChains,
  normalizeChainActivity,
  positionsFromBalances,
  routescanProvider,
  unitsToNumber,
  type EvmChain,
  type EvmDataProvider,
  type EvmNativeBalance,
  type EvmProviderContext,
} from '../src/evm/index.ts';
import { fixture, jsonResponse } from './helpers.ts';

/**
 * Tests UNITAIRE des briques EVM (chaînes, providers, rate-limit, normalisation).
 * AUCUN réseau : tout passe par des clients HTTP scriptés et des fixtures locales.
 */

const WALLET = '0x1111111111111111111111111111111111111111';
const STAKING = '0x5555555555555555555555555555555555555555';

function mustChain(id: string): EvmChain {
  const chain = getChain(id);
  assert.ok(chain, `chaîne introuvable : ${id}`);
  return chain;
}

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

function contextWith(routes: ConstructorParameters<typeof FakeHttpClient>[0], apiKey: string | null = null): {
  ctx: EvmProviderContext;
  http: FakeHttpClient;
} {
  const http = new FakeHttpClient(routes);
  return { ctx: { http, address: WALLET, apiKey }, http };
}

/** Client HTTP scripté : renvoie les réponses dans l'ordre, pour tester le retry. */
class ScriptedHttpClient implements HttpClient {
  readonly requests: string[] = [];
  readonly #queue: HttpResponse[];
  constructor(responses: readonly HttpResponse[]) {
    this.#queue = [...responses];
  }
  async request(url: string, _options?: HttpRequestOptions): Promise<HttpResponse> {
    this.requests.push(url);
    return this.#queue.shift() ?? { status: 200, headers: {}, text: '{}' };
  }
  async json<T>(url: string, options?: HttpRequestOptions): Promise<T> {
    return JSON.parse((await this.request(url, options)).text) as T;
  }
  async sleep(): Promise<void> {}
}

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) };
}

/* ------------------------------------------------------------- chaînes */

test('evm/chains : les 7 réseaux sont déclarés avec chainId, explorer et décimales', () => {
  assert.deepEqual([...DEFAULT_CHAIN_IDS], ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bnb', 'avalanche']);
  assert.equal(listChains().length, 7);
  const expected: Record<string, number> = {
    ethereum: 1,
    arbitrum: 42161,
    optimism: 10,
    base: 8453,
    polygon: 137,
    bnb: 56,
    avalanche: 43114,
  };
  for (const [id, chainId] of Object.entries(expected)) {
    const chain = mustChain(id);
    assert.equal(chain.chainId, chainId);
    assert.equal(chain.nativeDecimals, 18);
    assert.ok(chain.explorerUrl.startsWith('http'));
    assert.ok(chain.name.length > 0);
  }
  // Les nœuds publics connus comme hors service ne doivent jamais servir de défaut.
  for (const chain of listChains()) {
    assert.equal(/llamarpc|ankr\.com|cloudflare-eth|polygon-rpc\.com/.test(chain.rpcUrl), false);
  }
  assert.equal(getChain('INCONNU'), null);
});

/* ------------------------------------------------------------ providers */

test('evm/providers : 4 providers interchangeables, aucun revendiqué comme testé en ligne', () => {
  const providers = defaultEvmProviders();
  assert.deepEqual(providers.map((provider) => provider.name), ['etherscan', 'blockscout', 'routescan', 'alchemy']);
  assert.deepEqual([...DEFAULT_PROVIDER_ORDER], ['etherscan', 'blockscout', 'routescan', 'alchemy']);

  for (const provider of providers) {
    assert.equal(provider.verifiedAgainstLiveService, false, `${provider.name} ne doit pas se dire vérifié`);
    assert.match(provider.verificationNote, /JAMAIS testé/i);
  }

  // Chaînes supportées par nature.
  assert.equal(etherscanProvider.supportsChain(mustChain('bnb')), true);
  assert.equal(blockscoutProvider.supportsChain(mustChain('bnb')), false, 'Blockscout n\'a pas d\'instance BNB');
  assert.equal(blockscoutProvider.supportsChain(mustChain('ethereum')), true);
  assert.equal(routescanProvider.supportsChain(mustChain('avalanche')), true);
  assert.equal(alchemyProvider.supportsChain(mustChain('polygon')), true);
});

test('evm/providers : Etherscan lit le solde natif (converti depuis les wei)', async () => {
  const { ctx } = contextWith([{ match: /action=balance/, respond: jsonResponse(jsonFixture('evm/balance-1eth.json')) }]);
  const balance = await etherscanProvider.getNativeBalance(ctx, mustChain('ethereum'));
  assert.equal(balance.quantity, 1);
  assert.equal(balance.symbol, 'ETH');
  assert.equal(balance.chain, 'ethereum');
});

test('evm/providers : la pagination Etherscan suit page/offset jusqu\'à épuisement', async () => {
  const { ctx, http } = contextWith([
    { match: /action=tokentx.*page=2/, respond: jsonResponse(jsonFixture('evm/tokentx-ethereum-page2.json')) },
    { match: /action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-ethereum-page1.json')) },
  ]);
  const page1 = await etherscanProvider.getTokenTransfers(ctx, mustChain('ethereum'), { page: 1, pageSize: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.cursor, '2');

  const page2 = await etherscanProvider.getTokenTransfers(ctx, mustChain('ethereum'), { page: 2, pageSize: 2 });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.items[0]?.symbol, 'WETH');
  assert.equal(page2.items[0]?.quantity, 0.75);
  assert.ok(http.requests.some((request) => request.url.includes('page=2')));
});

test('evm/providers : Alchemy lit les transferts ERC-20 (fixture, clé de test)', async () => {
  const { ctx } = contextWith(
    [{ match: /g\.alchemy\.com/, respond: jsonResponse(jsonFixture('evm/alchemy-asset-transfers.json')) }],
    'cle-de-test-alchemy',
  );
  assert.equal(alchemyProvider.isAvailable(ctx), true);
  const page = await alchemyProvider.getTokenTransfers(ctx, mustChain('ethereum'), { pageSize: 10 });
  assert.equal(page.items.length >= 1, true);
  const transfer = page.items[0];
  assert.equal(transfer?.contractAddress, '0x2222222222222222222222222222222222222222');
  assert.equal(transfer?.symbol, 'USDC');
  assert.equal(transfer?.quantity, 100);
});

test('evm/providers : sans clé, Alchemy est indisponible (jamais contacté)', () => {
  const { ctx } = contextWith([]);
  assert.equal(alchemyProvider.isAvailable(ctx), false);
  assert.equal(etherscanProvider.isAvailable(ctx), true, 'Etherscan reste utilisable sans clé sur le palier gratuit');
});

/* ----------------------------------------------------- repli automatique */

function makeProvider(
  name: string,
  supports: boolean,
  native: () => Promise<EvmNativeBalance>,
): EvmDataProvider {
  const unsupported = async (): Promise<never> => {
    throw new ConnectorError(name, 'NOT_SUPPORTED', 'non implémenté dans ce test');
  };
  return {
    name,
    verifiedAgainstLiveService: false,
    verificationNote: 'test',
    supportsChain: () => supports,
    isAvailable: () => true,
    getNativeBalance: native,
    getTokenBalances: unsupported,
    getTransactions: unsupported,
    getTokenTransfers: unsupported,
  };
}

const chain = mustChain('ethereum');

test('evm/repli : une erreur réseau sur le premier provider laisse le suivant répondre', async () => {
  const failing = makeProvider('failing', true, async () => {
    throw new ConnectorError('failing', 'NETWORK', 'connexion refusée');
  });
  const working = makeProvider('working', true, async () => ({
    chain: 'ethereum',
    symbol: 'ETH',
    decimals: 18,
    quantity: 2,
  }));
  const registry = new EvmProviderRegistry({ providers: [failing, working], order: ['failing', 'working'] });

  const { ctx } = contextWith([]);
  const result = await registry.query<EvmNativeBalance>({
    chain,
    operation: 'getNativeBalance',
    context: () => ctx,
    run: (provider, context) => provider.getNativeBalance(context, chain),
  });
  assert.equal(result.provider, 'working');
  assert.equal(result.value.quantity, 2);
});

test('evm/repli : tous les providers en panne -> erreur EXPLICITE (jamais un vide silencieux)', async () => {
  const one = makeProvider('one', true, async () => {
    throw new ConnectorError('one', 'PROVIDER_BROKEN', 'format modifié');
  });
  const two = makeProvider('two', true, async () => {
    throw new ConnectorError('two', 'PROVIDER_DOWN', 'injoignable');
  });
  const registry = new EvmProviderRegistry({ providers: [one, two], order: ['one', 'two'] });
  const { ctx } = contextWith([]);

  await assert.rejects(
    registry.query({
      chain,
      operation: 'getNativeBalance',
      context: () => ctx,
      run: (provider, context) => provider.getNativeBalance(context, chain),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.kind, 'PROVIDER_DOWN');
      assert.match(error.message, /one/);
      assert.match(error.message, /two/);
      return true;
    },
  );
});

test('evm/repli : aucun provider disponible pour la chaîne -> NOT_SUPPORTED', async () => {
  const incompatible = makeProvider('incompatible', false, async () => {
    throw new Error('ne doit jamais être appelé');
  });
  const registry = new EvmProviderRegistry({ providers: [incompatible], order: ['incompatible'] });
  const { ctx } = contextWith([]);

  await assert.rejects(
    registry.query({
      chain,
      operation: 'getNativeBalance',
      context: () => ctx,
      run: (provider, context) => provider.getNativeBalance(context, chain),
    }),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'NOT_SUPPORTED',
  );
});

test('evm/repli : un provider sans clé est ignoré sans être contacté', async () => {
  let called = 0;
  const alchemyLike: EvmDataProvider = {
    ...makeProvider('alchemy-like', true, async () => {
      called += 1;
      return { chain: 'ethereum', symbol: 'ETH', decimals: 18, quantity: 1 };
    }),
    isAvailable: (ctx) => ctx.apiKey !== null,
  };
  const registry = new EvmProviderRegistry({ providers: [alchemyLike], order: ['alchemy-like'] });
  const { ctx } = contextWith([]);
  await assert.rejects(
    registry.query({
      chain,
      operation: 'getNativeBalance',
      context: () => ctx,
      run: (provider, context) => provider.getNativeBalance(context, chain),
    }),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'NOT_SUPPORTED',
  );
  assert.equal(called, 0, 'un provider indisponible ne doit pas être appelé');
});

/* --------------------------------------------------------- rate-limit */

test('evm/rate-limit : un 429 est réessayé avec backoff puis réussit', async () => {
  const http = new ScriptedHttpClient([
    { status: 429, headers: {}, text: '{}' },
    { status: 429, headers: {}, text: '{}' },
    ok(jsonFixture('evm/balance-1eth.json')),
  ]);
  const client = new ProviderHttpClient(http, {
    provider: 'etherscan',
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 1000 },
    now: () => 0,
  });
  const payload = await client.json<{ result: string }>('https://api.etherscan.io/v2/api');
  assert.equal(payload.result, '1000000000000000000');
  assert.equal(http.requests.length, 3, 'deux réessais puis la réponse');
  assert.deepEqual(client.attempts.map((attempt) => attempt.status), [429, 429, 200]);
});

test('evm/rate-limit : un 429 persistant devient RATE_LIMITED (pas une boucle infinie)', async () => {
  const http = new ScriptedHttpClient([
    { status: 429, headers: {}, text: '{}' },
    { status: 429, headers: {}, text: '{}' },
    { status: 429, headers: {}, text: '{}' },
  ]);
  const client = new ProviderHttpClient(http, {
    provider: 'etherscan',
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 1000 },
    now: () => 0,
  });
  await assert.rejects(
    client.json('https://api.etherscan.io/v2/api'),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'RATE_LIMITED',
  );
  assert.equal(http.requests.length, 3);
});

test('evm/rate-limit : un 5xx persistant devient PROVIDER_DOWN', async () => {
  const http = new ScriptedHttpClient([
    { status: 503, headers: {}, text: '{}' },
    { status: 503, headers: {}, text: '{}' },
    { status: 503, headers: {}, text: '{}' },
  ]);
  const client = new ProviderHttpClient(http, {
    provider: 'blockscout',
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 1000 },
    now: () => 0,
  });
  await assert.rejects(
    client.request('https://eth.blockscout.com/api'),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'PROVIDER_DOWN',
  );
});

test('evm/rate-limit : le token bucket lisse les appels (attente calculée, pas bloquante)', async () => {
  let clock = 0;
  const bucket = new TokenBucket({ requestsPerSecond: 1, burst: 1 }, () => clock);
  await bucket.acquire(async () => {});
  assert.equal(bucket.available < 1, true, 'le seul jeton a été consommé');
  let waited = 0;
  await bucket.acquire(async (ms) => {
    waited = ms;
    clock += ms;
  });
  assert.ok(waited > 0, 'le second appel doit attendre un jeton');
  assert.equal(clock, 1000);
});

/* ------------------------------------------------------- normalisation */

test('evm/normalize : deux transferts de sens opposés dans un même hash deviennent un échange', async () => {
  const { ctx } = contextWith([{ match: /action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-swap.json')) }]);
  const page = await etherscanProvider.getTokenTransfers(ctx, chain, { pageSize: 10 });
  const items = normalizeChainActivity(
    { accountId: WALLET, address: WALLET, chain },
    { transfers: page.items },
  );
  assert.equal(items.length, 1);
  const swap = items[0];
  assert.equal(swap?.type, 'CRYPTO_SWAP');
  assert.match(swap?.description ?? '', /WETH/);
  assert.match(swap?.description ?? '', /USDC/);
  assert.equal(swap?.externalTransactionId, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee5:swap:0');
  assert.equal(swap?.amount, 0, 'un échange ne crée pas de flux net');
});

test('evm/normalize : le gaz payé devient une activité FEE, sans double comptage', async () => {
  const { ctx } = contextWith([{ match: /action=txlist/, respond: jsonResponse(jsonFixture('evm/txlist-ethereum.json')) }]);
  const page = await etherscanProvider.getTransactions(ctx, chain, { pageSize: 10 });
  const items = normalizeChainActivity({ accountId: WALLET, address: WALLET, chain }, { transactions: page.items });

  const fee = items.find((item) => item.type === 'FEE');
  assert.ok(fee, 'une activité FEE doit exister');
  assert.equal(fee.fees, 0.00042);
  assert.equal(fee.amount, -0.00042);
  assert.equal(fee.currency, 'ETH');
  assert.equal(fee.externalTransactionId, '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd4:fee');

  const native = items.find((item) => item.type === 'CRYPTO_TRANSFER');
  assert.equal(native?.amount, -0.1);
  assert.equal(native?.currency, 'ETH');
});

test('evm/normalize : une récompense de staking est détectable via la liste de contrats', async () => {
  const { ctx } = contextWith([{ match: /action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-staking.json')) }]);
  const page = await etherscanProvider.getTokenTransfers(ctx, chain, { pageSize: 10 });

  const without = normalizeChainActivity({ accountId: WALLET, address: WALLET, chain }, { transfers: page.items });
  assert.equal(without[0]?.type, 'CRYPTO_TRANSFER', 'sans liste, on ne devine pas');

  const withStaking = normalizeChainActivity(
    { accountId: WALLET, address: WALLET, chain, stakingContracts: [STAKING] },
    { transfers: page.items },
  );
  assert.equal(withStaking[0]?.type, 'STAKING_REWARD');
  assert.equal(withStaking[0]?.amount, 1.25);
  assert.equal(withStaking[0]?.currency, 'LDO');
});

test('evm/normalize : les identifiants externes sont stables et dédupliqués', async () => {
  const { ctx } = contextWith([{ match: /action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-ethereum-page1.json')) }]);
  const page = await etherscanProvider.getTokenTransfers(ctx, chain, { pageSize: 10 });
  const first = normalizeChainActivity({ accountId: WALLET, address: WALLET, chain }, { transfers: page.items });
  const second = normalizeChainActivity({ accountId: WALLET, address: WALLET, chain }, { transfers: page.items });
  assert.deepEqual(first.map((item) => item.externalTransactionId), second.map((item) => item.externalTransactionId));
  assert.deepEqual(first.map((item) => item.externalTransactionId), [
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1:0',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2:1',
  ]);
  // Le même transfert présent deux fois n'est produit qu'une fois.
  const item = page.items[0];
  assert.ok(item);
  const duplicated = normalizeChainActivity(
    { accountId: WALLET, address: WALLET, chain },
    { transfers: [item, item] },
  );
  assert.equal(duplicated.length, 1);
});

test('evm/normalize : positions construites depuis les soldes (jetons + natif)', () => {
  const positions = positionsFromBalances(
    { accountId: WALLET, address: WALLET, chain },
    [
      {
        contractAddress: '0x2222222222222222222222222222222222222222',
        symbol: 'usdc',
        name: 'Exemple USD Coin',
        decimals: 6,
        quantity: 100.5,
      },
      // Solde nul : pas de position inventée.
      {
        contractAddress: '0x8888888888888888888888888888888888888888',
        symbol: 'ZERO',
        name: 'Zéro',
        decimals: 18,
        quantity: 0,
      },
    ],
    1.2345,
  );
  const bySymbol = new Map(positions.map((position) => [position.symbol, position]));
  assert.equal(bySymbol.get('USDC')?.quantity, 100.5);
  assert.equal(bySymbol.get('USDC')?.decimals, 6);
  assert.equal(bySymbol.get('USDC')?.chain, 'ethereum');
  assert.equal(bySymbol.get('ETH')?.quantity, 1.2345);
  assert.equal(bySymbol.get('ETH')?.contractAddress, null);
  assert.equal(bySymbol.size, 2);
});

test('evm/normalize : unitsToNumber accepte le décimal (Etherscan) et l\'hexadécimal (JSON-RPC)', () => {
  assert.equal(unitsToNumber('1000000000000000000', 18), 1);
  assert.equal(unitsToNumber('0x0de0b6b3a7640000', 18), 1);
  assert.equal(unitsToNumber('100500000', 6), 100.5);
  assert.equal(unitsToNumber('pas-un-nombre', 18), null);
});
