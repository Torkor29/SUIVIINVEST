import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { E2E_PASSWORD, createPasswordThroughUi } from './helpers.ts';

/**
 * Premier lancement : création du mot de passe depuis l'interface, puis
 * enregistrement de l'état de session pour les autres parcours.
 *
 * Ce fichier tourne dans le projet « setup », avant tous les autres.
 */
const STORAGE_STATE = 'e2e/.auth/state.json';

test('création du mot de passe puis ouverture de la session', async ({ page, context }) => {
  await createPasswordThroughUi(page, E2E_PASSWORD);

  // La session est bien établie côté serveur, pas seulement à l'écran.
  const session = await page.request.get('/api/auth/session');
  const payload = (await session.json()) as {
    readonly authenticated: boolean;
    readonly needsSetup: boolean;
    readonly csrfToken: string | null;
  };
  expect(payload.authenticated).toBe(true);
  expect(payload.needsSetup).toBe(false);
  expect(payload.csrfToken).not.toBeNull();

  // Le patrimoine net est visible dès l'ouverture (aucune donnée inventée : 0 € si vide).
  await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
  await expect(page.locator('.hero-value')).toContainText('€');

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await context.storageState({ path: STORAGE_STATE });
});
