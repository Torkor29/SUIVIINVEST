import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { FakeHttpClient } from '@suiviinvest/connectors';
import { authRequest, createTestApp, extractCookie, login } from './helpers.ts';

/**
 * Parcours bancaire complet via Enable Banking, côté API : configuration de
 * l'application, choix de la banque, retour d'autorisation, première synchro,
 * puis patrimoine alimenté. Toutes les réponses d'Enable Banking sont simulées.
 */

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_ID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

function json(body: unknown) {
  return { status: 200, headers: {}, text: JSON.stringify(body) };
}

function fakeEnableBanking(): FakeHttpClient {
  return new FakeHttpClient([
    { match: /\/aspsps\?country=FR/, respond: { aspsps: [{ name: 'Revolut', country: 'FR' }, { name: 'Crédit Agricole', country: 'FR', maximum_consent_validity: 7_776_000 }] } },
    { match: /api\.enablebanking\.com\/auth$/, respond: { url: 'https://banque.exemple/consentement?id=42' } },
    {
      match: /api\.enablebanking\.com\/sessions$/,
      respond: json({ session_id: 'session-ca', accounts: [{ uid: 'uid-1' }], access: { valid_until: '2026-12-22T00:00:00Z' } }),
    },
    {
      match: /\/sessions\/session-ca$/,
      respond: json({ status: 'AUTHORIZED', accounts: ['uid-1'], accounts_data: [{ uid: 'uid-1', identification_hash: 'h1' }] }),
    },
    { match: /\/accounts\/uid-1\/details/, respond: { account_id: { iban: 'FR7630006000011234567890189' }, name: 'Compte de dépôt', currency: 'EUR' } },
    { match: /\/accounts\/uid-1\/balances/, respond: { balances: [{ balance_amount: { amount: '2345.67', currency: 'EUR' }, balance_type: 'CLBD' }] } },
    {
      match: /\/accounts\/uid-1\/transactions/,
      respond: {
        transactions: [
          { entry_reference: 'e1', transaction_amount: { amount: '2000', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'BOOK', booking_date: '2026-09-01', debtor: { name: 'Employeur' } },
          { entry_reference: 'e2', transaction_amount: { amount: '54.30', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-09-05', remittance_information: ['CB SUPERMARCHE'] },
        ],
      },
    },
  ]);
}

test('Enable Banking : de la configuration à la première synchronisation', async () => {
  const http = fakeEnableBanking();
  const ctx = await createTestApp({ connectorHttp: http, env: { SUIVIINVEST_PUBLIC_URL: 'https://patrimoine.exemple.fr' } });
  try {
    const session = await login(ctx);

    const status = await authRequest(ctx, session, { method: 'GET', url: '/api/enable-banking/status' });
    assert.deepEqual(status.json(), {
      configured: false,
      applicationId: null,
      redirectUrl: 'https://patrimoine.exemple.fr/connexions/banque',
      canManage: true,
    });

    // Clé illisible : refusée avant d'être enregistrée.
    const bad = await authRequest(ctx, session, {
      method: 'PUT',
      url: '/api/enable-banking/app',
      payload: { applicationId: APP_ID, privateKey: 'x'.repeat(200) },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /illisible/);

    const saved = await authRequest(ctx, session, {
      method: 'PUT',
      url: '/api/enable-banking/app',
      payload: { applicationId: APP_ID, privateKey: PEM },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    // La clé privée n'est jamais renvoyée.
    assert.equal(saved.body.includes('PRIVATE KEY'), false);

    const banks = await authRequest(ctx, session, { method: 'GET', url: '/api/enable-banking/aspsps?country=FR' });
    assert.deepEqual(
      (banks.json() as { aspsps: { name: string }[] }).aspsps.map((bank) => bank.name),
      ['Crédit Agricole', 'Revolut'],
    );

    const authorize = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/enable-banking/authorize',
      payload: { aspspName: 'Crédit Agricole', country: 'FR' },
    });
    assert.equal(authorize.statusCode, 200, authorize.body);
    assert.equal((authorize.json() as { url: string }).url, 'https://banque.exemple/consentement?id=42');
    const authRequestBody = JSON.parse(
      http.requests.find((request) => request.url.endsWith('/auth'))?.options.body ?? '{}',
    ) as { redirect_url: string; state: string; access: { valid_until: string }; aspsp: { name: string } };
    assert.equal(authRequestBody.redirect_url, 'https://patrimoine.exemple.fr/connexions/banque');
    assert.equal(authRequestBody.aspsp.name, 'Crédit Agricole');

    // Mauvais état : refusé (protection contre un retour forgé).
    const forged = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/enable-banking/complete',
      payload: { code: 'c', state: 'inconnu' },
    });
    assert.equal(forged.statusCode, 400);

    // Retour de la banque, collé comme adresse complète.
    const complete = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/enable-banking/complete',
      payload: { returnUrl: `https://patrimoine.exemple.fr/connexions/banque?code=code-ok&state=${authRequestBody.state}` },
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const result = complete.json() as { connectionId: string; accounts: number; sync: { status: string } };
    assert.equal(result.accounts, 1);
    assert.equal(result.sync.status, 'SUCCESS');

    // Le même état ne peut pas servir deux fois.
    const replay = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/enable-banking/complete',
      payload: { code: 'code-ok', state: authRequestBody.state },
    });
    assert.equal(replay.statusCode, 400);

    // Le compte bancaire, son solde et ses opérations sont dans le patrimoine.
    const accounts = await authRequest(ctx, session, { method: 'GET', url: '/api/accounts' });
    const bank = (accounts.json() as { accounts: { name: string; providerId: string }[] }).accounts.find(
      (account) => account.providerId === 'enable_banking',
    );
    assert.equal(bank?.name, 'Crédit Agricole · Compte de dépôt ••0189');
    const networth = await authRequest(ctx, session, { method: 'GET', url: '/api/networth' });
    assert.ok((networth.json() as { total: number }).total >= 2345.67);

    // Aucune donnée sensible en clair : ni IBAN complet, ni clé, ni session.
    const connections = await authRequest(ctx, session, { method: 'GET', url: '/api/connections' });
    for (const secret of ['FR7630006000011234567890189', 'PRIVATE KEY', 'session-ca']) {
      assert.equal(connections.body.includes(secret), false, secret);
      assert.equal(accounts.body.includes(secret), false, secret);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Enable Banking : plusieurs banques, et une banque refusée par l’utilisateur', async () => {
  const ctx = await createTestApp({ connectorHttp: fakeEnableBanking() });
  try {
    const session = await login(ctx);
    await authRequest(ctx, session, {
      method: 'PUT',
      url: '/api/enable-banking/app',
      payload: { applicationId: APP_ID, privateKey: PEM },
    });
    const refused = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/enable-banking/complete',
      payload: { returnUrl: 'https://x.exemple/connexions/banque?error=access_denied&state=s' },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /refusé/);

    // Deux connexions Enable Banking peuvent coexister (une par banque).
    for (const label of ['Banque A', 'Banque B']) {
      const created = await authRequest(ctx, session, {
        method: 'POST',
        url: '/api/connections',
        payload: { providerId: 'enable_banking', label, config: { aspsp_name: label, aspsp_country: 'FR' }, secrets: {} },
      });
      assert.equal(created.statusCode, 201, created.body);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Enable Banking : le propriétaire configure une fois, un membre relie sa banque sans rien régler', async () => {
  const ctx = await createTestApp({ connectorHttp: fakeEnableBanking() });
  try {
    const owner = await login(ctx);
    const created = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/auth/accounts',
      payload: { username: 'conjoint', password: 'Membre-Autre-Secret-2026', displayName: 'Conjoint', ownerUsername: 'proprietaire' },
    });
    assert.equal(created.statusCode, 201, created.body);

    const memberLogin = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'conjoint', password: 'Membre-Autre-Secret-2026' },
    });
    assert.equal(memberLogin.statusCode, 200, memberLogin.body);
    const member = {
      cookie: extractCookie(memberLogin.headers['set-cookie']),
      csrfToken: (memberLogin.json() as { csrfToken: string }).csrfToken,
    };

    // Avant configuration : le membre ne peut pas régler l'application commune.
    const status = (await authRequest(ctx, member, { method: 'GET', url: '/api/enable-banking/status' })).json() as {
      configured: boolean;
      canManage: boolean;
    };
    assert.deepEqual([status.configured, status.canManage], [false, false]);
    const denied = await authRequest(ctx, member, {
      method: 'PUT',
      url: '/api/enable-banking/app',
      payload: { applicationId: APP_ID, privateKey: PEM },
    });
    assert.equal(denied.statusCode, 403);

    // Le propriétaire configure une seule fois…
    const saved = await authRequest(ctx, owner, {
      method: 'PUT',
      url: '/api/enable-banking/app',
      payload: { applicationId: APP_ID, privateKey: PEM },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    // …et le membre relie directement sa banque.
    const authorize = await authRequest(ctx, member, {
      method: 'POST',
      url: '/api/enable-banking/authorize',
      payload: { aspspName: 'Crédit Agricole', country: 'FR' },
    });
    assert.equal(authorize.statusCode, 200, authorize.body);
    assert.equal((await authRequest(ctx, member, { method: 'DELETE', url: '/api/enable-banking/app' })).statusCode, 403);
  } finally {
    await ctx.cleanup();
  }
});
