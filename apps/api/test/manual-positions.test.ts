import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestApp, login, seedAccount } from './helpers.ts';

/**
 * Saisie manuelle d'une position.
 *
 * Exigence couverte : pour les sources qui ne fournissent pas les positions
 * (Crédit Agricole), l'utilisateur doit pouvoir saisir puis corriger une position
 * sans casser le calcul du PRU ni créer de doublon.
 */

const position = {
  isin: 'FR0000120271',
  symbol: 'TTE',
  name: 'TotalEnergies',
  quantity: 100,
  averageCost: 52.4,
  currency: 'EUR',
  date: '2026-01-15',
};

test('une position saisie manuellement alimente le PRU et la valorisation', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const accountId = seedAccount(ctx.db, { name: 'Compte-titres saisi', type: 'SECURITIES', providerId: 'credit_agricole' });
  const session = await login(ctx);

  const created = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { ...position, accountId },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as { activityId: string; outcome: string; costBasis: number };
  assert.equal(body.outcome, 'CREATED');
  assert.equal(body.costBasis, 5240);

  // La position apparaît dans les investissements avec le bon prix de revient.
  const investments = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/investments',
    headers: { cookie: session.cookie },
  });
  const positions = (investments.json() as {
    positions: { isin: string | null; quantity: number; averageCost: number; costBasis: number }[];
  }).positions;
  const found = positions.find((item) => item.isin === 'FR0000120271');
  assert.ok(found, 'la position saisie est visible');
  assert.equal(found.quantity, 100);
  assert.equal(found.averageCost, 52.4);
  assert.equal(found.costBasis, 5240);

  // Elle entre aussi dans le patrimoine net (compte-titres).
  const netWorth = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth?period=MAX',
    headers: { cookie: session.cookie },
  });
  assert.equal((netWorth.json() as { total: number }).total, 5240);
});

test('saisir deux fois la même position met à jour au lieu de dupliquer', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const accountId = seedAccount(ctx.db, { name: 'Compte-titres', type: 'SECURITIES' });
  const session = await login(ctx);

  const first = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { ...position, accountId },
  });
  assert.equal(first.statusCode, 201);

  // Correction de la quantité et du PRU (donnée manquante corrigée par l'utilisateur).
  const corrected = await ctx.app.app.inject({
    method: 'PATCH',
    url: '/api/manual/positions',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { ...position, accountId, quantity: 120, averageCost: 50 },
  });
  assert.equal(corrected.statusCode, 200);
  assert.equal((corrected.json() as { outcome: string }).outcome, 'UPDATED');

  assert.equal(
    ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM activities WHERE raw_source_type = 'manual.position'")?.c,
    1,
    'aucun doublon créé',
  );

  const listed = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/manual/positions',
    headers: { cookie: session.cookie },
  });
  const rows = listed.json() as { quantity: number; averageCost: number; costBasis: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.quantity, 120);
  assert.equal(rows[0]?.averageCost, 50);
  assert.equal(rows[0]?.costBasis, 6000);
});

test('la saisie manuelle valide les entrées et ne devine jamais un instrument', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const accountId = seedAccount(ctx.db, { name: 'Compte', type: 'SECURITIES' });
  const session = await login(ctx);
  const headers = { cookie: session.cookie, 'x-csrf-token': session.csrfToken };

  const noIdentifier = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { accountId, quantity: 10, averageCost: 100 },
  });
  assert.equal(noIdentifier.statusCode, 400);

  const badIsin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { ...position, accountId, isin: 'PAS-UN-ISIN', symbol: null },
  });
  assert.equal(badIsin.statusCode, 400);

  const negativeQuantity = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { ...position, accountId, quantity: -5 },
  });
  assert.equal(negativeQuantity.statusCode, 400);

  const unknownAccount = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { ...position, accountId: 'compte-inexistant' },
  });
  assert.equal(unknownAccount.statusCode, 404);
});

test('une position saisie peut être supprimée, pas une position synchronisée', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const accountId = seedAccount(ctx.db, { name: 'Compte', type: 'SECURITIES' });
  const session = await login(ctx);
  const headers = { cookie: session.cookie, 'x-csrf-token': session.csrfToken };

  const created = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { ...position, accountId },
  });
  const activityId = (created.json() as { activityId: string }).activityId;

  const deleted = await ctx.app.app.inject({
    method: 'DELETE',
    url: `/api/manual/positions/${activityId}`,
    headers,
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 0);

  // Une ligne venue d'une synchronisation ne se supprime pas ici : elle doit être
  // corrigée à la source, sinon la prochaine synchro la recréerait.
  ctx.db.run(
    `INSERT INTO activities (id, account_id, type, date, amount, currency, provider_id,
       last_synced_at, dedup_hash, raw_source_type, created_at, updated_at)
     VALUES ('sync-1', ?, 'BUY', '2026-01-10', -100, 'EUR', 'degiro',
       '2026-01-10T00:00:00Z', 'hash-sync-1', 'degiro.account_csv', '2026-01-10', '2026-01-10')`,
    accountId,
  );
  const refused = await ctx.app.app.inject({
    method: 'DELETE',
    url: '/api/manual/positions/sync-1',
    headers,
  });
  assert.equal(refused.statusCode, 409);
  assert.match((refused.json() as { error: { message: string } }).error.message, /source synchronisée/);
});

test('une valorisation manuelle complète une donnée de marché manquante', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const accountId = seedAccount(ctx.db, { name: 'Compte-titres', type: 'SECURITIES' });
  const session = await login(ctx);
  const headers = { cookie: session.cookie, 'x-csrf-token': session.csrfToken };

  await ctx.app.app.inject({
    method: 'POST',
    url: '/api/manual/positions',
    headers,
    payload: { ...position, accountId },
  });

  // L'utilisateur corrige la valeur de son compte (aucun cours disponible).
  const valuation = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/valuations',
    headers,
    payload: { accountId, date: '2026-09-20', value: 6100, currency: 'EUR', note: 'Estimation manuelle' },
  });
  assert.equal(valuation.statusCode, 201);
  const stored = ctx.db.get<{ value: number; source: string }>(
    'SELECT value, source FROM valuations WHERE account_id = ? AND instrument_id IS NULL',
    accountId,
  );
  assert.equal(stored?.value, 6100);
  assert.equal(stored?.source, 'MANUAL');
});