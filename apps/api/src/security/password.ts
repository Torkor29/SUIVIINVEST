import { hash, verify } from '@node-rs/argon2';

/**
 * Mots de passe de l'application : Argon2id.
 *
 * Paramètres retenus (recommandation OWASP 2024 pour Argon2id) :
 *   m = 19456 KiB (19 MiB), t = 2, p = 1.
 * Ils sont suffisamment coûteux pour ralentir une attaque par force brute et
 * restent supportables sur un petit VPS (≈ 30-60 ms par vérification).
 *
 * Le hachage est PHC-string auto-descriptif : les paramètres sont stockés dans
 * la valeur, donc un durcissement futur n'invalide pas les mots de passe existants.
 */

/** Argon2id = 2 dans l'énumération native de @node-rs/argon2 (enum const non importable). */
const ARGON2ID = 2;

export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 10;

/** Politique minimale : longueur, pas de contrôle de complexité arbitraire. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  if (password.length > 200) return 'Mot de passe trop long (200 caractères maximum).';
  if (/^\s+$/.test(password)) return 'Le mot de passe ne peut pas être composé uniquement d\'espaces.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = validatePasswordStrength(password);
  if (problem) throw new Error(problem);
  return hash(password, ARGON2_PARAMS);
}

/** Vérification : retourne false au lieu de lever, pour ne pas fuiter d'information. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Description lisible des paramètres, exposée dans /api/settings (jamais le hash). */
export const ARGON2_DESCRIPTION = `Argon2id m=${ARGON2_PARAMS.memoryCost} KiB, t=${ARGON2_PARAMS.timeCost}, p=${ARGON2_PARAMS.parallelism}`;