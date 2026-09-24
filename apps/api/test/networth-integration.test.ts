import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTestApp,
  createTestConnector,
  login,
  seedAccount,
  seedActivity,
  seedInstrument,
  seedQuote,
  type TestContext,
  inMainSpace,
} from './helpers.ts';

/**
 * Tests de contrat et de cohérence du patrimoine global.
 *
 * Ils couvrent deux exigences de la Mission 2 :
 *  - aucun DTO ne doit contenir de clé `snake_case` (fuite de colonne SQL) ;
 *  - le patrimoine net doit agréger toutes les sources, dettes incluses, sans
 *    qu'un transfert entre mes propres comptes ne crée de performance.
 */

/** Détecte récursivement une clé en snake_case dans une réponse JSON. */
function findSnakeCaseKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSnakeCaseKeys(item, `${path}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(key)) found.push(`${path}.${key}`);
    found.push(...findSnakeCaseKeys(item, `${path}.${key}`));
  }
  return found;
}

async function seedWealth(ctx: TestContext): Promise<void> {
  // CA Bourse : 25 000 € (PEA)
  const ca = seedAccount(ctx.db, { name: 'PEA', type: 'SECURITIES', providerId: 'credit_agricole' });
  const pea = seedInstrument(ctx.db, { name: 'ETF Monde', isin: 'FR0000000003', symbol: 'CW8' });
  seedActivity(ctx.db, { accountId: ca, instrumentId: pea, type: 'BUY', date: '2025-01-10', quantity: 40, unitPrice: 500, amount: -20000 });
  seedQuote(ctx.db, pea, new Date().toISOString().slice(0, 10), 625);

  // DEGIRO : 12 000 €
  const degiro = seedAccount(ctx.db, { name: 'DEGIRO', type: 'SECURITIES', providerId: 'degiro' });
  const tte = seedInstrument(ctx.db, { name: 'TotalEnergies', isin: 'FR0000120271', symbol: 'TTE' });
  seedActivity(ctx.db, { accountId: degiro, instrumentId: tte, type: 'BUY', date: '2025-02-10', quantity: 200, unitPrice: 50, amount: -10000 });
  seedQuote(ctx.db, tte, new Date().toISOString().slice(0, 10), 60);

  // Trade Republic : 8 000 €
  const tr = seedAccount(ctx.db, { name: 'Trade Republic', type: 'SECURITIES', providerId: 'trade_republic' });
  const sap = seedInstrument(ctx.db, { name: 'ETF S&P 500', isin: 'IE0000000004', symbol: 'VUSA' });
  seedActivity(ctx.db, { accountId: tr, instrumentId: sap, type: 'BUY', date: '2025-03-10', quantity: 100, unitPrice: 70, amount: -7000 });
  seedQuote(ctx.db, sap, new Date().toISOString().slice(0, 10), 80);

  // MetaMask : 15 000 €
  const wallet = seedAccount(ctx.db, { name: 'Wallet EVM', type: 'CRYPTO', providerId: 'metamask' });
  const eth = seedInstrument(ctx.db, { name: 'Ether', symbol: 'ETH', kind: 'CRYPTO', currency: 'EUR' });
  seedActivity(ctx.db, { accountId: wallet, instrumentId: eth, type: 'CRYPTO_TRANSFER', date: '2025-04-01', quantity: 5, unitPrice: 3000, amount: 15000 });
  seedQuote(ctx.db, eth, new Date().toISOString().slice(0, 10), 3000);

  // Revolut : 5 000 € de liquidités
  const revolut = seedAccount(ctx.db, { name: 'Revolut', type: 'CASH', providerId: 'revolut' });
  seedActivity(ctx.db, { accountId: revolut, type: 'DEPOSIT', date: '2025-01-01', amount: 5000 });

  // Immobilier : 300 000 € brut, crédit de 180 000 € restant
  const property = seedAccount(ctx.db, { name: 'Appartement', type: 'REAL_ESTATE' });
  ctx.db.run(
    `INSERT INTO properties (account_id, name, kind, purchase_price, current_value, updated_at)
     VALUES (?, 'Appartement Lyon', 'APPARTEMENT', 250000, 300000, ?)`,
    property,
    new Date().toISOString(),
  );
  ctx.db.run(
    `INSERT INTO property_loans (account_id, loan_type, principal, remaining_principal, annual_rate,
       months, start_date, monthly_payment, insurance_monthly)
     VALUES (?, 'AMORTIZABLE', 200000, 180000, 3.2, 300, '2020-01-01', 0, 0)`,
    property,
  );
}

test('le patrimoine net agrège toutes les sources et déduit les dettes', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await seedWealth(ctx);
  const session = await login(ctx);

  const response = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth?period=MAX',
    headers: { cookie: session.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    total: number;
    byProvider: { key: string; value: number }[];
    byClass: { key: string; value: number }[];
    historySource: string;
    recordedSince: string | null;
  };

  const byProvider = Object.fromEntries(body.byProvider.map((slice) => [slice.key, slice.value]));
  assert.equal(byProvider.credit_agricole, 25000);
  assert.equal(byProvider.degiro, 12000);
  assert.equal(byProvider.trade_republic, 8000);
  assert.equal(byProvider.metamask, 15000);
  assert.equal(byProvider.revolut, 5000);
  // Le fournisseur « manual » porte l'immobilier ET sa dette, donc net.
  assert.equal(byProvider.manual, 300000 - 180000);

  const byClass = Object.fromEntries(body.byClass.map((slice) => [slice.key, slice.value]));
  assert.equal(byClass.REAL_ESTATE, 300000);
  assert.equal(byClass.LIABILITIES, -180000);
  assert.equal(body.total, 25000 + 12000 + 8000 + 15000 + 5000 + 300000 - 180000);

  // L'historique mêle reconstitution (passé, depuis les activités) et relevé du
  // jour enregistré par l'application : la provenance doit le dire honnêtement,
  // et ne jamais se présenter comme intégralement observée.
  assert.ok(['RECONSTRUCTED', 'MIXED'].includes(body.historySource), `provenance: ${body.historySource}`);
});

test('un transfert entre mes comptes ne crée ni performance ni revenu', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const revolut = seedAccount(ctx.db, { name: 'Revolut', type: 'CASH', providerId: 'revolut', initialBalance: 10000 });
  const degiro = seedAccount(ctx.db, { name: 'DEGIRO', type: 'CASH', providerId: 'degiro' });
  const session = await login(ctx);

  const before = (
    await ctx.app.app.inject({ method: 'GET', url: '/api/networth?period=MAX', headers: { cookie: session.cookie } })
  ).json() as { total: number };

  // 2 000 € transférés de Revolut vers DEGIRO.
  seedActivity(ctx.db, { accountId: revolut, type: 'TRANSFER_OUT', date: '2026-08-01', amount: -2000, providerId: 'revolut' });
  seedActivity(ctx.db, { accountId: degiro, type: 'TRANSFER_IN', date: '2026-08-01', amount: 2000, providerId: 'degiro' });

  const after = (
    await ctx.app.app.inject({ method: 'GET', url: '/api/networth?period=MAX', headers: { cookie: session.cookie } })
  ).json() as { total: number; byProvider: { key: string; value: number }[] };

  assert.equal(after.total, before.total, 'le transfert est neutre pour le patrimoine');
  const byProvider = Object.fromEntries(after.byProvider.map((slice) => [slice.key, slice.value]));
  assert.equal(byProvider.revolut, 8000);
  assert.equal(byProvider.degiro, 2000);
});

test('les relevés quotidiens sont enregistrés et distingués de la reconstitution', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await seedWealth(ctx);
  const session = await login(ctx);

  // Un relevé est enregistré (comme le ferait l'ordonnanceur).
  const recorded = inMainSpace(ctx, () => ctx.app.portfolio.recordDailySnapshot());
  assert.ok(recorded.accounts >= 6, 'le relevé détaille chaque compte');

  const stored = ctx.db.get<{ source: string; liabilities: number; positions_count: number }>(
    'SELECT source, liabilities, positions_count FROM net_worth_snapshots ORDER BY date DESC LIMIT 1',
  );
  assert.equal(stored?.source, 'RECORDED');
  assert.equal(stored?.liabilities, 180000, 'les dettes sont stockées séparément');
  assert.ok((stored?.positions_count ?? 0) > 0);

  const perAccount = ctx.db.all<{ asset_class: string; value_base: number }>(
    'SELECT asset_class, value_base FROM net_worth_snapshot_accounts',
  );
  assert.ok(perAccount.some((line) => line.asset_class === 'LIABILITIES' && line.value_base < 0));
  assert.ok(perAccount.some((line) => line.asset_class === 'REAL_ESTATE' && line.value_base === 300000));

  const response = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth?period=MAX',
    headers: { cookie: session.cookie },
  });
  const body = response.json() as { historySource: string; recordedSince: string | null };
  assert.notEqual(body.historySource, 'RECONSTRUCTED', 'un relevé enregistré change la provenance');
  assert.ok(body.recordedSince, 'la date du premier relevé est exposée');
});

test('aucune réponse de l\'API n\'expose de clé snake_case', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await seedWealth(ctx);
  const session = await login(ctx);

  // Une connexion + un compte sont créés pour couvrir les DTO d'écriture.
  await ctx.app.app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { providerId: 'metamask', label: 'Wallet test', config: { address: '0x1111111111111111111111111111111111111111' }, secrets: {} },
  });
  const created = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: 'Compte test', type: 'CASH', providerId: 'manual', currency: 'EUR' },
  });
  assert.equal(created.statusCode, 201);
  const account = created.json() as Record<string, unknown>;
  assert.deepEqual(findSnakeCaseKeys(account), [], 'le DTO de compte doit être en camelCase');
  assert.ok(typeof account.providerId === 'string');
  assert.ok(!('provider_id' in account));

  const patched = await ctx.app.app.inject({
    method: 'PATCH',
    url: `/api/accounts/${String(account.id)}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: 'Compte renommé' },
  });
  assert.deepEqual(findSnakeCaseKeys(patched.json()), []);

  for (const url of [
    '/api/accounts',
    '/api/networth?period=MAX',
    '/api/investments',
    '/api/crypto',
    '/api/real-estate',
    '/api/transactions?limit=5',
    '/api/income?period=MAX',
    '/api/analytics?period=MAX',
    '/api/connections',
    '/api/sync-runs',
    '/api/imports',
    '/api/settings',
    '/api/accounts/overview',
    '/api/audit?limit=5',
    '/api/backup/list',
    '/health',
  ]) {
    const response = await ctx.app.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
    assert.ok(response.statusCode < 400, `${url} doit répondre (reçu ${response.statusCode})`);
    const leaks = findSnakeCaseKeys(response.json());
    assert.deepEqual(leaks, [], `${url} expose des clés snake_case : ${leaks.join(', ')}`);
  }
});

test('la synchronisation globale renvoie un résultat exploitable par l\'interface', async (t) => {
  const working = createTestConnector({
    id: 'degiro',
    displayName: 'DEGIRO',
    accounts: [{ externalAccountId: 'D1', name: 'DEGIRO', type: 'SECURITIES', currency: 'EUR' }],
    transactions: [
      {
        externalAccountId: 'D1',
        externalTransactionId: 'TX-1',
        externalAssetId: null,
        date: '2026-09-01',
        type: 'DEPOSIT',
        description: 'Dépôt',
        quantity: null,
        unitPrice: null,
        amount: 1000,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
        rawSourceType: 'TEST',
      },
    ],
  });
  const ctx = await createTestApp({ connectors: [working] });
  t.after(() => ctx.cleanup());
  ctx.db.run(
    `INSERT INTO connections (id, provider_id, label, created_at, updated_at)
     VALUES ('c1','degiro','DEGIRO','2026-01-01','2026-01-01')`,
  );
  const session = await login(ctx);

  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/connections/sync-all',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    results: { providerId: string; status: string; created: number; errorCode: string | null; durationMs: number }[];
    summary: { total: number; succeeded: number; created: number };
  };
  assert.equal(body.results.length, 1);
  const result = body.results[0];
  assert.equal(result?.providerId, 'degiro');
  assert.equal(result?.status, 'SUCCESS');
  assert.equal(result?.created, 1);
  assert.equal(result?.errorCode, null);
  assert.ok((result?.durationMs ?? -1) >= 0);
  assert.equal(body.summary.succeeded, 1);
  assert.equal(body.summary.created, 1);

  // Deuxième exécution : aucun doublon créé (compteur `skipped`).
  const second = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/connections/sync-all',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
  });
  const secondBody = second.json() as { results: { created: number; skipped: number }[] };
  assert.equal(secondBody.results[0]?.created, 0);
  assert.equal(secondBody.results[0]?.skipped, 1);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 1);
});