import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_OWNER, E2E_PASSWORD, acknowledgeRecoveryCode, gotoSection } from './helpers.ts';

/**
 * Comptes et récupération d'accès — parcours complets dans un vrai navigateur.
 *
 * Chaque test ouvre son PROPRE contexte, sans état de session partagé : les
 * parcours d'authentification révoquent des sessions par nature (déconnexion,
 * changement de mot de passe), et réutiliser la session enregistrée par le
 * projet « setup » casserait tous les tests suivants.
 *
 * Ce fichier s'exécute en dernier (préfixe 99) : il remplace des mots de passe
 * et crée des comptes, ce qui rendrait les autres parcours imprévisibles.
 */
const MEMBER = { username: 'invite', password: 'MotDePasse-Invite-2026' };
const MEMBER_NEW_PASSWORD = 'MotDePasse-Invite-Revisite-2026';
const OWNER_USERNAME = E2E_OWNER.username;
const OWNER_NEW_PASSWORD = 'MotDePasse-Reinitialise-2026';

/**
 * Ouvre un contexte RÉELLEMENT vierge.
 *
 * ⚠️ `browser.newContext()` hérite des options du projet — dont l'état de
 * session enregistré par le projet « setup ». Sans ce `storageState` vidé
 * explicitement, le test démarrerait déjà authentifié et ne verrait jamais
 * l'écran de connexion.
 */
async function freshPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    storageState: { cookies: [], origins: [] },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

/** Connexion par identifiant (ou e-mail) et mot de passe. */
async function signIn(page: Page, password: string, identifier: string = OWNER_USERNAME): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: /Identifiant ou e-mail/i }).fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

test('déconnexion explicite, puis reconnexion par identifiant et par e-mail', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    await signIn(page, E2E_PASSWORD);
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');

    await page.getByTestId('logout').click();
    await expect(page.getByRole('heading', { name: /Bon retour/i })).toBeVisible();
    // La session est bien fermée côté serveur, pas seulement à l'écran.
    const session = (await (await page.request.get('/api/auth/session')).json()) as { authenticated: boolean };
    expect(session.authenticated).toBe(false);

    // L'adresse e-mail (stockée chiffrée) permet aussi de se connecter.
    await signIn(page, E2E_PASSWORD, E2E_OWNER.email.toUpperCase());
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
  } finally {
    await close();
  }
});

test('profil : nom et e-mail modifiables, appareils connectés listés', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    await signIn(page, E2E_PASSWORD);
    await gotoSection(page, 'Profil');

    await expect(page.getByTestId('profile-email')).toHaveValue(E2E_OWNER.email);
    await page.getByTestId('profile-display-name').fill('Julie P.');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-name')).toHaveText('Julie P.');
    await expect(page.locator('.account-chip')).toContainText('Julie P.');

    await expect(page.getByTestId('devices')).toContainText('Cet appareil');

    // On remet le nom d'origine pour les parcours suivants.
    await page.getByTestId('profile-display-name').fill(E2E_OWNER.displayName);
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-name')).toHaveText(E2E_OWNER.displayName);
  } finally {
    await close();
  }
});

test('le propriétaire crée un second compte et reçoit son code de secours', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    await signIn(page, E2E_PASSWORD);
    await gotoSection(page, 'Profil');

    await expect(page.getByTestId(`account-${OWNER_USERNAME}`)).toBeVisible();
    await page.getByTestId('new-account-username').fill(MEMBER.username);
    await page.getByTestId('new-account-password').fill(MEMBER.password);
    // Le propriétaire a déjà un identifiant : rien d'autre n'est demandé.
    await expect(page.getByTestId('owner-username')).toHaveCount(0);
    await page.getByTestId('create-account').click();

    const code = await acknowledgeRecoveryCode(page);
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

    // Le compte apparaît, et aucun mot de passe n'est jamais affiché.
    await expect(page.getByTestId(`account-${MEMBER.username}`)).toBeVisible();
    await expect(page.getByTestId(`account-${OWNER_USERNAME}`)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(MEMBER.password);
  } finally {
    await close();
  }
});

test('avec deux comptes, chacun se connecte avec son identifiant', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    // Mauvais identifiant : message générique, aucune fuite sur les comptes.
    await signIn(page, 'peu-importe-2026', 'inconnu');
    await expect(page.locator('.feedback-error')).toContainText('Identifiant ou mot de passe incorrect');

    // Le membre se connecte et voit le MÊME patrimoine (données non cloisonnées).
    await signIn(page, MEMBER.password, MEMBER.username);
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');

    // Un membre n'a pas la gestion des comptes, mais peut changer son mot de passe.
    await gotoSection(page, 'Profil');
    await expect(page.getByTestId('change-password')).toBeVisible();
    await expect(page.getByTestId('create-account')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('changement de mot de passe : l’ancien est exigé et les sessions tombent', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    await signIn(page, MEMBER.password, MEMBER.username);
    await gotoSection(page, 'Profil');

    // Ancien mot de passe faux : refus explicite.
    await page.getByTestId('current-password').fill('ce-n-est-pas-le-bon');
    await page.getByTestId('new-password').fill(MEMBER_NEW_PASSWORD);
    await page.getByTestId('confirm-password').fill(MEMBER_NEW_PASSWORD);
    await page.getByTestId('change-password').click();
    await expect(page.locator('.feedback-error')).toContainText('Mot de passe actuel incorrect');

    await page.getByTestId('current-password').fill(MEMBER.password);
    await page.getByTestId('change-password').click();
    const code = await acknowledgeRecoveryCode(page);
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

    // La session a été révoquée : l'ancien mot de passe ne vaut plus rien,
    // le nouveau ouvre la session.
    await signIn(page, MEMBER.password, MEMBER.username);
    await expect(page.locator('.feedback-error')).toContainText('Identifiant ou mot de passe incorrect');
    await signIn(page, MEMBER_NEW_PASSWORD, MEMBER.username);
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
  } finally {
    await close();
  }
});

test('mot de passe oublié : le code de secours rouvre le compte', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    // Code du propriétaire, remis une seule fois au premier lancement : le
    // serveur n'en garde qu'une empreinte, il faut donc l'avoir conservé.
    const ownerCode = (
      JSON.parse(readFileSync('e2e/.auth/recovery.json', 'utf8')) as {
        ownerRecoveryCode: string;
      }
    ).ownerRecoveryCode;
    expect(ownerCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);

    await page.goto('/');
    await page.getByTestId('forgot-password').click();
    await expect(page.getByRole('heading', { name: /Mot de passe oublié/i })).toBeVisible();

    // Un code invalide ne dit rien d'autre que « invalide ».
    await page.getByRole('textbox', { name: /Identifiant/i }).fill(OWNER_USERNAME);
    await page.getByTestId('recovery-code').fill('AAAA-BBBB-CCCC-DDDD-EEEE');
    await page.getByTestId('recovery-new-password').fill(OWNER_NEW_PASSWORD);
    await page.getByTestId('recovery-confirm-password').fill(OWNER_NEW_PASSWORD);
    await page.getByRole('button', { name: /Définir le nouveau mot de passe/i }).click();
    await expect(page.locator('.feedback-error')).toContainText('Code de récupération invalide pour ce compte');

    // Avec le vrai code : accès rendu et nouveau code émis.
    await page.getByTestId('recovery-code').fill(ownerCode);
    await page.getByRole('button', { name: /Définir le nouveau mot de passe/i }).click();
    const rotated = await acknowledgeRecoveryCode(page);
    expect(rotated).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/);
    expect(rotated).not.toBe(ownerCode);

    // Le nouveau mot de passe ouvre la session.
    await signIn(page, OWNER_NEW_PASSWORD, OWNER_USERNAME);
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
  } finally {
    await close();
  }
});

test('un lien de réinitialisation invalide est refusé proprement', async ({ browser }) => {
  const { page, close } = await freshPage(browser);
  try {
    await page.goto('/reinitialiser?token=jeton-invalide-0000000000');
    await expect(page.getByRole('heading', { name: /Lien expiré/i })).toBeVisible();
  } finally {
    await close();
  }
});

test('sur téléphone : barre d’onglets et menu « Plus » avec déconnexion', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'fr-FR',
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  try {
    await signIn(page, OWNER_NEW_PASSWORD, OWNER_USERNAME);
    await expect(page.locator('.hero-label')).toHaveText('Patrimoine net');
    const tabs = page.getByRole('navigation', { name: 'Onglets' });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('link', { name: 'Crypto' }).click();
    await expect(page.locator('.page-title')).toHaveText('Crypto');

    await tabs.getByRole('button', { name: 'Plus de sections' }).click();
    await page.getByTestId('logout').click();
    await expect(page.getByRole('heading', { name: /Bon retour/i })).toBeVisible();
  } finally {
    await context.close();
  }
});
