import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorError,
  type ConnectorContext,
  type SidecarRequest,
  type SidecarResponse,
  type SidecarTransport,
} from '../src/index.ts';
import { degiroConnector } from '../src/providers/degiro.ts';
import { makeTestContext } from './helpers.ts';

/**
 * Mode API du connecteur DEGIRO, testé hors ligne avec un sidecar SIMULÉ.
 *
 * Aucun identifiant réel, aucun réseau : le faux transport reproduit le contrat
 * `{ok,data}` / `{ok:false,code,message}` et vérifie que le connecteur normalise
 * puis traduit fidèlement chaque code d'erreur en `ConnectorError`.
 */

interface Recording {
  readonly transport: SidecarTransport;
  readonly calls: SidecarRequest[];
}

function fakeTransport(
  handler: (request: SidecarRequest) => SidecarResponse | Promise<SidecarResponse>,
  options: { name?: string; available?: boolean } = {},
): Recording {
  const calls: SidecarRequest[] = [];
  const transport: SidecarTransport = {
    name: options.name ?? 'degiro',
    isAvailable: () => options.available ?? true,
    async call<T = unknown>(request: SidecarRequest): Promise<SidecarResponse<T>> {
      calls.push(request);
      return (await handler(request)) as SidecarResponse<T>;
    },
  };
  return { transport, calls };
}

function ctxWithSidecar(transport: SidecarTransport, secrets: Record<string, string> = {}): ConnectorContext {
  const { ctx } = makeTestContext({ secrets });
  return { ...ctx, sidecars: { degiro: transport } };
}

const SUCCESS_DATA: Readonly<Record<string, unknown>> = {
  test: { library: 'degiro-connector', readOnly: true },
  accounts: {
    accounts: [
      { id: '12345678', name: 'Compte-titres DEGIRO', currency: 'EUR', type: 'SECURITIES', balance: 2500.5 },
      { id: '12345678-cash', name: 'Compte espèces EUR', currency: 'EUR', type: 'CASH', balance: 812.34 },
    ],
  },
  balances: { balances: [{ accountId: '12345678-cash', date: '2026-04-15', cash: 812.34, currency: 'EUR' }] },
  positions: {
    positions: [
      {
        accountId: '12345678',
        productId: 'P123',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 10,
        price: 100.5,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  transactions: {
    transactions: [
      {
        accountId: '12345678',
        id: 'AAAA1111-0000-4000-8000-000000000001',
        date: '2026-03-01',
        type: 'Achat',
        description: 'Achat 10 Exemple Monde UCITS ETF@100,50 EUR (FR0000000001)',
        product: 'Exemple Monde UCITS ETF',
        isin: 'FR0000000001',
        quantity: 10,
        price: 100.5,
        amount: -1005,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
      },
      // Ligne volontairement inexploitable : elle doit être ignorée, pas devinée.
      { accountId: '12345678', id: 'BAD', date: '31-02-2026', amount: 0 },
    ],
    cursor: 'curseur-1',
  },
  income: {
    income: [
      {
        accountId: '12345678-cash',
        id: 'DIV-1',
        date: '2026-03-10',
        type: 'Dividende',
        description: 'Dividende Exemple Monde',
        amount: 12.5,
        currency: 'EUR',
        withholdingTax: 2.5,
      },
    ],
  },
};

function successHandler(request: SidecarRequest): SidecarResponse {
  const data = SUCCESS_DATA[request.operation];
  if (data === undefined) return { ok: false, code: 'NOT_SUPPORTED', message: `inconnu: ${request.operation}` };
  return { ok: true, data };
}

test('degiro API : succès complet — normalisation comptes / soldes / positions / transactions / revenus', async () => {
  const { transport, calls } = fakeTransport(successHandler);
  const ctx = ctxWithSidecar(transport, { degiro_username: 'u', degiro_password: 'p' });

  const accounts = await degiroConnector.syncAccounts(ctx);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.externalAccountId, 'degiro-12345678');
  assert.equal(accounts[0]?.type, 'SECURITIES');
  assert.equal(accounts[1]?.type, 'CASH');
  assert.equal(accounts[1]?.balance, 812.34);
  assert.equal(accounts[0]?.rawSourceType, 'degiro.api');

  const balances = await degiroConnector.syncBalances(ctx, accounts);
  assert.equal(balances.length, 1);
  assert.deepEqual(balances[0], {
    externalAccountId: 'degiro-12345678-cash',
    date: '2026-04-15',
    cash: 812.34,
    currency: 'EUR',
    rawSourceType: 'degiro.api',
  });

  const positions = await degiroConnector.syncPositions(ctx, accounts);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.isin, 'FR0000000001');
  assert.equal(positions[0]?.externalAssetId, 'FR0000000001');
  assert.equal(positions[0]?.kind, 'ETF');
  assert.equal(positions[0]?.quantity, 10);
  assert.equal(positions[0]?.unitPrice, 100.5);

  const transactions = await degiroConnector.syncTransactions(ctx, { since: '2026-01-01' });
  assert.equal(transactions.items.length, 1, 'la ligne sans date exploitable est ignorée');
  assert.equal(transactions.cursor.value, 'curseur-1');
  const buy = transactions.items[0];
  assert.equal(buy?.type, 'BUY');
  assert.equal(buy?.amount, -1005);
  assert.equal(buy?.quantity, 10);
  assert.equal(buy?.unitPrice, 100.5);
  assert.equal(buy?.externalTransactionId, 'AAAA1111-0000-4000-8000-000000000001');
  assert.equal(buy?.externalAccountId, 'degiro-12345678');

  const income = await degiroConnector.syncIncome(ctx, { since: '2026-01-01' });
  assert.equal(income.length, 1);
  assert.equal(income[0]?.type, 'DIVIDEND');
  assert.equal(income[0]?.amount, 12.5);
  assert.equal(income[0]?.withholdingTax, 2.5);

  assert.deepEqual(
    calls.map((call) => call.operation),
    ['accounts', 'balances', 'positions', 'transactions', 'income'],
  );
  // Les identifiants sont transmis DANS la requête, jamais ailleurs.
  assert.equal(calls[0]?.secrets?.username, 'u');
  assert.equal(calls[0]?.secrets?.password, 'p');
  // La fenêtre incrémentale est bien transmise.
  assert.equal((calls[3]?.params as Record<string, unknown>).since, '2026-01-01');
});

test('degiro API : MFA_REQUIRED puis reprise au second appel', async () => {
  let attempt = 0;
  const { transport } = fakeTransport(() => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        code: 'MFA_REQUIRED',
        message: "Validation requise dans l'application DEGIRO : approuvez puis relancez.",
        requiresUserAction: true,
      };
    }
    return { ok: true, data: SUCCESS_DATA.accounts };
  });
  const ctx = ctxWithSidecar(transport);

  const first = await degiroConnector.testConnection(ctx);
  assert.equal(first.ok, false);
  assert.equal(first.status, 'AUTH_REQUIRED');
  assert.equal(first.requiresUserAction, true);
  assert.match(first.message, /application DEGIRO/);

  const second = await degiroConnector.testConnection(ctx);
  assert.equal(second.ok, true);
  assert.equal(second.status, 'CONNECTED');

  // Le même code, levé pendant une synchronisation, devient une ConnectorError.
  const mfa = fakeTransport(() => ({
    ok: false,
    code: 'MFA_REQUIRED',
    message: 'validation requise',
    requiresUserAction: true,
  }));
  await assert.rejects(
    degiroConnector.syncAccounts(ctxWithSidecar(mfa.transport)),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.kind === 'MFA_REQUIRED' &&
      error.requiresUserAction === true &&
      error.status === 'AUTH_REQUIRED',
  );
});

test('degiro API : SESSION_EXPIRED et RATE_LIMITED sont traduits fidèlement', async () => {
  const expired = fakeTransport(() => ({
    ok: false,
    code: 'SESSION_EXPIRED',
    message: 'Session DEGIRO invalide ou expirée : reconnectez-vous.',
  }));
  await assert.rejects(
    degiroConnector.syncTransactions(ctxWithSidecar(expired.transport), {}),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'SESSION_EXPIRED',
  );

  const limited = fakeTransport(() => ({
    ok: false,
    code: 'RATE_LIMITED',
    message: 'DEGIRO limite temporairement les accès (HTTP 429).',
  }));
  await assert.rejects(
    degiroConnector.syncBalances(ctxWithSidecar(limited.transport), []),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'RATE_LIMITED',
  );

  const down = fakeTransport(() => ({
    ok: false,
    code: 'PROVIDER_DOWN',
    message: 'Service DEGIRO injoignable.',
  }));
  await assert.rejects(
    degiroConnector.syncIncome(ctxWithSidecar(down.transport), {}),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'PROVIDER_DOWN',
  );
});

test('degiro API : réponse de données mal formée => DATA (rien n\'est deviné)', async () => {
  const malformed = fakeTransport(() => ({ ok: true, data: { unexpected: [] } }));
  await assert.rejects(
    degiroConnector.syncPositions(ctxWithSidecar(malformed.transport), []),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'DATA',
  );
});

test('degiro API : sans sidecar, NOT_SUPPORTED avec message actionnable et CSV intact', async () => {
  const { ctx } = makeTestContext();
  assert.equal(degiroConnector.capabilities.api, false);
  await assert.rejects(
    degiroConnector.syncAccounts(ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.kind === 'NOT_SUPPORTED' &&
      /import de fichier/.test(error.message) &&
      /SUIVIINVEST_SIDECAR_DEGIRO/.test(error.message),
  );
  // Le format CSV reste déclaré et opérationnel.
  assert.equal(degiroConnector.importFormats.length, 1);
  assert.equal(degiroConnector.importFormats[0]?.id, 'degiro-account-csv');
});

test('degiro API : un sidecar présent mais indisponible ne fait pas croire à une API', async () => {
  const { transport, calls } = fakeTransport(
    () => ({ ok: true, data: SUCCESS_DATA.accounts }),
    { available: false },
  );
  const ctx = ctxWithSidecar(transport);
  await assert.rejects(
    degiroConnector.syncAccounts(ctx),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'NOT_SUPPORTED',
  );
  assert.equal(calls.length, 0, 'aucun appel n\'a été émis vers un sidecar indisponible');
  assert.equal(degiroConnector.capabilities.api, false);
});

test('degiro API : capabilities.api ne passe à true que si un sidecar est déclaré', async (t) => {
  t.after(() => degiroConnector.configureSidecar(null));
  const { transport } = fakeTransport(successHandler);
  assert.equal(degiroConnector.capabilities.api, false);
  assert.equal(degiroConnector.capabilities.positions, false);

  degiroConnector.configureSidecar(transport);
  assert.equal(degiroConnector.capabilities.api, true);
  assert.equal(degiroConnector.capabilities.positions, true, 'l\'API fournit des positions');

  degiroConnector.configureSidecar(null);
  assert.equal(degiroConnector.capabilities.api, false);
});

test('degiro API : les avertissements du sidecar remontent sans faire échouer la synchro', async () => {
  const { transport } = fakeTransport(() => ({
    ok: true,
    data: SUCCESS_DATA.accounts,
    warnings: ['Prix de marché non récupéré'],
  }));
  const { ctx, lines } = makeTestContext();
  const withSidecar: ConnectorContext = { ...ctx, sidecars: { degiro: transport } };
  const accounts = await degiroConnector.syncAccounts(withSidecar);
  assert.equal(accounts.length, 2);
  assert.ok(
    lines.some((line) => line.level === 'warn' && line.message.includes('Prix de marché non récupéré')),
    'l\'avertissement du sidecar doit être journalisé',
  );
});
