import { expect, test } from '@playwright/test';
import { E2E_WALLET_ADDRESS, api, gotoSection } from './helpers.ts';

/**
 * Parcours complet d'un wallet : ajout d'une adresse publique (watch-only),
 * synchronisation, puis vérification des positions et du patrimoine net.
 *
 * Les données viennent du connecteur FACTICE MetaMask : aucun réseau.
 */
test('ajout d’un wallet MetaMask depuis l’interface', async ({ page }) => {
  // 02-connections a déjà créé une connexion MetaMask pour « Synchroniser tout ».
  // Ce parcours-ci teste l'ajout PAR L'INTERFACE : on repart donc d'une source
  // sans connexion, comme un premier lancement sur cette source.
  const list = await api(page, 'GET', '/api/connections');
  const payload = (await list.json()) as { readonly connections: { readonly id: string; readonly providerId: string }[] };
  for (const connection of payload.connections.filter((row) => row.providerId === 'metamask')) {
    const removed = await api(page, 'DELETE', `/api/connections/${connection.id}`);
    expect(removed.ok(), `suppression de la connexion ${connection.id} : HTTP ${removed.status()}`).toBe(
      true,
    );
  }

  await page.goto('/');
  await gotoSection(page, 'Connexions');

  const card = page.getByTestId('connection-card-metamask');
  await expect(card.getByText('Non configuré')).toBeVisible();

  await card.getByTestId('connection-connect').click();
  const form = card.getByTestId('connection-connect-form');
  await expect(form).toBeVisible();
  await form.getByTestId('connection-config-address').fill(E2E_WALLET_ADDRESS);
  await form.getByTestId('connection-connect-submit').click();

  // La carte bascule sur une connexion réelle : plus de formulaire, état non connecté.
  await expect(card.getByTestId('connection-connect-form')).toHaveCount(0);
  await expect(card.getByTestId('connection-sync')).toBeVisible();
  await expect(card.getByText('Non configuré')).toHaveCount(0);
});

test('lancement d’une synchronisation et retour lisible', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Connexions');

  const card = page.getByTestId('connection-card-metamask');
  await card.getByTestId('connection-sync').click();

  // Pendant la synchronisation, l'interface le dit explicitement.
  const outcome = card.getByTestId('connection-sync-outcome');
  await expect(outcome).toBeVisible({ timeout: 30_000 });
  await expect(outcome).toContainText(/transaction|position|durée/i);
});

test('les positions synchronisées apparaissent dans Crypto', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Crypto');

  await expect(page.locator('body')).toContainText('Wallet E2E');
  await expect(page.locator('body')).toContainText('ETH');
  await expect(page.locator('.hero-value, .tile-value').first()).toContainText('€');
});

test('le patrimoine net est affiché et alimenté par les données collectées', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');

  const hero = page.locator('.hero-value');
  await expect(hero).toContainText('€');
  // Un wallet synchronisé avec 2 ETH/USDC ne peut pas laisser un patrimoine à zéro.
  await expect(hero).not.toHaveText('0,00 €');
});
