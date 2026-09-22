import { expect, test } from '@playwright/test';
import { gotoSection } from './helpers.ts';

/**
 * Immobilier : création d'un bien, puis ajout d'un loyer et d'une dépense.
 * Tout est saisi à la main — aucune opération bancaire n'est déclenchée.
 */
test('création d’un bien immobilier', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Immobilier');

  const form = page.locator('.property-form');
  await expect(form).toBeVisible();

  await form.getByLabel('Nom du bien').fill('Appartement E2E Lyon');
  await form.getByLabel('Adresse').fill('12 rue de la Paix, Lyon');
  await form.getByLabel('Prix d’achat (€)').fill('200000');
  await form.getByLabel('Valeur estimée (€)').fill('215000');
  await form.getByRole('button', { name: 'Ajouter le bien' }).click();

  // Le bien remonte du serveur : la carte du bien et la synthèse se mettent à jour.
  await expect(page.locator('body')).toContainText('Appartement E2E Lyon');
  await expect(page.locator('.property-form').getByText('Bien enregistré')).toBeVisible();
});

test('ajout d’un loyer (encaissement)', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Immobilier');

  const form = page.locator('.cashflow-form');
  await form.getByLabel('Nature').selectOption('INCOME');
  await form.getByLabel('Catégorie').selectOption('RENT');
  await form.getByLabel('Libellé').fill('Loyer appartement E2E');
  await form.getByLabel('Montant (€)').fill('850');
  await form.getByRole('button', { name: 'Ajouter le loyer' }).click();

  await expect(form.getByText('Loyer enregistré')).toBeVisible();
  await expect(page.locator('body')).toContainText('Loyer appartement E2E');
});

test('ajout d’une dépense (décaissement)', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Immobilier');

  const form = page.locator('.cashflow-form');
  await form.getByLabel('Nature').selectOption('EXPENSE');
  await form.getByLabel('Catégorie').selectOption('CONDO_FEES');
  await form.getByLabel('Libellé').fill('Charges copropriété E2E');
  await form.getByLabel('Montant (€)').fill('120');
  await form.getByRole('button', { name: 'Ajouter la dépense' }).click();

  await expect(form.getByText('Dépense enregistrée')).toBeVisible();
  await expect(page.locator('body')).toContainText('Charges copropriété E2E');
});
