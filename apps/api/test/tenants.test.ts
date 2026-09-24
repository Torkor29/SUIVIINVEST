import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { authRequest, createTestApp, extractCookie, login, type TestContext } from './helpers.ts';

/**
 * Inscription libre et espaces séparés : une personne qui s'inscrit ne voit
 * AUCUNE donnée des autres, même en devinant un identifiant.
 */

async function register(ctx: TestContext, email: string, password = 'Mot-De-Passe-Inscrit-2026') {
  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password, displayName: email.split('@')[0] },
  });
  return response;
}

function sessionOf(response: { headers: Record<string, unknown>; json: () => unknown }): { cookie: string; csrfToken: string } {
  return {
    cookie: extractCookie(response.headers['set-cookie'] as string | string[] | undefined),
    csrfToken: (response.json() as { csrfToken: string }).csrfToken,
  };
}

test('une personne inscrite a son propre espace, vide, et ne peut rien atteindre de celui du propriétaire', async () => {
  const ctx = await createTestApp();
  try {
    const owner = await login(ctx);
    // Données du propriétaire : un investissement, une connexion, un compte bancaire saisi.
    const asset = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'manual', name: 'Obligation du propriétaire', kind: 'BOND', price: 100, priceDate: '2026-01-02' },
    });
    const ownerAsset = (asset.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    const buy = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/holdings/operations',
      payload: { instrumentId: ownerAsset, type: 'BUY', date: '2026-01-02', quantity: 10 },
    });
    const ownerOperation = (buy.json() as { id: string }).id;
    const connection = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/connections',
      payload: { providerId: 'metamask', label: 'Wallet du propriétaire', config: { address: '0x1111111111111111111111111111111111111111' }, secrets: {} },
    });
    const ownerConnection = (connection.json() as { id: string }).id;
    const ownerAccounts = (await authRequest(ctx, owner, { method: 'GET', url: '/api/accounts' })).json() as { accounts: { id: string }[] };
    assert.ok(ownerAccounts.accounts.length > 0);
    const ownerId = ((await authRequest(ctx, owner, { method: 'GET', url: '/api/auth/me' })).json() as { id: string }).id;

    // Inscription libre.
    const registered = await register(ctx, 'camille@exemple.fr');
    assert.equal(registered.statusCode, 201, registered.body);
    const body = registered.json() as { recoveryCode: string; role: string; admin: boolean };
    assert.match(body.recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
    assert.deepEqual([body.role, body.admin], ['OWNER', false]);
    const guest = sessionOf(registered);
    const guestId = ((await authRequest(ctx, guest, { method: 'GET', url: '/api/auth/me' })).json() as { id: string }).id;

    // Tout est vide de son côté.
    const empty: [string, (json: unknown) => number][] = [
      ['/api/holdings', (json) => (json as { positions: unknown[] }).positions.length],
      ['/api/accounts', (json) => (json as { accounts: unknown[] }).accounts.length],
      ['/api/connections', (json) => (json as { connections: unknown[] }).connections.length],
      ['/api/transactions', (json) => (json as { items: unknown[] }).items.length],
      ['/api/holdings/plans', (json) => (json as unknown[]).length],
      ['/api/imports', (json) => (json as unknown[]).length],
      ['/api/sync-runs', (json) => (json as unknown[]).length],
      ['/api/wallets', (json) => (json as unknown[]).length],
    ];
    for (const [url, count] of empty) {
      const response = await authRequest(ctx, guest, { method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} : ${response.body}`);
      assert.equal(count(response.json()), 0, `${url} doit être vide pour la personne inscrite`);
    }
    const networth = (await authRequest(ctx, guest, { method: 'GET', url: '/api/networth' })).json() as { total: number };
    assert.equal(networth.total, 0);
    // Base séparée, créée à son premier accès aux données.
    assert.ok(existsSync(join(ctx.directory, 'tenants', `${guestId}.db`)), 'base séparée créée');

    // Identifiants devinés : introuvables ou refusés, jamais servis.
    assert.equal((await authRequest(ctx, guest, { method: 'GET', url: `/api/holdings/assets/${ownerAsset}` })).statusCode, 404);
    assert.equal((await authRequest(ctx, guest, { method: 'DELETE', url: `/api/holdings/operations/${ownerOperation}` })).statusCode, 404);
    assert.equal((await authRequest(ctx, guest, { method: 'DELETE', url: `/api/connections/${ownerConnection}` })).statusCode, 404);
    assert.equal((await authRequest(ctx, guest, { method: 'POST', url: `/api/connections/${ownerConnection}/sync` })).statusCode, 404);
    assert.equal((await authRequest(ctx, guest, { method: 'PATCH', url: `/api/auth/accounts/${ownerId}`, payload: { disabled: true } })).statusCode, 404);
    assert.equal((await authRequest(ctx, guest, { method: 'POST', url: `/api/auth/accounts/${ownerId}/recovery` })).statusCode, 404);
    const guestAccounts = (await authRequest(ctx, guest, { method: 'GET', url: '/api/auth/accounts' })).json() as { accounts: { id: string }[] };
    assert.deepEqual(guestAccounts.accounts.map((account) => account.id), [guestId]);

    // Ses propres données restent chez lui ; le propriétaire ne les voit pas non plus.
    await authRequest(ctx, guest, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'manual', name: 'Livret de Camille', kind: 'OTHER', price: 1, priceDate: '2026-01-02' },
    });
    const ownerView = (await authRequest(ctx, owner, { method: 'GET', url: '/api/holdings' })).json() as { positions: { name: string }[] };
    assert.deepEqual(ownerView.positions.map((position) => position.name), ['Obligation du propriétaire']);

    // Réservé à l'administrateur de l'installation.
    assert.equal((await authRequest(ctx, guest, { method: 'PUT', url: '/api/auth/registration', payload: { open: false } })).statusCode, 403);

    // Un membre invité par la personne inscrite partage SON espace (pas celui du propriétaire).
    const member = await authRequest(ctx, guest, {
      method: 'POST',
      url: '/api/auth/accounts',
      payload: { username: 'conjoint', password: 'Mot-De-Passe-Membre-2026', ownerUsername: 'camille' },
    });
    assert.equal(member.statusCode, 201, member.body);
    const memberLogin = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'conjoint', password: 'Mot-De-Passe-Membre-2026' } });
    const memberSession = sessionOf(memberLogin);
    const memberView = (await authRequest(ctx, memberSession, { method: 'GET', url: '/api/holdings/plans' })).json() as unknown[];
    assert.equal(memberView.length, 0);
    const memberAssets = (await authRequest(ctx, memberSession, { method: 'GET', url: `/api/holdings/assets/${ownerAsset}` })).statusCode;
    assert.equal(memberAssets, 404, 'le membre de la personne inscrite ne voit pas le propriétaire');
  } finally {
    await ctx.cleanup();
  }
});

test('inscription : adresse déjà utilisée refusée, fermeture par l’administrateur, pas avant le premier compte', async () => {
  const ctx = await createTestApp();
  try {
    assert.equal((await register(ctx, 'avant@exemple.fr')).statusCode, 409, 'le premier compte passe par la création du propriétaire');
    const owner = await login(ctx);
    assert.equal((await register(ctx, 'dupont@exemple.fr')).statusCode, 201);
    assert.equal((await register(ctx, 'DUPONT@exemple.fr')).statusCode, 409);
    assert.equal((await register(ctx, 'court@exemple.fr', 'court')).statusCode, 400);

    const closed = await authRequest(ctx, owner, { method: 'PUT', url: '/api/auth/registration', payload: { open: false } });
    assert.equal((closed.json() as { registrationOpen: boolean }).registrationOpen, false);
    assert.equal((await register(ctx, 'tard@exemple.fr')).statusCode, 403);
    const session = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' })).json() as { registrationOpen: boolean };
    assert.equal(session.registrationOpen, false);

    // La personne inscrite se reconnecte avec son adresse e-mail.
    const relog = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'dupont@exemple.fr', password: 'Mot-De-Passe-Inscrit-2026' } });
    assert.equal(relog.statusCode, 200, relog.body);
  } finally {
    await ctx.cleanup();
  }
});
