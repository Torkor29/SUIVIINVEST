import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTestApp } from './helpers.ts';

/**
 * Réinitialisation par le serveur : le dernier recours quand le mot de passe ET
 * le code de récupération sont perdus. Le CLI doit fonctionner sur la base
 * réelle, ne rien écrire en clair, et remettre un mot de passe utilisable.
 */

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

function runCli(dbPath: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    [join(ROOT, 'apps/api/src/cli/reset-password.ts'), ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SUIVIINVEST_DB: dbPath,
        SUIVIINVEST_MASTER_KEY: 'cle-de-test-suffisamment-longue-pour-hkdf',
        SUIVIINVEST_LOG_LEVEL: 'error',
      },
    },
  );
}

test('le CLI liste les comptes puis réinitialise un mot de passe utilisable', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const dbPath = join(ctx.directory, 'test.db');

  // Premier compte créé par l'interface (avec identifiant).
  const setup = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'MotDePasse-Origine-2026', username: 'proprietaire' },
  });
  assert.equal(setup.statusCode, 200, setup.body);

  const listing = runCli(dbPath, ['--list']);
  assert.match(listing, /proprietaire \[OWNER\]/);

  const output = runCli(dbPath, ['--username', 'proprietaire', '--generate']);
  const generated = /Mot de passe : (\S+)/.exec(output)?.[1];
  assert.ok(generated, `mot de passe généré absent de la sortie : ${output}`);
  assert.match(output, /code de récupération \(à conserver, affiché une seule fois\) : [A-Z0-9-]+/);
  assert.ok(output.includes('Aucune trace en clair'), 'le CLI doit dire ce qui est stocké');

  // L'ancien mot de passe ne fonctionne plus, le nouveau oui.
  const oldLogin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'proprietaire', password: 'MotDePasse-Origine-2026' },
  });
  assert.equal(oldLogin.statusCode, 401);
  const newLogin = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'proprietaire', password: generated },
  });
  assert.equal(newLogin.statusCode, 200, newLogin.body);

  // Et le mot de passe généré n'est évidemment pas en base.
  const { readFileSync } = await import('node:fs');
  const dump = readFileSync(dbPath).toString('latin1');
  assert.ok(!dump.includes(generated), 'le mot de passe généré ne doit pas être en clair en base');
});

test('le CLI refuse un compte inconnu et un mot de passe trop court', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const dbPath = join(ctx.directory, 'test.db');
  await ctx.app.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'MotDePasse-Origine-2026', username: 'proprietaire' },
  });

  assert.throws(() => runCli(dbPath, ['--username', 'personne', '--generate']), /Compte introuvable/);
  assert.throws(
    () => runCli(dbPath, ['--username', 'proprietaire', '--password', 'court']),
    /trop court/i,
  );
});