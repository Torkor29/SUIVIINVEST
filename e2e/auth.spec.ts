import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { E2E_OWNER, E2E_PASSWORD, fillSetupForm } from './helpers.ts';

/**
 * Premier lancement : création du compte depuis l'interface, remise du code de
 * récupération, puis enregistrement de l'état de session pour les autres parcours.
 *
 * Ce fichier tourne dans le projet « setup », avant tous les autres.
 */
const STORAGE_STATE = 'e2e/.auth/state.json';
const RECOVERY_FILE = 'e2e/.auth/recovery.json';

test('création du compte, remise du code de récupération puis ouverture de la session', async ({
  page,
  context,
}) => {
  await page.goto('/');
  // Le bouton reste inactif tant que les deux mots de passe diffèrent.
  await page.getByTestId('setup-password').fill(E2E_PASSWORD);
  await page.getByTestId('setup-confirm').fill(`${E2E_PASSWORD}-autre`);
  await expect(page.getByRole('button', { name: 'Créer mon compte' })).toBeDisabled();
  await fillSetupForm(page);

  // Le code de récupération est affiché UNE fois : on vérifie le format et que
  // l'application impose d'en prendre acte avant de continuer.
  const notice = page.getByTestId('recovery-code-issued');
  await expect(notice).toBeVisible();
  const code = (await notice.innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

  const done = page.getByTestId('recovery-done');
  await expect(done).toBeDisabled();
  await page.getByTestId('recovery-ack').check();
  await expect(done).toBeEnabled();
  await done.click();

  // La session est bien établie côté serveur, pas seulement à l'écran.
  const session = await page.request.get('/api/auth/session');
  const payload = (await session.json()) as {
    readonly authenticated: boolean;
    readonly needsSetup: boolean;
    readonly csrfToken: string | null;
    readonly accountsCount: number;
  };
  expect(payload.authenticated).toBe(true);
  expect(payload.needsSetup).toBe(false);
  expect(payload.csrfToken).not.toBeNull();
  expect(payload.accountsCount).toBe(1);

  // Le nom choisi apparaît dans la navigation (vrai compte, pas un mot de passe seul).
  await expect(page.locator('.account-chip')).toContainText(E2E_OWNER.displayName);

  // Le patrimoine net est visible dès l'ouverture (aucune donnée inventée : 0 € si vide).
  await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
  await expect(page.locator('.hero-value')).toContainText('€');

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await context.storageState({ path: STORAGE_STATE });
  // Le code n'est jamais relisible côté serveur : on le transmet au parcours
  // « mot de passe oublié », qui a besoin du VRAI code du propriétaire.
  writeFileSync(RECOVERY_FILE, JSON.stringify({ ownerRecoveryCode: code }, null, 2));
});