import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, createDefaultRegistry } from '../src/index.ts';
import { metamaskConnector, metamaskInternals } from '../src/providers/metamask.ts';
import { expectConnectorError, fixture, formatOf, jsonResponse, makeTestContext } from './helpers.ts';

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x2222222222222222222222222222222222222222';
const WETH = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';

/** 1 ETH = 10^18 wei, en hexadécimal JSON-RPC. */
const ONE_ETH_HEX = '0x0de0b6b3a7640000';

const TRANSFERS = [
  {
    hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    logIndex: '0',
    timeStamp: '1772000000',
    from: OTHER,
    to: WALLET,
    contractAddress: USDC,
    tokenName: 'Exemple USD Coin',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    value: '100500000',
  },
  {
    hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
    logIndex: '1',
    timeStamp: '1772100000',
    from: WALLET,
    to: OTHER,
    contractAddress: USDC,
    tokenName: 'Exemple USD Coin',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    value: '500000',
  },
  {
    hash: '0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc3',
    logIndex: '0',
    timeStamp: '1772200000',
    from: OTHER,
    to: WALLET,
    contractAddress: WETH,
    tokenName: 'Exemple Wrapped Ether',
    tokenSymbol: 'weth',
    tokenDecimal: '18',
    value: '750000000000000000',
  },
];

const ROUTES = [
  { match: /tokentx/, respond: jsonResponse({ status: '1', message: 'OK', result: TRANSFERS }) },
  { match: /./, respond: jsonResponse({ result: ONE_ETH_HEX }) },
];

const WALLET_CONFIG = { address: WALLET, chain: 'ethereum' };
const JSON_FORMAT = formatOf(metamaskConnector, 'metamask-address-json');

test('metamask : capabilities — API publique oui, revenus non, aucun secret requis', () => {
  assert.equal(metamaskConnector.id, 'metamask');
  assert.equal(metamaskConnector.capabilities.api, true);
  assert.equal(metamaskConnector.capabilities.income, false);
  assert.deepEqual(metamaskConnector.requiredConfig, ['address']);
  assert.deepEqual(metamaskConnector.requiredSecrets, []);
});

test('metamask : aucune surface d\'écriture ni secret de signature', () => {
  const connectorKeys = Object.keys(metamaskConnector);
  const forbidden = /(^|_)(sign|send|withdraw|order|buy|sell|private|seed|password|pin)/i;
  for (const key of connectorKeys) {
    assert.equal(forbidden.test(key), false, `méthode ou champ interdit exposé : ${key}`);
  }

  // Aucun nom de méthode de signature / d'envoi de transaction.
  const source = metamaskConnector;
  for (const name of ['signMessage', 'signTypedData', 'eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction']) {
    assert.equal(name in source, false, `capacité d'écriture détectée : ${name}`);
  }

  // Aucun champ ne doit accepter de clé privée / seed / mot de passe.
  for (const secretName of metamaskConnector.requiredSecrets) {
    assert.equal(/key|seed|mnemonic|password|pin/i.test(secretName), false);
  }
  assert.deepEqual(metamaskConnector.requiredConfig, ['address']);
});

test('metamask : toute configuration de signature est refusée explicitement', () => {
  const { assertNoSigningMaterial, FORBIDDEN_CONFIG_KEYS } = metamaskInternals;
  assertNoSigningMaterial({ address: WALLET, chain: 'ethereum' });
  for (const key of ['privateKey', 'seed', 'mnemonic', 'password', 'PIN']) {
    const normalized = key.toLowerCase();
    assert.ok(
      FORBIDDEN_CONFIG_KEYS.includes(normalized),
      `« ${key} » devrait être dans la liste des champs interdits`,
    );
    assert.throws(
      () => assertNoSigningMaterial({ address: WALLET, [key]: 'valeur-quelconque' }),
      (error: unknown) => error instanceof ConnectorError && error.kind === 'DATA',
    );
  }
});

test('metamask : une adresse invalide est refusée, jamais devinée', async () => {
  const { ctx } = makeTestContext({ config: { address: 'pas-une-adresse' } });
  const error = await expectConnectorError(metamaskConnector.syncAccounts(ctx), 'DATA');
  assert.match(error.message, /Adresse publique EVM/);

  const missing = makeTestContext({ config: {} });
  await expectConnectorError(metamaskConnector.syncAccounts(missing.ctx), 'DATA');
});

test('metamask : testConnection interroge le nœud RPC (réseau simulé, aucun appel réel)', async () => {
  const { ctx, http } = makeTestContext({ config: WALLET_CONFIG, routes: ROUTES });
  const result = await metamaskConnector.testConnection(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'CONNECTED');
  assert.match(result.message, /1 ETH/);
  assert.equal(http.requests.length, 1);
  // Le défaut doit être un endpoint RPC vérifié comme répondant sans clé :
  // plusieurs nœuds publics historiquement cités refusent désormais eth_getBalance.
  assert.match(http.requests[0]?.url ?? '', /publicnode|base\.org|arbitrum\.io|optimism\.io|binance\.org|avax\.network/);
  assert.ok(
    !/cloudflare-eth|llamarpc|ankr\.com|polygon-rpc/.test(http.requests[0]?.url ?? ''),
    'aucun endpoint connu comme hors service ne doit servir de défaut',
  );
});

test('metamask : configuration RPC surchargeable et clé d\'explorateur optionnelle jamais loggée', async () => {
  const { ctx, http } = makeTestContext({
    config: { ...WALLET_CONFIG, rpcUrl: 'https://rpc.exemple.test/', explorerUrl: 'https://explorateur.exemple.test/api' },
    secrets: { explorerApiKey: 'clef-de-test-anonyme' },
    routes: [
      { match: /explorateur/, respond: jsonResponse({ status: '1', message: 'OK', result: [] }) },
      { match: /./, respond: jsonResponse({ result: ONE_ETH_HEX }) },
    ],
  });
  const accounts = await metamaskConnector.syncAccounts(ctx);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.externalAccountId, WALLET);
  assert.equal(accounts[0]?.type, 'CRYPTO');
  assert.equal(accounts[0]?.currency, 'ETH');

  await metamaskConnector.syncTransactions(ctx, {});
  const explorerCall = http.requests.find((request) => request.url.includes('explorateur'));
  assert.ok(explorerCall, 'l\'explorateur doit avoir été appelé');
  assert.match(explorerCall.url, /action=tokentx/);
  assert.match(explorerCall.url, /apikey=/);

  // Aucun log ne doit contenir la clé.
  const { lines } = makeTestContext({ routes: [] });
  assert.equal(lines.length, 0);
});

test('metamask : le solde natif est converti depuis les wei', async () => {
  const { ctx } = makeTestContext({ config: WALLET_CONFIG, routes: ROUTES });
  const balances = await metamaskConnector.syncBalances(ctx, []);
  assert.equal(balances.length, 1);
  assert.equal(balances[0]?.cash, 1);
  assert.equal(balances[0]?.currency, 'ETH');
  assert.equal(balances[0]?.date, '2026-04-15');
  assert.equal(balances[0]?.externalAccountId, WALLET);
});

test('metamask : positions agrégées depuis les transferts + solde natif', async () => {
  const { ctx } = makeTestContext({ config: WALLET_CONFIG, routes: ROUTES });
  const positions = await metamaskConnector.syncPositions(ctx, [{ externalAccountId: WALLET, name: 'W', type: 'CRYPTO', currency: 'ETH', rawSourceType: 'evm.eoa' }]);

  const bySymbol = new Map(positions.map((position) => [position.symbol, position]));
  assert.equal(bySymbol.get('USDC')?.quantity, 100, '100,5 reçus - 0,5 envoyés');
  assert.equal(bySymbol.get('USDC')?.decimals, 6);
  assert.equal(bySymbol.get('USDC')?.contractAddress, USDC);
  assert.equal(bySymbol.get('USDC')?.kind, 'CRYPTO');
  assert.equal(bySymbol.get('WETH')?.quantity, 0.75);
  assert.equal(bySymbol.get('ETH')?.quantity, 1);
  assert.equal(bySymbol.get('ETH')?.contractAddress, null);
});

test('metamask : transactions on-chain — transferts signés, curseur = dernier hash', async () => {
  const { ctx, http } = makeTestContext({ config: WALLET_CONFIG, routes: ROUTES });
  const { items, cursor } = await metamaskConnector.syncTransactions(ctx, {});

  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.type === 'CRYPTO_TRANSFER'));
  assert.deepEqual(items.map((item) => item.amount), [100.5, -0.5, 0.75]);
  assert.deepEqual(items.map((item) => item.currency), ['USDC', 'USDC', 'WETH']);
  assert.equal(items[0]?.externalTransactionId, `${TRANSFERS[0]?.hash}:0`);
  assert.match(items[0]?.date ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cursor.value, TRANSFERS[2]?.hash);
  // Le montant reste dans l'unité du jeton : aucune conversion fiat inventée.
  assert.ok(items.every((item) => item.unitPrice === null));
  assert.equal(http.requests.some((request) => request.url.includes('tokentx')), true);
});

test('metamask : une réponse d\'explorateur invalide devient une erreur explicite', async () => {
  const { ctx } = makeTestContext({
    config: WALLET_CONFIG,
    routes: [
      { match: /tokentx/, respond: jsonResponse({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }) },
      { match: /./, respond: jsonResponse({ result: ONE_ETH_HEX }) },
    ],
  });
  const error = await expectConnectorError(metamaskConnector.syncTransactions(ctx, {}), 'PROVIDER_BROKEN');
  assert.match(error.message, /max rate limit/i);

  const empty = makeTestContext({
    config: WALLET_CONFIG,
    routes: [
      { match: /tokentx/, respond: jsonResponse({ status: '0', message: 'No transactions found', result: [] }) },
      { match: /./, respond: jsonResponse({ result: ONE_ETH_HEX }) },
    ],
  });
  const result = await metamaskConnector.syncTransactions(empty.ctx, {});
  assert.deepEqual(result.items, []);
});

test('metamask : syncIncome ne devine rien', async () => {
  const { ctx } = makeTestContext({ config: WALLET_CONFIG, routes: ROUTES });
  assert.deepEqual(await metamaskConnector.syncIncome(ctx, {}), []);
  assert.equal((await metamaskConnector.getSyncStatus(ctx)).status, 'CONNECTED');
});

test('metamask : import JSON (repli fichier) — positions et transactions', () => {
  const content = fixture('metamask-address.json');
  assert.equal(JSON_FORMAT.detect(content), 1);
  assert.equal(JSON_FORMAT.detect('{"activities":[]}'), 0);

  const result = JSON_FORMAT.parse(content);
  assert.equal(result.positions.length, 2);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.errors.length, 0);

  const usdc = result.positions.find((position) => position.symbol === 'USDC');
  assert.equal(usdc?.quantity, 100.5);
  assert.equal(usdc?.decimals, 6);
  assert.equal(usdc?.chain, 'ethereum');

  const outgoing = result.transactions.find((item) => item.amount < 0);
  assert.equal(outgoing?.amount, -0.25);
  assert.equal(outgoing?.currency, 'WETH');

  const registry = createDefaultRegistry();
  assert.equal(registry.detectImportFormat(content)?.format.id, 'metamask-address-json');
});

test('metamask : un JSON invalide produit une erreur, pas un résultat vide silencieux', () => {
  const result = JSON_FORMAT.parse('{ ceci n\'est pas du JSON');
  assert.equal(result.transactions.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.reason ?? '', /JSON invalide/);
});