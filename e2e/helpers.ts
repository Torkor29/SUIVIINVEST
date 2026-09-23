import { expect, type APIResponse, type Page } from '@playwright/test';

/** Mot de passe du premier lancement (base temporaire, jamais réutilisé ailleurs). */
export const E2E_PASSWORD = 'mot-de-passe-e2e-2026';

/** Compte propriétaire créé au premier lancement. */
export const E2E_OWNER = { username: 'proprietaire', displayName: 'Julie Propriétaire', email: 'julie@exemple.fr' };

/** Adresse publique factice utilisée pour le wallet de test. */
export const E2E_WALLET_ADDRESS = '0xe2e0000000000000000000000000000000000001';

/**
 * Crée le premier compte via l'INTERFACE (parcours réel du premier lancement).
 * À n'appeler que sur une base neuve.
 *
 * Depuis la mission 3, la création affiche UNE fois le code de récupération et
 * exige une confirmation explicite : sans cela, l'utilisateur ne pourrait plus
 * jamais reprendre la main sur son compte. Le parcours doit donc passer par cet
 * écran, comme un vrai utilisateur.
 */
export async function createPasswordThroughUi(page: Page, password = E2E_PASSWORD): Promise<void> {
  await page.goto('/');
  await fillSetupForm(page, password);
  // Écran « Votre code de secours » : le code est affiché une seule fois.
  await acknowledgeRecoveryCode(page);
  // Le tableau de bord n'apparaît qu'une fois la session ouverte.
  await expect(page.getByRole('link', { name: 'Accueil', exact: true })).toBeVisible();
}

/** Remplit le formulaire « Créez votre compte » et le valide. */
export async function fillSetupForm(page: Page, password = E2E_PASSWORD): Promise<void> {
  await expect(page.getByRole('heading', { name: /Créez votre compte/i })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prénom ou nom' }).fill(E2E_OWNER.displayName);
  await page.getByRole('textbox', { name: 'Identifiant' }).fill(E2E_OWNER.username);
  await page.getByRole('textbox', { name: /E-mail/ }).fill(E2E_OWNER.email);
  await page.getByTestId('setup-password').fill(password);
  await page.getByTestId('setup-confirm').fill(password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
}

/**
 * Passe l'écran du code de récupération et retourne le code affiché, pour que
 * le test puisse s'en servir plus tard (parcours « mot de passe oublié »).
 */
export async function acknowledgeRecoveryCode(page: Page): Promise<string> {
  const notice = page.getByTestId('recovery-code-issued');
  await expect(notice).toBeVisible();
  const code = (await notice.innerText()).trim();
  await page.getByTestId('recovery-ack').check();
  await page.getByTestId('recovery-done').click();
  return code;
}

/** Navigation par la barre latérale, comme un utilisateur. */
export async function gotoSection(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label, exact: true }).click();
  await expect(page.locator('.page-title')).toHaveText(label);
}

async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get('/api/auth/session');
  const payload = (await response.json()) as { readonly csrfToken: string | null };
  if (payload.csrfToken === null) throw new Error('Jeton CSRF absent : session non ouverte.');
  return payload.csrfToken;
}

/**
 * Appel d'API dans la session du navigateur (cookie + CSRF), pour préparer un
 * état sans dépendre de l'ordre des écrans.
 */
export async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken(page);
  const response = await page.request.fetch(path, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  return response;
}

export interface ConnectionSeed {
  readonly providerId: string;
  readonly label: string;
  readonly config?: Readonly<Record<string, string>>;
}

/** Enregistre une connexion par l'API (les cartes de l'interface la reflètent). */
export async function seedConnection(page: Page, seed: ConnectionSeed): Promise<string> {
  const response = await api(page, 'POST', '/api/connections', {
    providerId: seed.providerId,
    label: seed.label,
    config: seed.config ?? {},
    secrets: {},
  });
  expect(response.ok(), `création de la connexion ${seed.providerId} : HTTP ${response.status()}`).toBe(true);
  const payload = (await response.json()) as { readonly id: string };
  return payload.id;
}

/** Lit le contenu d'un CSV de relevé prêt à importer. */
export function sampleCsv(): string {
  return [
    'date;type;description;montant;devise',
    '2026-09-02;ACHAT;Achat TotalEnergies;-500,00;EUR',
    '2026-09-05;DIVIDENDE;Dividende TotalEnergies;85,00;EUR',
  ].join('\n');
}
