import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestApp } from './helpers.ts';
import { isSameOrigin } from '../src/app.ts';

/**
 * Derrière un tunnel (Cloudflare) ou un domaine qui change, le navigateur envoie
 * `Origin` sur ses propres requêtes : elles doivent passer. Un site tiers, non.
 */
test('isSameOrigin : hôte, proxy de confiance et adresse publique', () => {
  const base = { trustProxy: false, publicUrl: null };
  assert.equal(isSameOrigin('https://abc.trycloudflare.com', { host: 'abc.trycloudflare.com' }, base), true);
  assert.equal(isSameOrigin('https://evil.example', { host: 'abc.trycloudflare.com' }, base), false);
  assert.equal(isSameOrigin('https://abc.trycloudflare.com', { host: 'localhost:9123' }, base), false);
  assert.equal(
    isSameOrigin('https://abc.trycloudflare.com', { host: 'localhost:9123', 'x-forwarded-host': 'abc.trycloudflare.com' }, { ...base, trustProxy: true }),
    true,
  );
  // Sans proxy de confiance, l'en-tête X-Forwarded-Host est ignoré.
  assert.equal(
    isSameOrigin('https://abc.trycloudflare.com', { host: 'localhost:9123', 'x-forwarded-host': 'abc.trycloudflare.com' }, base),
    false,
  );
  assert.equal(isSameOrigin('https://patrimoine.fr', { host: 'localhost:9123' }, { ...base, publicUrl: 'https://patrimoine.fr' }), true);
  assert.equal(isSameOrigin('pas une url', { host: 'x' }, base), false);
});

test('une requête du site lui-même passe, un site tiers est refusé', async () => {
  const ctx = await createTestApp();
  try {
    const own = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { host: 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' },
      payload: { password: 'mot-de-passe-solide-2026', username: 'julie' },
    });
    assert.equal(own.statusCode, 200, own.body);
    const foreign = await ctx.app.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: 'abc.trycloudflare.com', origin: 'https://evil.example' },
    });
    assert.equal(foreign.statusCode, 403);
  } finally {
    await ctx.cleanup();
  }
});
