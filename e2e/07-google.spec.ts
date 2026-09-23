import { expect, test } from '@playwright/test';
import { api, gotoSection } from './helpers.ts';

/**
 * Connexion avec Google : le propriétaire l'active dans Paramètres, le bouton
 * apparaît à la connexion et mène bien chez Google (PKCE, adresse de retour).
 * Le passage chez Google lui-même n'est pas joué (service externe) : il est
 * couvert côté API par un Google simulé.
 */
test('le propriétaire active Google, le bouton mène chez Google', async ({ page, browser }) => {
  await page.goto('/');
  await gotoSection(page, 'Paramètres');
  const card = page.locator('section.card').filter({ hasText: 'Connexion avec Google' });
  await expect(card.getByTestId('google-redirect')).toContainText('/api/auth/google/callback');
  await card.getByLabel('ID client').fill('e2e-test.apps.googleusercontent.com');
  await card.getByLabel('Code secret du client').fill('secret-e2e-google');
  await card.getByRole('button', { name: 'Activer' }).click();
  await expect(card.getByText('Connexion avec Google activée.')).toBeVisible();

  // Le profil propose de lier son compte Google.
  await page.goto('/profil');
  await expect(page.getByTestId('google-link')).toBeVisible();

  // Écran de connexion (navigateur sans session) : bouton présent, redirection vers Google.
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guest = await visitor.newPage();
  await guest.goto('/');
  const button = guest.getByTestId('google-sign-in');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', '/api/auth/google/start');
  const start = await guest.request.get('/api/auth/google/start', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const target = new URL(start.headers()['location'] ?? '');
  expect(target.host).toBe('accounts.google.com');
  expect(target.searchParams.get('client_id')).toBe('e2e-test.apps.googleusercontent.com');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');

  // Un retour forgé (sans la demande d'origine) est refusé proprement.
  await guest.goto('/api/auth/google/callback?code=faux&state=faux');
  await expect(guest.getByTestId('google-outcome')).toContainText('expiré');
  await visitor.close();

  // Remise à l'état initial pour les tests suivants.
  const removed = await api(page, 'DELETE', '/api/auth/google/config');
  expect(removed.ok()).toBe(true);
});
