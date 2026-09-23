import { expect, test } from '@playwright/test';
import { api, gotoSection, seedConnection } from './helpers.ts';

/**
 * Page Connexions : une carte par source avec l'état RÉEL renvoyé par le
 * serveur, puis la synchronisation globale et son résumé par fournisseur.
 *
 * Les connecteurs sont les doublures E2E : Trade Republic exige une validation
 * dans l'application (AUTH_REQUIRED), les autres répondent.
 */
test('les cinq sources ont une carte avec un état réel', async ({ page }) => {
  // Quatre sources non-MetaMask : une seule connexion possible par fournisseur.
  await seedConnection(page, { providerId: 'degiro', label: 'DEGIRO — test E2E' });
  await seedConnection(page, { providerId: 'trade_republic', label: 'Trade Republic — test E2E' });
  await seedConnection(page, { providerId: 'credit_agricole', label: 'Crédit Agricole — test E2E' });
  await seedConnection(page, { providerId: 'revolut', label: 'Revolut — test E2E' });

  await page.goto('/');
  await gotoSection(page, 'Connexions');

  for (const providerId of ['metamask', 'degiro', 'trade_republic', 'credit_agricole', 'revolut']) {
    await expect(page.getByTestId(`connection-card-${providerId}`)).toBeVisible();
  }

  // MetaMask n'a pas encore de connexion : l'état doit dire « Non configuré »,
  // et la carte proposer de se connecter plutôt que d'inventer un état.
  const metamaskCard = page.getByTestId('connection-card-metamask');
  await expect(metamaskCard.getByText('Non configuré')).toBeVisible();
  await expect(metamaskCard.getByTestId('connection-connect')).toBeVisible();

  // Aucune erreur technique brute à l'écran : le détail reste replié.
  await expect(page.locator('details.tech-details').first()).toBeVisible();
  await expect(page.locator('details.tech-details').first()).not.toHaveAttribute('open', '');
});

test('« Synchroniser tout » résume chaque source sans qu’une panne bloque les autres', async ({ page }) => {
  // Une connexion MetaMask en plus, pour que les cinq sources soient sollicitées.
  await seedConnection(page, {
    providerId: 'metamask',
    label: 'MetaMask — test E2E',
    config: { address: '0xe2e0000000000000000000000000000000000001' },
  });

  await page.goto('/');
  await gotoSection(page, 'Connexions');

  await page.getByRole('button', { name: 'Synchroniser tout' }).click();

  const summary = page.getByTestId('sync-all-summary');
  await expect(summary).toBeVisible();

  await expect(page.getByTestId('sync-all-row-metamask')).toContainText('OK');
  await expect(page.getByTestId('sync-all-row-degiro')).toContainText('OK');
  await expect(page.getByTestId('sync-all-row-credit_agricole')).toContainText('OK');
  // Trade Republic : la validation dans l'application est signalée, pas masquée.
  await expect(page.getByTestId('sync-all-row-trade_republic')).toContainText('Validation requise');

  // Une source en difficulté n'empêche pas les autres : la note le dit et les
  // lignes réussies sont bien présentes dans le même résumé.
  await expect(page.getByTestId('sync-all-isolation')).toBeVisible();
  await expect(page.getByTestId('sync-all-totals')).toContainText('Sources traitées');

  // Après la passe, la carte Trade Republic affiche l'état « Validation requise ».
  await expect(page.getByTestId('connection-card-trade_republic').getByText('Validation requise').first()).toBeVisible();
});

test('les positions synchronisées apparaissent dans Investissements', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Investissements');
  // DEGIRO a été synchronisé par « Synchroniser tout » : sa ligne doit exister.
  await expect(page.locator('body')).toContainText('TotalEnergies');
});

test('la synchronisation d’une source affiche un retour lisible et son détail replié', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Connexions');

  const degiroCard = page.getByTestId('connection-card-degiro');
  await degiroCard.getByTestId('connection-sync').click();

  const outcome = degiroCard.getByTestId('connection-sync-outcome');
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText(/transaction/i);
  await expect(outcome).toContainText(/durée/i);
  await expect(outcome.locator('details.tech-details')).toBeVisible();

  // Le compteur de comptes est alimenté par les données réellement collectées.
  await expect(degiroCard.getByTestId('connection-accounts')).toContainText('Comptes');
});

test('la vue wallets s’affiche (ou explique proprement son absence)', async ({ page }) => {
  await page.goto('/');
  await gotoSection(page, 'Connexions');

  // L'endpoint /api/wallets n'est pas encore livré : la vue l'explique en clair
  // (aucune erreur technique brute, rien n'est cassé).
  const response = await api(page, 'GET', '/api/wallets');
  if (response.status() === 404) {
    await expect(page.getByTestId('wallets-notice')).toContainText(/pas encore disponible|indisponible/i);
  } else {
    await expect(page.getByTestId('wallets-panel')).toBeVisible();
  }
});

test('lien coupé pendant la synchronisation (passage dans l’app du fournisseur) : le résultat arrive quand même', async ({ page }) => {
  // Connexion DEGIRO créée par le premier test de ce fichier (une seule par fournisseur).
  await page.goto('/');
  await gotoSection(page, 'Connexions');

  // La requête part bien au serveur (qui synchronise), mais la réponse n'arrive
  // jamais à la page : c'est ce que fait un téléphone qui change d'application.
  await page.route(/\/api\/connections\/[^/]+\/sync$/, async (route) => {
    await route.fetch();
    await route.abort('failed');
  });

  const card = page.getByTestId('connection-card-degiro');
  await card.getByTestId('connection-sync').click();
  await expect(card.getByText(/transactions? récupérées?/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/Serveur injoignable/)).toHaveCount(0);
});
