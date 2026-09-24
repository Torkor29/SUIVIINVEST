import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequest, createTestApp, login, inMainSpace } from './helpers.ts';

/**
 * Identifiants des connexions : saisis dans l'interface, chiffrés, remplaçables
 * sans perdre la connexion (reconnexion), jamais renvoyés par l'API.
 */
test('les identifiants d’une connexion sont chiffrés puis remplacés sur place', async () => {
  const ctx = await createTestApp();
  try {
    const session = await login(ctx);
    const created = await authRequest(ctx, session, {
      method: 'POST',
      url: '/api/connections',
      payload: {
        providerId: 'degiro',
        label: 'DEGIRO',
        config: {},
        secrets: { degiro_username: 'julie', degiro_password: 'ancien-mot-de-passe' },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json() as { id: string };

    const patched = await authRequest(ctx, session, {
      method: 'PATCH',
      url: `/api/connections/${id}`,
      payload: { secrets: { degiro_password: 'nouveau-mot-de-passe' }, config: { degiro_int_account: '123' } },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(await inMainSpace(ctx, () => ctx.app.secrets.get(`${id}:degiro_password`)), 'nouveau-mot-de-passe');
    assert.equal(await inMainSpace(ctx, () => ctx.app.secrets.get(`${id}:degiro_username`)), 'julie');

    // La liste des connexions ne contient que les NOMS des secrets.
    const list = await authRequest(ctx, session, { method: 'GET', url: '/api/connections' });
    assert.equal(list.body.includes('nouveau-mot-de-passe'), false);
    assert.equal(list.body.includes('ancien-mot-de-passe'), false);

    // Clé privée refusée même par la mise à jour.
    const forbidden = await authRequest(ctx, session, {
      method: 'PATCH',
      url: `/api/connections/${id}`,
      payload: { config: { private_key: '0xabc' } },
    });
    assert.equal(forbidden.statusCode, 400);

    const missing = await authRequest(ctx, session, {
      method: 'PATCH',
      url: '/api/connections/inconnue',
      payload: { secrets: {} },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await ctx.cleanup();
  }
});
