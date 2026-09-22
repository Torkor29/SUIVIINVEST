import { expect, test } from '@playwright/test';
import { gotoSection, sampleCsv } from './helpers.ts';

/**
 * Import d'un relevé CSV : le fichier est analysé (détection du format,
 * doublons) avant toute écriture, puis validé sur un compte cible explicite.
 */
test('import d’un relevé CSV de bout en bout', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Connexions');

  const panel = page.locator('section.card').filter({ hasText: 'Importer un relevé' }).first();
  await expect(panel).toBeVisible();

  // Le compte cible est obligatoire côté serveur : l'interface le propose.
  const accountSelect = panel.getByTestId('import-account');
  await expect(accountSelect).toBeVisible();
  await expect(accountSelect.locator('option')).not.toHaveCount(1);
  const firstAccount = await accountSelect.locator('option').nth(1).getAttribute('value');
  expect(firstAccount).not.toBeNull();
  await accountSelect.selectOption(firstAccount as string);

  await panel.locator('input[type="file"]').setInputFiles({
    name: 'releve-e2e.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(sampleCsv(), 'utf8'),
  });

  // Analyse : le format est détecté et le nombre de lignes nouvelles est annoncé.
  await expect(panel.getByText(/\d+ lignes? analysées?/)).toBeVisible();

  await panel.getByTestId('import-commit').click();
  // Un seul retour à l'écran, durable, et lisible : créés / ignorés.
  await expect(panel.getByTestId('import-outcome')).toContainText(/\d+ lignes? importées?/);
  await expect(panel.getByTestId('import-outcome')).toContainText(/ignorée?s?/);

  // L'historique des imports porte la trace du fichier.
  await expect(page.locator('body')).toContainText('releve-e2e.csv');
});
