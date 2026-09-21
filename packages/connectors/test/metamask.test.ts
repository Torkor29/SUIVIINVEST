import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, createDefaultRegistry } from '../src/index.ts';
import { metamaskConnector, metamaskInternals } from '../src/providers/metamask.ts';
import { expectConnectorError, fixture, formatOf, jsonResponse, makeTestContext } from './helpers.ts';

/**
 * Connecteur MetaMask / wallet EVM — chemin API multi-chaînes.
 * Aucun accès réseau : toutes les réponses viennent de fixtures locales.
 */

const WALLET = '0x1111111111111111111111111111111111111111';

const CHAINS = { address: WALLET, chains: 'ethereum,polygon', providerOrder: 'etherscan' };
const ETHEREUM_ONLY = { address: WALLET, chains: 'ethereum', providerOrder: 'etherscan' };

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

/** Routes Etherscan V2 : l'URL porte `chainid=<n>` et `action=<...>`. */
const ROUTES = [
  { match: /chainid=1&.*action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-ethereum-page1.json')) },
  { match: /chainid=1&.*action=txlist/, respond: jsonResponse(jsonFixture('evm/txlist-ethereum.json')) },
  { match: /chainid=1&.*action=balance/, respond: jsonResponse(jsonFixture('evm/balance-1eth.json')) },
  { match: /chainid=137&.*action=tokentx/, respond: jsonResponse(jsonFixture('evm/tokentx-polygon.json')) },
  { match: /chainid=137&.*action=txlist/, respond: jsonResponse(jsonFixture('evm/empty-list.json')) },
  { match: /chainid=137&.*action=balance/, respond: jsonResponse(jsonFixture('evm/balance-polygon.json')) },
];

const JSON_FORMAT = formatOf(metamaskConnector, 'metamask-address-json');

test('metamask : capabilities — API publique oui, revenus non, aucun secret requis', () => {
  assert.equal(metamaskConnector.id, 'metamask');
  assert.equal(metamaskConnector.capabilities.api, true);
  assert.equal(metamaskConnector.capabilities.transactions, true);
  assert.equal(metamaskConnector.capabilities.income, false);
  assert.deepEqual(metamaskConnector.requiredConfig, ['address']);
  assert.deepEqual(metamaskConnector.requiredSecrets, []);
});

test("metamask : aucune surface d'écriture ni secret de signature", () => {
  const connectorKeys = Object.keys(metamaskConnector);
  const forbidden = /(^|_)(sign|send|withdraw|order|buy|sell|private|seed|password|pin)/i;
  for (const key of connectorKeys) {
    assert.equal(forbidden.test(key), false, `méthode ou champ interdit exposé : ${key}`);
  }
  for (const name of ['signMessage', 'signTypedData', 'eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction']) {
    assert.equal(name in metamaskConnector, false, `capacité d'écriture détectée : ${name}`);
  }
  for (const secretName of metamaskConnector.requiredSecrets) {
    assert.equal(/key|seed|mnemonic|password|pin/i.test(secretName), false);
  }
  assert.deepEqual(metamaskConnector.requiredConfig, ['address']);
});

test('metamask : toute configuration de signature est refusée explicitement', () => {
  const { assertNoSigningMaterial, FORBIDDEN_CONFIG_KEYS } = metamaskInternals;
  assertNoSigningMaterial({ address: WALLET, chains: 'ethereum' });
  for (const key of ['privateKey', 'seed', 'mnemonic', 'password', 'PIN']) {
    const normalized = key.toLowerCase();
    assert.ok(FORBIDDEN_CONFIG_KEYS.includes(normalized), `« ${key} » devrait être interdit`);
    assert.throws(
      () => assertNoSigningMaterial({ address: WALLET, [key]: 'valeur-quelconque' }),
      (error: unknown) => error instanceof ConnectorError && error.kind === 'DATA',
    );
  }
});

test('metamask : le registre déclare les 7 chaînes, extensible par ajout', () => {
  assert.equal(metamaskInternals.SUPPORTED_CHAINS.length, 7);
  assert.ok(metamaskInternals.SUPPORTED_CHAINS.includes('avalanche'));
  assert.ok(metamaskInternals.SUPPORTED_CHAINS.includes('bnb'));
});

test('metamask : une adresse invalide est refusée, jamais devinée', async () => {
  const { ctx } = makeTestContext({ config: { address: 'pas-une-adresse' } });
  const error = await expectConnectorError(metamaskConnector.syncAccounts(ctx), 'DATA');
  assert.match(error.message, /Adresse publique EVM/);

  const missing = makeTestContext({ config: {} });
  await expectConnectorError(metamaskConnector.syncAccounts(missing.ctx), 'DATA');
});

test('metamask : testConnection lit le solde natif via le provider configuré', async () => {
  const { ctx, http } = makeTestContext({ config: CHAINS, routes: ROUTES });
  const result = await metamaskConnector.testConnection(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'CONNECTED');
  assert.match(result.message, /solde natif 1 ETH/);
  assert.match(result.message, /2 chaîne\(s\)/);
  const firstCall = http.requests[0]?.url ?? '';
  assert.match(firstCall, /api\.etherscan\.io\/v2\/api\?chainid=1/);
  assert.match(firstCall, /action=balance/);
});

test('metamask : une chaîne inconnue est signalée et ignorée (jamais devinée)', async () => {
  const { ctx, lines } = makeTestContext({
    config: { address: WALLET, chains: 'ethereum,inconnue', providerOrder: 'etherscan' },
    routes: ROUTES,
  });
  const accounts = await metamaskConnector.syncAccounts(ctx);
  assert.equal(accounts.length, 1);
  assert.ok(lines.some((line) => line.level === 'warn' && /inconnue/.test(line.message)));
});

test('metamask : la clé d\'explorateur optionnelle est utilisée mais jamais journalisée', async () => {
  const secret = 'clef-exemple-000000000000';
  const { ctx, http, lines } = makeTestContext({
    config: ETHEREUM_ONLY,
    secrets: { etherscan_api_key: secret },
    routes: ROUTES,
  });
  await metamaskConnector.syncTransactions(ctx, {});
  const call = http.requests.find((request) => request.url.includes('action=tokentx'));
  assert.ok(call);
  assert.match(call.url, /apikey=/);
  assert.equal(
    lines.some((line) => line.message.includes(secret)),
    false,
    'aucun log ne doit contenir la clé',
  );
});

test('metamask : un wallet vide ne produit ni positions ni transactions (aucune donnée inventée)', async () => {
  const { ctx } = makeTestContext({
    config: ETHEREUM_ONLY,
    routes: [
      { match: /action=balance/, respond: jsonResponse(jsonFixture('evm/balance-0.json')) },
      { match: /action=tokentx/, respond: jsonResponse(jsonFixture('evm/empty-list.json')) },
      { match: /action=txlist/, respond: jsonResponse(jsonFixture('evm/empty-list.json')) },
    ],
  });
  const transactions = await metamaskConnector.syncTransactions(ctx, {});
  assert.deepEqual(transactions.items, []);
  assert.deepEqual(await metamaskConnector.syncPositions(ctx, []), []);
  const status = await metamaskConnector.testConnection(ctx);
  assert.equal(status.ok, true);
  assert.match(status.message, /solde natif 0 ETH/);
});

test('metamask : wallet multi-chaînes — positions par chaîne (jetons + natif)', async () => {
  const { ctx } = makeTestContext({ config: CHAINS, routes: ROUTES });
  const positions = await metamaskConnector.syncPositions(ctx, []);
  const byKey = new Map(positions.map((position) => [`${position.chain}:${position.symbol}`, position]));

  assert.equal(byKey.get('ethereum:USDC')?.quantity, 100, '100,5 reçus − 0,5 envoyés');
  assert.equal(byKey.get('ethereum:USDC')?.decimals, 6);
  assert.equal(byKey.get('ethereum:ETH')?.quantity, 1);
  assert.equal(byKey.get('polygon:MTK')?.quantity, 2);
  assert.equal(byKey.get('polygon:POL')?.quantity, 5);
  assert.ok(positions.every((position) => position.kind === 'CRYPTO'));
});

test('metamask : transactions multi-chaînes — transferts signés, gaz en frais, curseur par chaîne', async () => {
  const { ctx, http } = makeTestContext({ config: CHAINS, routes: ROUTES });
  const { items, cursor } = await metamaskConnector.syncTransactions(ctx, {});

  const transferOut = items.find((item) => item.externalAssetId?.endsWith('2222') && item.amount < 0);
  assert.equal(transferOut?.amount, -0.5);
  assert.equal(transferOut?.currency, 'USDC');
  assert.equal(transferOut?.type, 'CRYPTO_TRANSFER');

  const fee = items.find((item) => item.type === 'FEE');
  assert.ok(fee, 'le gaz doit apparaître en frais');
  assert.ok((fee?.fees ?? 0) > 0);

  const polygonItem = items.find((item) => item.currency === 'MTK');
  assert.equal(polygonItem?.amount, 2);

  const parsed = JSON.parse(cursor.value ?? '{}') as Record<string, number | null>;
  assert.ok('ethereum' in parsed);
  assert.ok('polygon' in parsed);
  assert.equal(http.requests.some((request) => request.url.includes('chainid=137')), true);

  // Aucune conversion fiat inventée.
  assert.ok(items.every((item) => item.unitPrice === null));
});

test('metamask : la progression incrémentale filtre sur `since`', async () => {
  const { ctx } = makeTestContext({ config: CHAINS, routes: ROUTES });
  const full = await metamaskConnector.syncTransactions(ctx, {});
  const latestDate = full.items.map((item) => item.date).sort().at(-1);
  assert.ok(latestDate);
  const incremental = await metamaskConnector.syncTransactions(ctx, { since: latestDate });
  assert.ok(incremental.items.length > 0);
  assert.ok(incremental.items.length < full.items.length);
  assert.ok(incremental.items.every((item) => item.date >= (latestDate as string)));
});

test('metamask : une chaîne en panne n\'empêche pas les autres (reprise après erreur)', async () => {
  const { ctx, lines } = makeTestContext({
    config: { address: WALLET, chains: 'ethereum,bnb', providerOrder: 'etherscan' },
    routes: [
      { match: /chainid=56&.*action=tokentx/, respond: { status: 500, headers: {}, text: 'boom' } },
      ...ROUTES,
    ],
  });
  const { items } = await metamaskConnector.syncTransactions(ctx, {});
  assert.ok(items.length > 0, 'Ethereum doit être remonté malgré la panne BNB');
  assert.equal(items.some((item) => item.currency === 'BNB'), false);
  assert.ok(lines.some((line) => line.level === 'warn' && /BNB/.test(line.message)));
});

test('metamask : provider en panne sur TOUTES les chaînes -> erreur explicite', async () => {
  const { ctx } = makeTestContext({
    config: { address: WALLET, chains: 'bnb', providerOrder: 'etherscan' },
    routes: [{ match: /etherscan/, respond: { status: 500, headers: {}, text: 'boom' } }],
  });
  const error = await expectConnectorError(metamaskConnector.syncTransactions(ctx, {}), 'PROVIDER_DOWN');
  assert.match(error.message, /bnb/);
});

test('metamask : une réponse de provider invalide remonte une erreur, pas un tableau vide', async () => {
  const { ctx } = makeTestContext({
    config: ETHEREUM_ONLY,
    routes: [
      { match: /action=tokentx/, respond: jsonResponse({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }) },
      { match: /./, respond: jsonResponse(jsonFixture('evm/balance-1eth.json')) },
    ],
  });
  const error = await expectConnectorError(metamaskConnector.syncTransactions(ctx, {}), 'PROVIDER_DOWN');
  assert.match(error.message, /RATE_LIMITED/);
});

test('metamask : le solde natif est exposé comme trésorerie de la chaîne principale', async () => {
  const { ctx } = makeTestContext({ config: CHAINS, routes: ROUTES });
  const balances = await metamaskConnector.syncBalances(ctx, []);
  assert.equal(balances.length, 1);
  assert.equal(balances[0]?.cash, 1);
  assert.equal(balances[0]?.currency, 'ETH');
  assert.equal(balances[0]?.date, '2026-04-15');
  assert.equal(balances[0]?.externalAccountId, WALLET);
});

test('metamask : syncIncome ne devine rien et le statut reste CONNECTED', async () => {
  const { ctx } = makeTestContext({ config: CHAINS, routes: ROUTES });
  assert.deepEqual(await metamaskConnector.syncIncome(ctx, {}), []);
  const status = await metamaskConnector.getSyncStatus(ctx);
  assert.equal(status.status, 'CONNECTED');
  assert.match(status.message, /Ethereum/);
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
