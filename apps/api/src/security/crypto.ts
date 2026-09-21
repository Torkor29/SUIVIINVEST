import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Chiffrement authentifié des secrets au repos (AES-256-GCM).
 *
 * - La clé maître vient de l'environnement (`SUIVIINVEST_MASTER_KEY`) et n'est
 *   JAMAIS stockée en base : la base volée seule est inutilisable.
 * - Dérivation par HKDF-SHA256 avec un sel d'application, ce qui permet de faire
 *   évoluer les usages (secrets des connecteurs, sauvegardes chiffrées) sans
 *   réutiliser la même clé pour tout.
 * - Chaque valeur a son propre IV aléatoire de 12 octets et son tag GCM de 16
 *   octets : toute altération du chiffré fait échouer le déchiffrement.
 */

export interface EncryptedValue {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  /** Version de clé : permet une rotation sans casser l'existant. */
  readonly version: number;
}

export const SECRET_KEY_INFO = 'suiviinvest/secrets/v1';
export const BACKUP_KEY_INFO = 'suiviinvest/backups/v1';

export class CryptoError extends Error {}

/** Dérive une clé de 32 octets depuis la clé maître, pour un usage donné. */
export function deriveKey(masterKey: string, info: string): Buffer {
  const derived = hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), Buffer.from('suiviinvest'), info, 32);
  return Buffer.from(derived);
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  };
}

export function decryptSecret(value: EncryptedValue, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new CryptoError(
      'Déchiffrement impossible : clé maître différente ou données altérées ' +
        '(vérifiez SUIVIINVEST_MASTER_KEY — les secrets ne sont pas récupérables sans elle)',
      { cause: error },
    );
  }
}

/* ------------------------------------------------------------------ hachages */

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparaison à temps constant (jetons de session, CSRF). */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Masque une valeur destinée aux logs : on ne journalise JAMAIS un secret, un
 * mot de passe, un cookie, un jeton ou une clé. Seuls les 4 derniers caractères
 * d'un identifiant public peuvent être montrés (aide au diagnostic).
 */
export function maskForLog(value: string | null | undefined): string {
  if (!value) return '(vide)';
  if (value.length <= 6) return '***';
  return `***${value.slice(-4)}`;
}

/**
 * Nettoie récursivement un objet avant journalisation ou avant de le renvoyer
 * dans une erreur HTTP : toute clé ressemblant à un secret est masquée.
 */
const SENSITIVE_KEY = /(pass|pwd|pin|secret|token|private|seed|mnemonic|apikey|api_key|authorization|cookie)/i;

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[tronqué]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, depth + 1) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : scrub(item, depth + 1);
    }
    return out;
  }
  return String(value);
}