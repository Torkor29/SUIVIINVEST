/**
 * Robustesse d'un mot de passe, pour guider la saisie (jamais envoyée au serveur).
 * 0 = vide, 1 = trop court, 2 = faible, 3 = correct, 4 = solide.
 */
export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordStrength {
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly label: string;
}

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return { level: 0, label: '' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { level: 1, label: `Encore ${MIN_PASSWORD_LENGTH - password.length} caractère(s) minimum` };
  }
  let variety = 0;
  if (/[a-z]/.test(password)) variety += 1;
  if (/[A-Z]/.test(password)) variety += 1;
  if (/\d/.test(password)) variety += 1;
  if (/[^A-Za-z0-9]/.test(password)) variety += 1;
  const repeated = /^(.)\1+$/.test(password);
  if (repeated || variety <= 1) return { level: 2, label: 'Faible : mélangez lettres, chiffres et symboles' };
  if (password.length >= 16 || (password.length >= 12 && variety >= 3)) return { level: 4, label: 'Solide' };
  return { level: 3, label: 'Correct' };
}
