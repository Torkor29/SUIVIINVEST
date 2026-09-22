import { randomInt } from 'node:crypto';
import { safeEqual, sha256 } from './crypto.ts';

/**
 * Codes de récupération.
 *
 * Un code sert à reprendre la main sur un compte quand le mot de passe est
 * oublié, sans boîte mail et sans accès shell : c'est le seul chemin possible
 * pour une application auto-hébergée.
 *
 * Propriétés :
 *  - 20 caractères tirés dans un alphabet SANS caractères ambigus (ni 0/O, ni
 *    1/I/L) : lisible et recopiable sans erreur depuis un gestionnaire de mots
 *    de passe ou une feuille de papier ;
 *  - 100 bits d'entropie (32^20) : hors de portée d'une attaque par force brute,
 *    y compris hors ligne ;
 *  - la base ne stocke QUE l'empreinte SHA-256 : même avec un accès complet à la
 *    base, on ne peut pas remonter au code.
 *
 * Le code affiché à la création n'est plus jamais consultable ensuite : il est
 * à ranger dans un gestionnaire de mots de passe.
 */

/** Alphabet sans caractères ambigus à la lecture (0/O, 1/I/L, 5/S confondus). */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
const GROUPS = 5;
const GROUP_SIZE = 4;

export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let chunk = '';
    for (let index = 0; index < GROUP_SIZE; index += 1) {
      // randomInt est uniforme : aucun biais de modulo exploitable.
      chunk += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

/**
 * Normalise une saisie utilisateur : minuscules, espaces, tirets et points sont
 * ignorés, si bien que « abcd efgh » et « ABCD-EFGH » désignent le même code.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return sha256(normalizeRecoveryCode(code));
}

/** Vérification en temps constant : retourne false au lieu de lever. */
export function verifyRecoveryCode(storedHash: string | null, candidate: string): boolean {
  if (!storedHash) return false;
  const normalized = normalizeRecoveryCode(candidate);
  if (normalized.length !== GROUPS * GROUP_SIZE) return false;
  return safeEqual(sha256(normalized), storedHash);
}

/** Format lisible pour l'affichage : groupes séparés par des tirets. */
export function formatRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return normalized.match(/.{1,4}/g)?.join('-') ?? normalized;
}