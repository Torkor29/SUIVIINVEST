import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestApp, login } from './helpers.ts';

/**
 * Tests de bout en bout de l'API HTTP (via `app.inject`, aucun port ouvert).
 * Ils vérifient le parcours réel : configuration initiale, session, CSRF, CRUD.
 */

test('parcours complet : configuration, session, écriture protégée par CSRF', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());

  // 1. /health accessible sans authentification
  const health = await ctx.app.app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  const healthBody = health.json() as { status: string; database: { ok: boolean; migrations: number } };
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.database.ok, true);
  assert.ok(healthBody.database.migrations >= 3);

  // 2. aucune session : l'API refuse
  const beforeSetup = await ctx.app.app.inject({ method: 'GET', url: '/api/networth' });
  assert.equal(beforeSetup.statusCode, 401);
  assert.equal((beforeSetup.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');

  const sessionInfo = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.deepEqual(sessionInfo.json(), {
    authenticated: false,
    csrfToken: null,
    needsSetup: true,
    username: null,
    role: null,
    accountsCount: 0,
    usernameRequired: false,
  });

  // 3. configuration initiale : mot de passe trop faible refusé
  const weak = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'court' },
  });
  assert.equal(weak.statusCode, 400);

  const session = await login(ctx);
  assert.ok(session.cookie.startsWith('suiviinvest_session='));
  assert.ok(session.csrfToken.length > 10);

  // 4. session authentifiée
  const afterSetup = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie: session.cookie },
  });
  const afterBody = afterSetup.json() as { authenticated: boolean; needsSetup: boolean };
  assert.equal(afterBody.authenticated, true);
  assert.equal(afterBody.needsSetup, false);

  // 5. écriture sans jeton CSRF : refusée
  const withoutCsrf = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie: session.cookie },
    payload: { name: 'PEA', type: 'SECURITIES', providerId: 'credit_agricole', currency: 'EUR' },
  });
  assert.equal(withoutCsrf.statusCode, 403);
  assert.equal((withoutCsrf.json() as { error: { code: string } }).error.code, 'FORBIDDEN');

  // 6. écriture avec CSRF : acceptée
  const created = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: 'PEA', type: 'SECURITIES', providerId: 'credit_agricole', currency: 'EUR' },
  });
  assert.equal(created.statusCode, 201);
  const account = created.json() as { id: string; name: string; type: string };
  assert.equal(account.name, 'PEA');

  // 7. lecture : le compte apparaît dans la synthèse
  const accounts = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/accounts',
    headers: { cookie: session.cookie },
  });
  assert.equal(accounts.statusCode, 200);
  const accountsBody = accounts.json() as { accounts: { id: string }[] };
  assert.equal(accountsBody.accounts.length, 1);

  // 8. modification puis suppression
  const patched = await ctx.app.app.inject({
    method: 'PATCH',
    url: `/api/accounts/${account.id}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: 'PEA Crédit Agricole' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.json() as { name: string }).name, 'PEA Crédit Agricole');

  const deleted = await ctx.app.app.inject({
    method: 'DELETE',
    url: `/api/accounts/${account.id}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
  });
  assert.equal(deleted.statusCode, 204);

  // 9. déconnexion : la session ne vaut plus rien
  const logout = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: session.cookie },
  });
  assert.equal(logout.statusCode, 200);
  const afterLogout = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth',
    headers: { cookie: session.cookie },
  });
  assert.equal(afterLogout.statusCode, 401);
});

test('le mot de passe n\'est jamais stocké en clair et la connexion échoue sans le bon', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await login(ctx, 'mot-de-passe-solide');

  const stored = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users LIMIT 1');
  assert.ok(stored);
  assert.ok(stored.password_hash.startsWith('$argon2id$'), 'le hachage doit être de l\'Argon2id');
  assert.ok(!stored.password_hash.includes('mot-de-passe-solide'));

  const bad = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'mauvais-mot-de-passe' },
  });
  assert.equal(bad.statusCode, 401);

  const good = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'mot-de-passe-solide' },
  });
  assert.equal(good.statusCode, 200);
});

test('une seconde configuration initiale est refusée', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  await login(ctx, 'mot-de-passe-solide');
  const again = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'un-autre-mot-de-passe' },
  });
  assert.equal(again.statusCode, 409);
});

test('les réponses d\'erreur ne divulguent rien d\'interne', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  const notFound = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/inexistant',
    headers: { cookie: session.cookie },
  });
  assert.equal(notFound.statusCode, 404);
  const body = notFound.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(!body.error.message.includes('.ts'), 'aucun chemin de fichier ne doit apparaître');

  const invalid = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: '', type: 'INVALIDE', providerId: 'nope', currency: 'EUROS' },
  });
  assert.equal(invalid.statusCode, 400);
});

test('une origine tierce est refusée (CORS restrictif)', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);
  const crossOrigin = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/accounts',
    headers: { cookie: session.cookie, origin: 'https://site-malveillant.example' },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal((crossOrigin.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
});

test('les connexions refusent tout champ de type seed ou clé privée', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  const rejected = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: {
      providerId: 'metamask',
      label: 'Wallet principal',
      config: { address: '0xabc', seedPhrase: 'oups' },
      secrets: {},
    },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match((rejected.json() as { error: { message: string } }).error.message, /seedPhrase/);

  // Une adresse publique seule est acceptée : aucun secret n'est requis.
  const accepted = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/connections',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: {
      providerId: 'metamask',
      label: 'Wallet principal',
      config: { address: '0x0000000000000000000000000000000000000001' },
      secrets: {},
    },
  });
  assert.equal(accepted.statusCode, 201);

  // Les colonnes de secret ne peuvent pas contenir une seed : le schéma ne
  // prévoit aucun champ pour cela, et le test le prouve dans la base.
  const columns = ctx.db.all<{ name: string }>("SELECT name FROM pragma_table_info('secrets')");
  assert.deepEqual(
    columns.map((column) => column.name).sort(),
    ['ciphertext', 'created_at', 'iv', 'name', 'tag', 'updated_at'],
  );
});