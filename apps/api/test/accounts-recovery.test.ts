import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { login, type TestContext } from './helpers.ts';
import { createTestApp } from './helpers.ts';

/**
 * Comptes, récupération d'accès et — exigence centrale — VÉRIFICATION QUE LA
 * BASE NE PERMET DE LIRE AUCUN MOT DE PASSE.
 *
 * La base est lue telle qu'elle est sur le disque (fichier + journal WAL) : si un
 * mot de passe ou un code de récupération en clair s'y trouvait, le test le
 * verrait, quelle que soit la table concernée.
 */

const OWNER_PASSWORD = 'Proprietaire-Ultra-Secret-2026';
const MEMBER_PASSWORD = 'Membre-Autre-Secret-2026';
const RECOVERY_PASSWORD = 'Nouveau-MotDePasse-2026-OK';

/** Lit les octets de la base et de son journal : l'état réellement sur disque. */
function databaseBytes(ctx: TestContext): string {
  const base = join(ctx.directory, 'test.db');
  let bytes = '';
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += readFileSync(`${base}${suffix}`).toString('latin1');
    } catch {
      /* le journal peut ne pas exister */
    }
  }
  return bytes;
}

async function ownerSession(ctx: TestContext) {
  const session = await login(ctx, OWNER_PASSWORD);
  return session;
}

function authHeaders(session: { cookie: string; csrfToken: string }) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrfToken };
}

/** Crée un membre et retourne son identifiant + son code de récupération. */
async function createMember(ctx: TestContext, session: { cookie: string; csrfToken: string }) {
  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/accounts',
    headers: authHeaders(session),
    payload: {
      username: 'invite',
      password: MEMBER_PASSWORD,
      displayName: 'Invité',
      // Le compte du propriétaire est créé sans identifiant (cas historique) :
      // il doit en fournir un en même temps, sinon il se retrouverait exclu.
      ownerUsername: 'proprietaire',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { account: { id: string; username: string }; recoveryCode: string };
  assert.match(body.recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/, 'code lisible par groupes de 4');
  return body;
}

test('aucun mot de passe ni code de récupération n’est lisible dans la base', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await ownerSession(ctx);
  const member = await createMember(ctx, session);

  const dump = databaseBytes(ctx);
  assert.ok(dump.length > 1000, 'la base doit contenir des données');
  // Le mot de passe du propriétaire, celui du membre, le code du membre : rien.
  assert.ok(!dump.includes(OWNER_PASSWORD), 'mot de passe du propriétaire en clair dans la base');
  assert.ok(!dump.includes(MEMBER_PASSWORD), 'mot de passe du membre en clair dans la base');
  assert.ok(
    !dump.includes(member.recoveryCode.replace(/-/g, '')),
    'code de récupération en clair dans la base',
  );
  assert.ok(!dump.includes(member.recoveryCode), 'code de récupération en clair dans la base');

  // Ce qui EST stocké : Argon2id pour les mots de passe, SHA-256 pour le code.
  const { verifyPassword } = await import('../src/security/password.ts');
  const rows = ctx.db.all<{ id: string; password_hash: string; recovery_hash: string | null }>(
    'SELECT id, password_hash, recovery_hash FROM users',
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.password_hash, /^\$argon2id\$/, `hachage Argon2id attendu pour ${row.id}`);
    assert.ok(!row.password_hash.includes(OWNER_PASSWORD));
    assert.ok(!row.password_hash.includes(MEMBER_PASSWORD));
    const hash = row.recovery_hash;
    assert.ok(hash === null || /^[0-9a-f]{64}$/.test(hash), 'le code est stocké en SHA-256 hexadécimal');
  }
  // Le hachage du membre correspond bien à son mot de passe, donc il est utilisable
  // pour vérifier sans jamais pouvoir être relu.
  const memberRow = rows.find((row) => row.id === member.account.id);
  assert.ok(memberRow);
  assert.equal(await verifyPassword(memberRow.password_hash, MEMBER_PASSWORD), true);
  assert.equal(await verifyPassword(memberRow.password_hash, 'autre-chose'), false);
});

test('le propriétaire crée un compte, et lui seul', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);

  // Le premier compte n'a pas d'identifiant (installations d'origine) : le
  // propriétaire doit en fournir un, sinon il ne pourrait plus se connecter.
  const withoutOwnerUsername = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/accounts',
    headers: authHeaders(owner),
    payload: { username: 'invite', password: MEMBER_PASSWORD },
  });
  assert.equal(withoutOwnerUsername.statusCode, 409);

  const withOwnerUsername = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/accounts',
    headers: authHeaders(owner),
    payload: { username: 'invite', password: MEMBER_PASSWORD, ownerUsername: 'proprietaire' },
  });
  assert.equal(withOwnerUsername.statusCode, 201, withOwnerUsername.body);
  const created = withOwnerUsername.json() as { account: { username: string }; recoveryCode: string };

  // Identifiant désormais exigé à la connexion, et le compte existe.
  const sessionInfo = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' });
  const info = sessionInfo.json() as { accountsCount: number; usernameRequired: boolean };
  assert.equal(info.accountsCount, 2);
  assert.equal(info.usernameRequired, true);

  // Un membre n'a pas accès à la gestion des comptes.
  const memberLogin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: created.account.username, password: MEMBER_PASSWORD },
  });
  assert.equal(memberLogin.statusCode, 200, memberLogin.body);
  const memberSession = {
    cookie: String(memberLogin.headers['set-cookie']).split(';')[0] ?? '',
    csrfToken: (memberLogin.json() as { csrfToken: string }).csrfToken,
  };
  const forbidden = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/auth/accounts',
    headers: { cookie: memberSession.cookie },
  });
  assert.equal(forbidden.statusCode, 403);

  // Le propriétaire, lui, voit la liste complète (sans aucun hachage).
  const list = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/auth/accounts',
    headers: { cookie: owner.cookie },
  });
  assert.equal(list.statusCode, 200);
  const accounts = (list.json() as { accounts: { username: string | null; hasRecoveryCode: boolean }[] }).accounts;
  assert.equal(accounts.length, 2);
  assert.deepEqual(
    accounts.map((row) => row.username).sort(),
    ['invite', 'proprietaire'],
  );
  assert.ok(accounts.every((row) => row.hasRecoveryCode));
  assert.ok(!list.body.includes('argon2'), 'la liste ne doit jamais exposer un hachage');
});

test('mot de passe oublié : le code de récupération rend l’accès et tourne', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);
  const member = await createMember(ctx, owner);
  assert.equal(member.account.username, 'invite');

  // Le mot de passe est oublié : on repart du code fourni à la création.
  const reset = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/recovery',
    payload: { username: 'invite', recoveryCode: member.recoveryCode, newPassword: RECOVERY_PASSWORD },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  const rotated = (reset.json() as { recoveryCode: string }).recoveryCode;
  assert.notEqual(rotated, member.recoveryCode, 'un nouveau code est émis');

  // L'ancien mot de passe ne fonctionne plus, le nouveau oui.
  const oldLogin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'invite', password: MEMBER_PASSWORD },
  });
  assert.equal(oldLogin.statusCode, 401);
  const newLogin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'invite', password: RECOVERY_PASSWORD },
  });
  assert.equal(newLogin.statusCode, 200, newLogin.body);

  // L'ancien code ne sert plus à rien ; le nouveau, oui.
  const replay = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/recovery',
    payload: { username: 'invite', recoveryCode: member.recoveryCode, newPassword: 'Encore-Un-Autre-2026' },
  });
  assert.equal(replay.statusCode, 401, 'un code déjà utilisé ne doit plus fonctionner');
  assert.equal(
    (replay.json() as { error: { message: string } }).error.message,
    'Code de récupération invalide pour ce compte.',
  );
  const second = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/recovery',
    payload: { username: 'invite', recoveryCode: rotated, newPassword: 'Encore-Un-Autre-2026' },
  });
  assert.equal(second.statusCode, 200, second.body);
});

test('mot de passe oublié : un mauvais code ne change rien et ne dit rien', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);
  const member = await createMember(ctx, owner);

  for (const code of ['AAAA-BBBB-CCCC-DDDD-EEEE', 'nimporte-quoi', '']) {
    const attempt = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/recovery',
      payload: { username: 'invite', recoveryCode: code, newPassword: RECOVERY_PASSWORD },
    });
    assert.ok(attempt.statusCode === 400 || attempt.statusCode === 401, `code ${code} : ${attempt.statusCode}`);
  }

  // Le compte est intact : le mot de passe d'origine fonctionne toujours.
  const stillWorks = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'invite', password: MEMBER_PASSWORD },
  });
  assert.equal(stillWorks.statusCode, 200);
  // Et un compte inexistant répond exactement comme un code invalide.
  const unknown = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/recovery',
    payload: { username: 'personne', recoveryCode: member.recoveryCode, newPassword: RECOVERY_PASSWORD },
  });
  assert.equal(unknown.statusCode, 401);
  assert.equal(
    (unknown.json() as { error: { message: string } }).error.message,
    'Code de récupération invalide pour ce compte.',
  );
});

test('changement de mot de passe : ancien exigé, sessions révoquées', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);

  const wrong = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: authHeaders(owner),
    payload: { currentPassword: 'pas-le-bon', newPassword: 'Nouveau-MotDePasse-2026' },
  });
  assert.equal(wrong.statusCode, 401);

  const changed = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: authHeaders(owner),
    payload: { currentPassword: OWNER_PASSWORD, newPassword: 'Nouveau-MotDePasse-2026' },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.match((changed.json() as { recoveryCode: string }).recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

  // La session courante a été révoquée : le cookie ne vaut plus rien.
  const after = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth',
    headers: { cookie: owner.cookie },
  });
  assert.equal(after.statusCode, 401, 'changer le mot de passe doit déconnecter partout');

  const oldPassword = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: OWNER_PASSWORD },
  });
  assert.equal(oldPassword.statusCode, 401);
  const newPassword = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'Nouveau-MotDePasse-2026' },
  });
  assert.equal(newPassword.statusCode, 200, newPassword.body);
});

test('un compte désactivé ne peut plus se connecter, et le dernier propriétaire est protégé', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);
  const member = await createMember(ctx, owner);

  const disabled = await ctx.app.app.inject({
    method: 'PATCH',
    url: `/api/auth/accounts/${member.account.id}`,
    headers: authHeaders(owner),
    payload: { disabled: true },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal((disabled.json() as { disabled: boolean }).disabled, true);

  const blocked = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'invite', password: MEMBER_PASSWORD },
  });
  assert.equal(blocked.statusCode, 401, 'un compte désactivé ne doit pas ouvrir de session');

  // Seul propriétaire : impossible de le désactiver.
  const selfDisable = await ctx.app.app.inject({
    method: 'PATCH',
    url: '/api/auth/accounts/owner',
    headers: authHeaders(owner),
    payload: { disabled: true },
  });
  assert.equal(selfDisable.statusCode, 409);
  assert.match((selfDisable.json() as { error: { message: string } }).error.message, /dernier propriétaire/i);
});

test('les écritures de /api/auth exigent le jeton CSRF, et la connexion est limitée en débit', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const owner = await ownerSession(ctx);

  const withoutCsrf = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { cookie: owner.cookie },
    payload: { currentPassword: OWNER_PASSWORD, newPassword: 'Nouveau-MotDePasse-2026' },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  // Confirmation de la limite : après 8 échecs, la connexion est bloquée.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'proprietaire', password: 'faux-mot-de-passe' },
    });
    lastStatus = response.statusCode;
  }
  assert.equal(lastStatus, 429, 'la limitation de débit doit finir par bloquer');
});