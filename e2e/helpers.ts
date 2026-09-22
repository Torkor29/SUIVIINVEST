import { expect, type APIResponse, type Page } from '@playwright/test';

/** Mot de passe du premier lancement (base temporaire, jamais réutilisé ailleurs). */
export const E2E_PASSWORD = 'mot-de-passe-e2e-2026';

/** Adresse publique factice utilisée pour le wallet de test. */
export const E2E_WALLET_ADDRESS = '0xe2e0000000000000000000000000000000000001';

/**
 * Crée le mot de passe via l'INTERFACE (parcours réel du premier lancement).
 * À n'appeler que sur une base neuve.
 */
export async function createPasswordThroughUi(page: Page, password = E2E_PASSWORD): Promise<void> {
  await page.goto('/');
  const field = page.locator('input[type="password"]');
  await expect(field).toBeVisible();
  await field.fill(password);
  await page.getByRole('button', { name: /Créer le mot de passe/i }).click();
  // Le tableau de bord n'apparaît qu'une fois la session ouverte.
  await expect(page.getByRole('link', { name: 'Tableau de bord' })).toBeVisible();
}

/** Navigation par la barre latérale, comme un utilisateur. */
export async function gotoSection(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label }).click();
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
