import { expect, test } from '@playwright/test';

/**
 * Inscription libre : un visiteur crée son compte et arrive dans SON espace,
 * vide. Les investissements ajoutés par le propriétaire (tests précédents)
 * n'y apparaissent pas.
 */
test('un visiteur s’inscrit et arrive dans un espace vide, séparé du propriétaire', async ({ browser }) => {
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await visitor.newPage();
  await page.goto('/');
  await page.getByTestId('open-register').click();
  const form = page.getByTestId('register-form');
  await form.getByLabel('Prénom ou nom (facultatif)').fill('Camille');
  await form.getByTestId('register-email').fill('camille.e2e@exemple.fr');
  await form.getByTestId('register-password').fill('Mot-De-Passe-Camille-2026');
  await form.getByTestId('register-confirm').fill('Mot-De-Passe-Camille-2026');
  await form.getByTestId('register-submit').click();

  // Code de secours remis une fois, puis ouverture de la session.
  await expect(page.getByTestId('recovery-code-issued')).toBeVisible();
  await page.getByTestId('recovery-ack').check();
  await page.getByTestId('recovery-done').click();

  await page.goto('/investissements');
  await expect(page.getByText('Ajoutez votre premier investissement')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('NVIDIA');

  // Pas de réglages de l'installation pour une personne inscrite.
  await page.goto('/parametres');
  await expect(page.getByTestId('registration-toggle')).toHaveCount(0);
  await visitor.close();
});
