import { expect, test } from '@playwright/test';
import { gotoSection } from './helpers.ts';

/**
 * Portefeuille saisi à la main (marché FACTICE, sans réseau) : recherche d'un
 * actif, achat, investissement programmé rattrapé depuis une date passée,
 * puis lignes et programmes visibles dans Investissements.
 */
test('ajout d’une action, achat puis investissement programmé rattrapé', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Investissements');

  await page.getByTestId('add-investment-open').click();
  const sheet = page.getByTestId('add-investment');
  await sheet.getByTestId('asset-search').fill('nvidia');
  await sheet.getByTestId('asset-results').getByRole('button', { name: /NVIDIA Corporation/ }).click();

  // Achat ponctuel de 10 titres au cours du jour.
  await sheet.getByTestId('operation-quantity').fill('10');
  await sheet.getByTestId('operation-submit').click();

  // Fiche de l'actif : cours, ligne et opération.
  await expect(page.getByTestId('asset-name')).toHaveText('NVIDIA Corporation');
  await expect(page.getByTestId('position-value')).toBeVisible();
  await expect(page.getByTestId('operations-list').getByTestId('operation-row')).toHaveCount(1);

  // 200 $ le 10 de chaque mois depuis juin 2024 : les échéances passées deviennent des achats.
  await page.getByTestId('asset-plan').click();
  await page.getByTestId('plan-amount').fill('200');
  await page.getByTestId('plan-day').fill('10');
  await page.getByTestId('plan-start').fill('2024-06-10');
  await page.getByTestId('plan-submit').click();
  const planRow = page.getByTestId('plans-list').getByTestId('plan-row');
  await expect(planRow).toContainText('200 $US chaque mois, le 10');
  await expect(planRow).toContainText('Prochain achat');
  const rows = await page.getByTestId('operations-list').getByTestId('operation-row').count();
  expect(rows).toBeGreaterThan(5);

  await gotoSection(page, 'Investissements');
  await expect(page.getByTestId('holdings-list')).toContainText('NVIDIA Corporation');
  await expect(page.getByTestId('plans-list')).toContainText('NVIDIA Corporation');
});

test('crypto achetée par montant, visible dans le portefeuille', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Investissements');
  await page.getByTestId('add-investment-open').click();
  const sheet = page.getByTestId('add-investment');
  await sheet.getByTestId('asset-search').fill('bitcoin');
  await sheet.getByTestId('asset-results').getByRole('button', { name: /Bitcoin/ }).click();
  await sheet.getByRole('button', { name: 'Montant' }).click();
  await sheet.getByTestId('operation-amount').fill('500');
  await sheet.getByTestId('operation-submit').click();
  await expect(page.getByTestId('asset-name')).toHaveText('Bitcoin');
  await gotoSection(page, 'Investissements');
  await expect(page.getByTestId('holdings-list')).toContainText('Bitcoin');
});
