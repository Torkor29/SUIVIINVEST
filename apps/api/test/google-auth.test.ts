import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { authRequest, createTestApp, extractCookie, login, type TestContext } from './helpers.ts';

/**
 * Connexion avec Google, côté serveur, face à un Google SIMULÉ : jetons
 * d'identité réellement signés (RS256), clés publiques, échange du code.
 */

const CLIENT_ID = 'suiviinvest-test.apps.googleusercontent.com';
const ENV = { SUIVIINVEST_GOOGLE_CLIENT_ID: CLIENT_ID, SUIVIINVEST_GOOGLE_CLIENT_SECRET: 'secret-de-test-google' };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'cle-test', alg: 'RS256', use: 'sig' };

interface Identity {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
  aud?: string;
  badSignature?: boolean;
}

function idToken(claims: Record<string, unknown>, badSignature = false): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'cle-test', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${badSignature ? signature.slice(0, -4) + 'AAAA' : signature}`;
}

/** Google simulé : l'identité renvoyée est celle du « compte Google » choisi par le test. */
function fakeGoogle(state: { identity: Identity; nonce: string | null; tokenCalls: number }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('oauth2/v3/certs')) return Response.json({ keys: [JWK] });
    if (url.includes('oauth2.googleapis.com/token')) {
      state.tokenCalls++;
      const body = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(body.get('client_id'), CLIENT_ID);
      assert.ok((body.get('code_verifier') ?? '').length >= 43, 'PKCE : code_verifier transmis');
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        id_token: idToken(
          {
            iss: 'https://accounts.google.com',
            aud: state.identity.aud ?? CLIENT_ID,
            sub: state.identity.sub,
            email: state.identity.email,
            email_verified: state.identity.email_verified ?? true,
            name: state.identity.name ?? null,
            nonce: state.nonce,
            iat: now,
            exp: now + 3600,
          },
          state.identity.badSignature,
        ),
      });
    }
    return new Response('inconnu', { status: 404 });
  }) as typeof fetch;
}

interface Flow {
  readonly location: string;
  readonly sessionCookie: string | null;
}

/** Parcours complet navigateur : départ, « choix du compte » chez Google, retour. */
async function googleFlow(
  ctx: TestContext,
  state: { identity: Identity; nonce: string | null },
  options: { mode?: 'login' | 'link'; session?: { cookie: string; csrfToken: string }; tamperBrowser?: boolean; replay?: boolean } = {},
): Promise<Flow> {
  const query = options.mode === 'link' ? `?mode=link&csrf=${encodeURIComponent(options.session?.csrfToken ?? '')}` : '';
  const start = await ctx.app.app.inject({
    method: 'GET',
    url: `/api/auth/google/start${query}`,
    headers: options.session ? { cookie: options.session.cookie } : {},
  });
  assert.equal(start.statusCode, 302, start.body);
  const location = String(start.headers.location);
  if (!location.startsWith('https://accounts.google.com/')) return { location, sessionCookie: null };
  const google = new URL(location);
  assert.equal(google.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(google.searchParams.get('redirect_uri'), 'https://patrimoine.exemple.fr/api/auth/google/callback');
  state.nonce = google.searchParams.get('nonce');
  const browser = extractCookie(start.headers['set-cookie']);
  const cookies = [options.tamperBrowser ? 'suiviinvest_oauth=autre-navigateur' : browser, options.session?.cookie].filter(Boolean).join('; ');
  const callbackUrl = `/api/auth/google/callback?code=code-google&state=${google.searchParams.get('state')}`;
  const callback = await ctx.app.app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: cookies } });
  if (options.replay) {
    const again = await ctx.app.app.inject({ method: 'GET', url: callbackUrl, headers: { cookie: cookies } });
    return { location: String(again.headers.location), sessionCookie: null };
  }
  assert.equal(callback.statusCode, 302, callback.body);
  const setCookies = ([] as string[]).concat(callback.headers['set-cookie'] ?? []);
  const session = setCookies.find((item) => item.startsWith('suiviinvest_session=') && !item.startsWith('suiviinvest_session=;'));
  return { location: String(callback.headers.location), sessionCookie: session ? (session.split(';')[0] ?? null) : null };
}

async function setupApp(identity: Identity) {
  const state = { identity, nonce: null as string | null, tokenCalls: 0 };
  const ctx = await createTestApp({
    env: { ...ENV, SUIVIINVEST_PUBLIC_URL: 'https://patrimoine.exemple.fr' },
    googleFetch: fakeGoogle(state),
  });
  return { ctx, state };
}

test('premier lancement : « Continuer avec Google » crée le propriétaire, puis le reconnecte', async () => {
  const { ctx, state } = await setupApp({ sub: 'g-owner', email: 'Julien@Exemple.fr', name: 'Julien Dolou' });
  try {
    const status = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/status' })).json() as { enabled: boolean };
    assert.equal(status.enabled, true);

    const first = await googleFlow(ctx, state);
    assert.equal(first.location, '/?google=welcome');
    assert.ok(first.sessionCookie);
    const me = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.sessionCookie } });
    const profile = me.json() as { role: string; email: string; displayName: string; googleLinked: boolean; passwordSet: boolean };
    assert.equal(profile.role, 'OWNER');
    assert.equal(profile.email, 'julien@exemple.fr');
    assert.equal(profile.displayName, 'Julien Dolou');
    assert.equal(profile.googleLinked, true);
    assert.equal(profile.passwordSet, false);

    const again = await googleFlow(ctx, state);
    assert.equal(again.location, '/');
    assert.ok(again.sessionCookie);

    const csrf = ((await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: again.sessionCookie as string } })).json() as { csrfToken: string }).csrfToken;
    const owner = { cookie: again.sessionCookie as string, csrfToken: csrf };
    // Le propriétaire a des données (une obligation à cours manuel).
    const asset = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/holdings/assets',
      payload: { source: 'manual', name: 'OAT 2034', kind: 'BOND', price: 100, priceDate: '2026-01-02' },
    });
    const bondId = (asset.json() as { asset: { instrumentId: string } }).asset.instrumentId;
    await authRequest(ctx, owner, { method: 'POST', url: '/api/holdings/operations', payload: { instrumentId: bondId, type: 'BUY', date: '2026-01-02', quantity: 3 } });

    // Un autre compte Google s'inscrit : il reçoit son PROPRE espace, vide.
    state.identity = { sub: 'g-inconnu', email: 'inconnu@exemple.fr', name: 'Inconnu' };
    const stranger = await googleFlow(ctx, state);
    assert.equal(stranger.location, '/?google=welcome');
    assert.ok(stranger.sessionCookie);
    const strangerHoldings = (await ctx.app.app.inject({ method: 'GET', url: '/api/holdings', headers: { cookie: stranger.sessionCookie as string } })).json() as { positions: unknown[] };
    assert.equal(strangerHoldings.positions.length, 0, 'aucune donnée du propriétaire visible');
    const strangerAccounts = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/accounts', headers: { cookie: stranger.sessionCookie as string } })).json() as { accounts: { id: string }[] };
    assert.equal(strangerAccounts.accounts.length, 1, 'ne voit que son propre compte');
    const ownerHoldings = (await authRequest(ctx, owner, { method: 'GET', url: '/api/holdings' })).json() as { positions: unknown[] };
    assert.equal(ownerHoldings.positions.length, 1);
    const strangerSession = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: stranger.sessionCookie as string } })).json() as { admin: boolean; role: string };
    assert.deepEqual([strangerSession.admin, strangerSession.role], [false, 'OWNER']);
    // Il ne peut pas régler Google pour l'installation.
    const strangerCsrf = ((await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: stranger.sessionCookie as string } })).json() as { csrfToken: string }).csrfToken;
    const denied = await authRequest(ctx, { cookie: stranger.sessionCookie as string, csrfToken: strangerCsrf }, { method: 'DELETE', url: '/api/auth/google/config' });
    assert.equal(denied.statusCode, 403);

    // Inscriptions fermées par l'administrateur : un nouveau compte Google est refusé.
    const closed = await authRequest(ctx, owner, { method: 'PUT', url: '/api/auth/registration', payload: { open: false } });
    assert.equal(closed.statusCode, 200, closed.body);
    state.identity = { sub: 'g-autre', email: 'autre@exemple.fr' };
    const refused = await googleFlow(ctx, state);
    assert.equal(refused.location, '/?google=not_invited');
    assert.equal(refused.sessionCookie, null);
    const unlinkRefused = await authRequest(ctx, owner, { method: 'DELETE', url: '/api/auth/google/link' });
    assert.equal(unlinkRefused.statusCode, 409, 'sans mot de passe, délier Google verrouillerait le compte');
    const password = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: '', newPassword: 'Nouveau-Mot-De-Passe-2026' },
    });
    assert.equal(password.statusCode, 200, password.body);
  } finally {
    await ctx.cleanup();
  }
});

test('invitation par e-mail : la personne invitée se connecte avec Google, sans mot de passe', async () => {
  const { ctx, state } = await setupApp({ sub: 'g-membre', email: 'camille@exemple.fr' });
  try {
    const owner = await login(ctx);
    const created = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/auth/accounts',
      payload: { username: 'camille', email: 'camille@exemple.fr', displayName: 'Camille', ownerUsername: 'proprietaire' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((created.json() as { account: { passwordSet: boolean } }).account.passwordSet, false);

    const flow = await googleFlow(ctx, state);
    assert.equal(flow.location, '/');
    const me = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: flow.sessionCookie as string } })).json() as {
      username: string;
      role: string;
      googleLinked: boolean;
    };
    assert.deepEqual([me.username, me.role, me.googleLinked], ['camille', 'MEMBER', true]);

    // Son compte n'a pas de mot de passe utilisable.
    const passwordLogin = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'camille', password: 'nimportequoi' } });
    assert.equal(passwordLogin.statusCode, 401);

    // Sans e-mail ni mot de passe : invitation refusée.
    const invalid = await authRequest(ctx, owner, {
      method: 'POST',
      url: '/api/auth/accounts',
      payload: { username: 'personne' },
    });
    assert.equal(invalid.statusCode, 409);
  } finally {
    await ctx.cleanup();
  }
});

test('liaison depuis le profil puis déliaison ; un compte Google déjà lié ne peut servir deux fois', async () => {
  const { ctx, state } = await setupApp({ sub: 'g-perso', email: 'autre-adresse@gmail.com' });
  try {
    const owner = await login(ctx);
    const linked = await googleFlow(ctx, state, { mode: 'link', session: owner });
    assert.equal(linked.location, '/profil?google=linked');
    const me = (await authRequest(ctx, owner, { method: 'GET', url: '/api/auth/me' })).json() as { googleLinked: boolean; email: string };
    assert.equal(me.googleLinked, true);
    assert.equal(me.email, 'autre-adresse@gmail.com', 'e-mail repris de Google quand le compte n’en avait pas');

    // Désormais, ce compte Google ouvre ce compte.
    assert.equal((await googleFlow(ctx, state)).location, '/');

    // Liaison sans jeton CSRF refusée (un site tiers ne peut pas la déclencher).
    const forged = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/start?mode=link', headers: { cookie: owner.cookie } });
    assert.equal(forged.headers.location, '/profil?google=link_refused');

    const unlinked = await authRequest(ctx, owner, { method: 'DELETE', url: '/api/auth/google/link' });
    assert.equal(unlinked.statusCode, 200);
    assert.equal((unlinked.json() as { googleLinked: boolean }).googleLinked, false);
  } finally {
    await ctx.cleanup();
  }
});

test('défenses : navigateur différent, demande rejouée, jeton falsifié ou destiné à une autre application', async () => {
  const { ctx, state } = await setupApp({ sub: 'g-owner', email: 'julien@exemple.fr' });
  try {
    assert.equal((await googleFlow(ctx, state, { tamperBrowser: true })).location, '/?google=browser_mismatch');
    state.identity = { sub: 'g-owner', email: 'julien@exemple.fr', badSignature: true };
    assert.equal((await googleFlow(ctx, state)).location, '/?google=invalid_token');
    state.identity = { sub: 'g-owner', email: 'julien@exemple.fr', aud: 'autre.apps.googleusercontent.com' };
    assert.equal((await googleFlow(ctx, state)).location, '/?google=invalid_token');
    state.identity = { sub: 'g-owner', email: 'julien@exemple.fr', email_verified: false };
    assert.equal((await googleFlow(ctx, state)).location, '/?google=email_unverified');
    // Aucune de ces tentatives n'a créé de compte.
    const session = (await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' })).json() as { needsSetup: boolean };
    assert.equal(session.needsSetup, true);
    // Le retour de Google ne sert qu'une fois (la première passe crée le compte, la seconde est refusée).
    state.identity = { sub: 'g-owner', email: 'julien@exemple.fr' };
    assert.equal((await googleFlow(ctx, state, { replay: true })).location, '/?google=expired');
    // Annulation chez Google.
    const cancelled = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/callback?error=access_denied' });
    assert.equal(cancelled.headers.location, '/?google=cancelled');
  } finally {
    await ctx.cleanup();
  }
});

test('réglage par le propriétaire dans l’application (sans .env)', async () => {
  const state = { identity: { sub: 'x', email: 'x@exemple.fr' }, nonce: null as string | null, tokenCalls: 0 };
  const ctx = await createTestApp({ googleFetch: fakeGoogle(state) });
  try {
    assert.equal(((await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/status' })).json() as { enabled: boolean }).enabled, false);
    const notConfigured = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    assert.equal(notConfigured.headers.location, '/?google=not_configured');
    const owner = await login(ctx);
    const bad = await authRequest(ctx, owner, { method: 'PUT', url: '/api/auth/google/config', payload: { clientId: 'pas-un-id', clientSecret: 'x' } });
    assert.equal(bad.statusCode, 400);
    const saved = await authRequest(ctx, owner, { method: 'PUT', url: '/api/auth/google/config', payload: { clientId: CLIENT_ID, clientSecret: 'secret-de-test-google' } });
    assert.equal(saved.statusCode, 200, saved.body);
    const config = saved.json() as { configured: boolean; source: string; redirectUri: string };
    assert.deepEqual([config.configured, config.source], [true, 'app']);
    assert.match(config.redirectUri, /\/api\/auth\/google\/callback$/);
    assert.equal(((await ctx.app.app.inject({ method: 'GET', url: '/api/auth/google/status' })).json() as { enabled: boolean }).enabled, true);
    // Le secret n'est jamais renvoyé.
    assert.ok(!saved.body.includes('secret-de-test-google'));
  } finally {
    await ctx.cleanup();
  }
});
