import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTestApp, extractCookie, type TestContext } from './helpers.ts';
import { MemoryMailer } from '../src/services/mailer.ts';
import { decryptBackupBytes, isEncryptedBackup } from '../src/services/backup.ts';

/**
 * Vrai compte : e-mail chiffré, connexion par e-mail, lien « mot de passe
 * oublié », appareils connectés et sauvegardes chiffrées.
 */

const PASSWORD = 'Mon-Mot-De-Passe-Solide-2026';
const NEW_PASSWORD = 'Un-Autre-Mot-De-Passe-2026';
const EMAIL = 'Julie.Martin@Exemple.fr';
const MASTER_KEY = 'cle-de-test-suffisamment-longue-pour-hkdf';
const PUBLIC_URL = 'https://patrimoine.exemple.fr';

function databaseBytes(ctx: TestContext): string {
  let bytes = '';
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += readFileSync(join(ctx.directory, `test.db${suffix}`)).toString('latin1');
    } catch {
      /* absent */
    }
  }
  return bytes;
}

async function setupOwner(ctx: TestContext, userAgent = 'Mozilla/5.0 (Macintosh) Chrome/130 Safari/537') {
  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'user-agent': userAgent },
    payload: { password: PASSWORD, username: 'julie', displayName: 'Julie', email: EMAIL },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { csrfToken: string; recoveryCode: string; displayName: string };
  return { cookie: extractCookie(response.headers['set-cookie']), csrfToken: body.csrfToken, body };
}

async function loginAs(ctx: TestContext, username: string, password: string, userAgent?: string) {
  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
    payload: { username, password },
  });
  return {
    status: response.statusCode,
    cookie: extractCookie(response.headers['set-cookie']),
    csrfToken: (response.json() as { csrfToken: string | null }).csrfToken ?? '',
  };
}

test("l'e-mail est chiffré en base et permet de se connecter", async () => {
  const ctx = await createTestApp();
  try {
    const owner = await setupOwner(ctx);
    assert.equal(owner.body.displayName, 'Julie');

    // Aucune trace de l'adresse, ni telle quelle ni normalisée, dans les fichiers de la base.
    const bytes = databaseBytes(ctx);
    assert.equal(bytes.includes(EMAIL), false);
    assert.equal(bytes.includes(EMAIL.toLowerCase()), false);
    assert.equal(bytes.includes('exemple.fr'), false);

    // Le titulaire la relit en clair (normalisée).
    const me = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { email: string }).email, EMAIL.toLowerCase());

    // Connexion par adresse e-mail (casse indifférente) comme par identifiant.
    assert.equal((await loginAs(ctx, 'JULIE.martin@exemple.FR', PASSWORD)).status, 200);
    assert.equal((await loginAs(ctx, 'julie', PASSWORD)).status, 200);
    assert.equal((await loginAs(ctx, 'autre@exemple.fr', PASSWORD)).status, 401);
  } finally {
    await ctx.cleanup();
  }
});

test('profil : changement du nom et de l’e-mail, unicité de l’adresse', async () => {
  const ctx = await createTestApp();
  try {
    const owner = await setupOwner(ctx);
    const headers = { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken };

    const invalid = await ctx.app.app.inject({ method: 'PATCH', url: '/api/auth/me', headers, payload: { email: 'pas-une-adresse' } });
    assert.equal(invalid.statusCode, 409);

    const updated = await ctx.app.app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers,
      payload: { displayName: 'Julie M.', email: 'julie@nouveau.fr' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(
      { name: (updated.json() as { displayName: string }).displayName, email: (updated.json() as { email: string }).email },
      { name: 'Julie M.', email: 'julie@nouveau.fr' },
    );

    // Un second compte ne peut pas reprendre la même adresse.
    const clash = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/accounts',
      headers,
      payload: { username: 'paul', password: NEW_PASSWORD, email: 'JULIE@nouveau.fr' },
    });
    assert.equal(clash.statusCode, 409);

    // Écriture sans jeton CSRF refusée.
    const noCsrf = await ctx.app.app.inject({ method: 'PATCH', url: '/api/auth/me', headers: { cookie: owner.cookie }, payload: { displayName: 'X' } });
    assert.equal(noCsrf.statusCode, 403);
  } finally {
    await ctx.cleanup();
  }
});

test('mot de passe oublié : lien par e-mail à usage unique, sans énumération', async () => {
  const mailer = new MemoryMailer();
  const ctx = await createTestApp({ mailer, env: { SUIVIINVEST_PUBLIC_URL: `${PUBLIC_URL}/` } });
  try {
    const owner = await setupOwner(ctx);
    const session = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' });
    assert.equal((session.json() as { emailResetAvailable: boolean }).emailResetAvailable, true);

    // Compte inconnu : même réponse, aucun e-mail.
    const unknown = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { identifier: 'personne@exemple.fr' } });
    const known = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { identifier: 'julie' } });
    assert.equal(unknown.statusCode, 200);
    assert.equal(known.statusCode, 200);
    assert.deepEqual(unknown.json(), known.json());
    assert.equal(mailer.outbox.length, 1);

    const message = mailer.outbox[0];
    assert.ok(message);
    assert.equal(message.to, EMAIL.toLowerCase());
    const match = /https:\/\/patrimoine\.exemple\.fr\/reinitialiser\?token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(match, message.text);
    const token = decodeURIComponent(match[1] as string);

    // Le jeton n'est pas stocké en clair.
    assert.equal(databaseBytes(ctx).includes(token), false);

    const check = await ctx.app.app.inject({ method: 'GET', url: `/api/auth/reset?token=${encodeURIComponent(token)}` });
    assert.deepEqual(check.json(), { valid: true });

    const reset = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, newPassword: NEW_PASSWORD } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.match((reset.json() as { recoveryCode: string }).recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

    // Usage unique, sessions révoquées, nouveau mot de passe actif.
    const again = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, newPassword: NEW_PASSWORD } });
    assert.equal(again.statusCode, 401);
    const oldSession = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } });
    assert.equal(oldSession.statusCode, 401);
    assert.equal((await loginAs(ctx, 'julie', PASSWORD)).status, 401);
    assert.equal((await loginAs(ctx, 'julie', NEW_PASSWORD)).status, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('sans SMTP ni adresse publique, le parcours e-mail est fermé', async () => {
  const ctx = await createTestApp({ mailer: new MemoryMailer() });
  try {
    await setupOwner(ctx);
    const session = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/session' });
    assert.equal((session.json() as { emailResetAvailable: boolean }).emailResetAvailable, false);
    const forgot = await ctx.app.app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { identifier: 'julie' } });
    assert.equal(forgot.statusCode, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('appareils connectés : liste, fermeture d’une session, déconnexion des autres', async () => {
  const ctx = await createTestApp();
  try {
    const desktop = await setupOwner(ctx);
    const phone = await loginAs(
      ctx,
      'julie',
      PASSWORD,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604.1',
    );
    const tablet = await loginAs(ctx, 'julie', PASSWORD, 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile');

    const list = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: desktop.cookie } });
    const sessions = (list.json() as { sessions: { id: string; current: boolean; device: string }[] }).sessions;
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((row) => row.current).length, 1);
    assert.deepEqual(
      sessions.map((row) => row.device).sort(),
      ['Chrome sur Android', 'Chrome sur macOS', 'Safari sur iPhone'],
    );
    // Jamais de jeton dans la réponse.
    assert.equal(list.body.includes(desktop.cookie.split('=')[1] as string), false);

    const phoneRow = sessions.find((row) => row.device === 'Safari sur iPhone');
    assert.ok(phoneRow);
    const revoke = await ctx.app.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${phoneRow.id}`,
      headers: { cookie: desktop.cookie, 'x-csrf-token': desktop.csrfToken },
    });
    assert.equal(revoke.statusCode, 200);
    const phoneAfter = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: phone.cookie } });
    assert.equal(phoneAfter.statusCode, 401);

    const others = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/sessions/logout-others',
      headers: { cookie: desktop.cookie, 'x-csrf-token': desktop.csrfToken },
    });
    assert.deepEqual(others.json(), { closed: 1 });
    const tabletAfter = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: tablet.cookie } });
    assert.equal(tabletAfter.statusCode, 401);
    const desktopAfter = await ctx.app.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: desktop.cookie } });
    assert.equal(desktopAfter.statusCode, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('les sauvegardes sont chiffrées sur le disque et restent vérifiables', async () => {
  const ctx = await createTestApp();
  try {
    await setupOwner(ctx);
    const files = ctx.app.backup.create('all');
    assert.equal(ctx.app.backup.encrypted, true);
    const sqlite = files.find((file) => file.kind === 'sqlite');
    const json = files.find((file) => file.kind === 'json');
    assert.ok(sqlite && json);
    assert.ok(sqlite.path.endsWith('.db.enc'));
    assert.ok(json.path.endsWith('.json.enc'));

    const raw = readFileSync(sqlite.path);
    assert.equal(isEncryptedBackup(raw), true);
    assert.equal(raw.includes(Buffer.from('SQLite format 3')), false);
    assert.equal(decryptBackupBytes(raw, MASTER_KEY).subarray(0, 15).toString('latin1'), 'SQLite format 3');
    assert.throws(() => decryptBackupBytes(raw, 'une-autre-cle-maitresse-bien-longue'));

    const exported = JSON.parse(decryptBackupBytes(readFileSync(json.path), MASTER_KEY).toString('utf8')) as {
      tables: Record<string, unknown[]>;
    };
    assert.ok(Array.isArray(exported.tables.accounts));

    // Aucun fichier en clair dans le répertoire (CSV compris).
    const csv = files.find((file) => file.kind === 'csv');
    assert.ok(csv);
    for (const name of readdirSync(csv.path)) assert.ok(name.endsWith('.csv.enc'), name);
    for (const name of readdirSync(ctx.app.backup.directory)) {
      assert.ok(name.endsWith('.enc') || name.startsWith('csv-'), name);
    }

    assert.equal(ctx.app.backup.verify(sqlite.path).ok, true);
  } finally {
    await ctx.cleanup();
  }
});

test('sauvegardes en clair si le chiffrement est explicitement désactivé', async () => {
  const ctx = await createTestApp({ env: { SUIVIINVEST_BACKUP_ENCRYPTION: 'false' } });
  try {
    const [file] = ctx.app.backup.create('sqlite');
    assert.ok(file);
    assert.ok(file.path.endsWith('.db'));
    assert.equal(ctx.app.backup.verify(file.path).ok, true);
  } finally {
    await ctx.cleanup();
  }
});
