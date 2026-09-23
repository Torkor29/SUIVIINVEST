import { createHmac } from 'node:crypto';
import { decryptSecret, deriveKey, encryptSecret, type EncryptedValue } from './crypto.ts';

/**
 * Données personnelles au repos (adresse e-mail).
 *
 * Deux usages, deux clés distinctes dérivées de la clé maîtresse :
 *  - chiffrement AES-256-GCM pour pouvoir RELIRE l'adresse (affichage au
 *    titulaire, envoi d'un lien de réinitialisation) ;
 *  - HMAC-SHA256 (« index aveugle ») pour RETROUVER un compte par e-mail sans
 *    jamais stocker l'adresse en clair ni pouvoir la reconstituer depuis l'index.
 *
 * La base seule (volée, copiée, sauvegardée) ne révèle donc aucune adresse.
 */

export const EMAIL_KEY_INFO = 'suiviinvest/pii-email/v1';
export const EMAIL_INDEX_KEY_INFO = 'suiviinvest/pii-email-index/v1';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Retourne un message d'erreur lisible, ou null si l'adresse est valide. */
export function validateEmail(email: string): string | null {
  const value = normalizeEmail(email);
  if (value.length === 0) return 'Adresse e-mail vide.';
  if (value.length > MAX_EMAIL_LENGTH) return 'Adresse e-mail trop longue.';
  if (!EMAIL_PATTERN.test(value)) return 'Adresse e-mail invalide.';
  return null;
}

export function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

export class EmailVault {
  readonly #encryptionKey: Buffer;
  readonly #indexKey: Buffer;

  constructor(masterKey: string) {
    this.#encryptionKey = deriveKey(masterKey, EMAIL_KEY_INFO);
    this.#indexKey = deriveKey(masterKey, EMAIL_INDEX_KEY_INFO);
  }

  /** Empreinte déterministe de l'adresse normalisée (recherche par égalité). */
  index(email: string): string {
    return createHmac('sha256', this.#indexKey).update(normalizeEmail(email)).digest('hex');
  }

  /** Chiffré sérialisé en une seule colonne : `v1.iv.tag.ciphertext` (base64). */
  seal(email: string): string {
    const value = encryptSecret(normalizeEmail(email), this.#encryptionKey);
    return `v${value.version}.${value.iv}.${value.tag}.${value.ciphertext}`;
  }

  /** Déchiffre ; retourne null si la clé maîtresse a changé ou la donnée est altérée. */
  open(sealed: string | null): string | null {
    if (sealed === null || sealed === '') return null;
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) return null;
    const value: EncryptedValue = { iv, tag, ciphertext, version: 1 };
    try {
      return decryptSecret(value, this.#encryptionKey);
    } catch {
      return null;
    }
  }
}

/** Masque une adresse pour l'affichage partiel : `j•••@exemple.fr`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}•••@${domain}`;
}
