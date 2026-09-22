import type { Db } from '../db/database.ts';
import { randomToken, safeEqual, sha256 } from './crypto.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { generateRecoveryCode, hashRecoveryCode, verifyRecoveryCode } from './recovery.ts';

/**
 * Comptes et sessions, pour une application auto-hébergée.
 *
 * Choix de sécurité :
 *  - le jeton de session n'est jamais stocké en clair : on persiste son SHA-256 ;
 *  - le code de récupération non plus (SHA-256, jamais le code lui-même) ;
 *  - les mots de passe sont hachés en Argon2id (voir `password.ts`) : la base ne
 *    permet donc de LIRE aucun mot de passe, seulement de les vérifier ;
 *  - cookie `HttpOnly` + `Secure` (configurable pour un accès LAN en HTTP) +
 *    `SameSite=Lax` : le SPA est sur la même origine, donc Lax suffit et bloque
 *    les requêtes inter-sites (protection CSRF de base) ;
 *  - jeton CSRF distinct, obligatoire sur toute écriture (`x-csrf-token`) :
 *    défense en profondeur même si SameSite était contourné ;
 *  - expiration absolue + prolongation glissante à chaque usage ;
 *  - tout changement de mot de passe RÉVOQUE toutes les sessions de ce compte.
 *
 * Compatibilité : un compte sans `username` (installations antérieures à la
 * mission 3) se connecte au mot de passe seul, exactement comme avant.
 */

export interface SessionMeta {
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly username: string | null;
  readonly role: AccountRole;
}

export type AccountRole = 'OWNER' | 'MEMBER';

export interface AccountRow {
  readonly id: string;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly role: string;
  readonly password_hash: string;
  readonly recovery_hash: string | null;
  readonly disabled_at: string | null;
  readonly last_login_at: string | null;
  readonly password_changed_at: string | null;
  readonly created_at: string;
}

/** Vue publique d'un compte : jamais de hachage, jamais de code. */
export interface AccountSummary {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly role: AccountRole;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly passwordChangedAt: string | null;
  /** true = un code de récupération existe (il n'est jamais relisible). */
  readonly hasRecoveryCode: boolean;
}

export interface LoginInput {
  readonly password: string;
  readonly username?: string | null;
}

export interface LoginSuccess {
  readonly token: string;
  readonly csrfToken: string;
  readonly userId: string;
  readonly username: string | null;
  readonly role: AccountRole;
}

export interface AccountWithRecovery {
  readonly account: AccountSummary;
  /** Code affiché UNE SEULE FOIS : seul son empreinte est conservée. */
  readonly recoveryCode: string;
}

export const SESSION_COOKIE = 'suiviinvest_session';
export const MAX_USERNAME_LENGTH = 32;
export const MIN_USERNAME_LENGTH = 3;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;

/** Valide un identifiant et retourne le message d'erreur, ou null si valide. */
export function validateUsername(username: string): string | null {
  const value = username.trim().toLowerCase();
  if (value.length < MIN_USERNAME_LENGTH) {
    return `L'identifiant doit contenir au moins ${MIN_USERNAME_LENGTH} caractères.`;
  }
  if (value.length > MAX_USERNAME_LENGTH) {
    return `L'identifiant ne peut pas dépasser ${MAX_USERNAME_LENGTH} caractères.`;
  }
  if (!USERNAME_PATTERN.test(value)) {
    return 'Identifiant refusé : lettres minuscules, chiffres, point, tiret et tiret bas uniquement.';
  }
  return null;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export class AuthService {
  readonly #db: Db;
  readonly #ttlMinutes: number;
  readonly #secure: boolean;

  constructor(db: Db, options: { ttlMinutes: number; cookieSecure: boolean }) {
    this.#db = db;
    this.#ttlMinutes = options.ttlMinutes;
    this.#secure = options.cookieSecure;
  }

  /* ------------------------------------------------------------------ comptes */

  needsSetup(): boolean {
    return this.#countAccounts() === 0;
  }

  countAccounts(): number {
    return this.#countAccounts();
  }

  /**
   * Un identifiant est-il nécessaire pour se connecter ?
   *
   * Oui dès qu'un compte porte un identifiant : sinon le formulaire ne saurait
   * pas choisir entre plusieurs comptes. Une installation d'origine (un seul
   * compte sans identifiant) garde donc l'écran de connexion d'avant.
   */
  usernameRequired(): boolean {
    const row = this.#db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE username IS NOT NULL',
    );
    return (row?.count ?? 0) > 0;
  }

  /**
   * Création du premier compte. Il devient PROPRIÉTAIRE : lui seul peut créer
   * d'autres comptes. Refusée si un compte existe déjà.
   */
  async setup(
    password: string,
    meta: SessionMeta,
    options: { username?: string | null; displayName?: string | null } = {},
  ): Promise<LoginSuccess & { recoveryCode: string }> {
    if (!this.needsSetup()) {
      throw new Error('Un compte existe déjà : utilisez la connexion.');
    }
    const username = options.username ? normalizeUsername(options.username) : null;
    if (username !== null) {
      const problem = validateUsername(username);
      if (problem) throw new Error(problem);
    }
    const passwordHash = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO users (id, username, display_name, role, password_hash, recovery_hash,
                          created_at, updated_at, password_changed_at)
       VALUES (?, ?, ?, 'OWNER', ?, ?, ?, ?, ?)`,
      'owner',
      username,
      options.displayName ?? null,
      passwordHash,
      hashRecoveryCode(recoveryCode),
      now,
      now,
      now,
    );
    const session = this.#createSession('owner', meta);
    return { ...session, userId: 'owner', username, role: 'OWNER' as AccountRole, recoveryCode };
  }

  /**
   * Ajout d'un compte par le propriétaire.
   *
   * Un compte supplémentaire ouvre le MÊME patrimoine : les données ne sont pas
   * cloisonnées par utilisateur. Le propriétaire doit donc avoir conscience qu'il
   * donne un accès complet à ses données.
   *
   * Si le propriétaire n'a pas encore d'identifiant, il doit en fournir un dans
   * la même opération : sans identifiant, dès qu'un second compte existe, il ne
   * pourrait plus se reconnecter (le formulaire ne saurait plus le distinguer).
   */
  async createAccount(
    input: { username: string; password: string; displayName?: string | null; role?: AccountRole },
    actor: AuthenticatedSession,
    actorUsername?: string | null,
  ): Promise<AccountWithRecovery> {
    const username = normalizeUsername(input.username);
    const problem = validateUsername(username);
    if (problem) throw new Error(problem);
    const existing = this.#findByUsername(username);
    if (existing) throw new Error('Cet identifiant est déjà utilisé.');

    const passwordHash = await hashPassword(input.password);
    const recoveryCode = generateRecoveryCode();
    const now = new Date().toISOString();

    const actorRow = this.#findById(actor.userId);
    if (actorRow && actorRow.username === null) {
      const ownerUsername = actorUsername ? normalizeUsername(actorUsername) : null;
      if (ownerUsername === null) {
        throw new Error(
          "Donnez d'abord un identifiant à votre compte : sans lui, vous ne pourriez plus " +
            'vous connecter dès qu’un second compte existe.',
        );
      }
      const ownerProblem = validateUsername(ownerUsername);
      if (ownerProblem) throw new Error(ownerProblem);
      if (this.#findByUsername(ownerUsername)) {
        throw new Error('Cet identifiant est déjà utilisé.');
      }
      this.#db.run(
        'UPDATE users SET username = ?, updated_at = ? WHERE id = ?',
        ownerUsername,
        now,
        actor.userId,
      );
    }

    const id = randomToken(12);
    this.#db.run(
      `INSERT INTO users (id, username, display_name, role, password_hash, recovery_hash,
                          created_at, updated_at, password_changed_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      username,
      input.displayName ?? null,
      input.role ?? 'MEMBER',
      passwordHash,
      hashRecoveryCode(recoveryCode),
      now,
      now,
      now,
      actor.userId,
    );
    const created = this.#findById(id);
    if (!created) throw new Error('Création du compte impossible.');
    return { account: toSummary(created), recoveryCode };
  }

  /** Donne (ou change) l'identifiant d'un compte existant. */
  setUsername(userId: string, username: string): AccountSummary {
    const value = normalizeUsername(username);
    const problem = validateUsername(value);
    if (problem) throw new Error(problem);
    const other = this.#findByUsername(value);
    if (other && other.id !== userId) throw new Error('Cet identifiant est déjà utilisé.');
    const account = this.#findById(userId);
    if (!account) throw new Error('Compte introuvable.');
    this.#db.run(
      'UPDATE users SET username = ?, updated_at = ? WHERE id = ?',
      value,
      new Date().toISOString(),
      userId,
    );
    const updated = this.#findById(userId);
    if (!updated) throw new Error('Compte introuvable.');
    return toSummary(updated);
  }

  listAccounts(): AccountSummary[] {
    return this.#all().map(toSummary);
  }

  /**
   * Désactive (ou réactive) un compte. Le DERNIER propriétaire actif ne peut pas
   * être désactivé : personne ne pourrait plus administrer l'application.
   */
  setAccountDisabled(userId: string, disabled: boolean): AccountSummary {
    const account = this.#findById(userId);
    if (!account) throw new Error('Compte introuvable.');
    if (disabled && account.role === 'OWNER') {
      const activeOwners = this.#all().filter((row) => row.role === 'OWNER' && row.disabled_at === null);
      if (activeOwners.length <= 1) {
        throw new Error('Impossible de désactiver le dernier propriétaire actif.');
      }
    }
    const now = new Date().toISOString();
    this.#db.run(
      'UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?',
      disabled ? now : null,
      now,
      userId,
    );
    if (disabled) this.#db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    const updated = this.#findById(userId);
    if (!updated) throw new Error('Compte introuvable.');
    return toSummary(updated);
  }

  /* ----------------------------------------------------------- authentification */

  /**
   * Connexion.
   *
   * `username` est facultatif tant qu'un seul compte sans identifiant existe :
   * c'est ce qui préserve le comportement des installations d'origine.
   */
  async login(input: LoginInput, meta: SessionMeta): Promise<LoginSuccess | null> {
    const account = this.#resolveLoginAccount(input.username ?? null);
    if (!account) return null;
    if (account.disabled_at !== null) return null;
    const ok = await verifyPassword(account.password_hash, input.password);
    if (!ok) return null;
    const now = new Date().toISOString();
    this.#db.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', now, now, account.id);
    const session = this.#createSession(account.id, meta);
    return {
      ...session,
      userId: account.id,
      username: account.username,
      role: (account.role === 'OWNER' ? 'OWNER' : 'MEMBER') as AccountRole,
    };
  }

  authenticate(token: string | null | undefined): AuthenticatedSession | null {
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = this.#db.get<{ id: string; user_id: string; csrf_token: string; expires_at: string }>(
      'SELECT id, user_id, csrf_token, expires_at FROM sessions WHERE token_hash = ?',
      tokenHash,
    );
    if (!row) return null;
    if (row.expires_at <= new Date().toISOString()) {
      this.#db.run('DELETE FROM sessions WHERE id = ?', row.id);
      return null;
    }
    const account = this.#findById(row.user_id);
    if (!account || account.disabled_at !== null) {
      this.#db.run('DELETE FROM sessions WHERE id = ?', row.id);
      return null;
    }
    const expiresAt = new Date(Date.now() + this.#ttlMinutes * 60_000).toISOString();
    this.#db.run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      new Date().toISOString(),
      expiresAt,
      row.id,
    );
    return {
      userId: row.user_id,
      csrfToken: row.csrf_token,
      sessionId: row.id,
      username: account.username,
      role: (account.role === 'OWNER' ? 'OWNER' : 'MEMBER') as AccountRole,
    };
  }

  /** Vérifie le jeton CSRF en temps constant. */
  verifyCsrf(session: AuthenticatedSession, provided: string | null | undefined): boolean {
    if (!provided) return false;
    return safeEqual(session.csrfToken, provided);
  }

  logout(token: string | null | undefined): void {
    if (!token) return;
    this.#db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  logoutAll(): void {
    this.#db.run('DELETE FROM sessions');
  }

  purgeExpired(): number {
    const before = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions');
    this.#db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    const after = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions');
    return (before?.count ?? 0) - (after?.count ?? 0);
  }

  /* --------------------------------------------------------------- mots de passe */

  /** Changement de mot de passe par le titulaire : l'ancien est exigé. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<
    { ok: true; recoveryCode: string } | { ok: false; reason: 'WRONG_PASSWORD' | 'UNKNOWN_ACCOUNT' }
  > {
    const account = this.#findById(userId);
    if (!account) return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
    const valid = await verifyPassword(account.password_hash, currentPassword);
    if (!valid) return { ok: false, reason: 'WRONG_PASSWORD' };
    const recoveryCode = await this.#writePassword(userId, newPassword);
    return { ok: true, recoveryCode };
  }

  /**
   * Récupération par code : le seul chemin utilisable sans accès shell ni e-mail.
   * Le code est consommé (un nouveau est émis) et toutes les sessions du compte
   * sont révoquées.
   */
  async resetPasswordWithRecovery(input: {
    username: string | null;
    recoveryCode: string;
    newPassword: string;
  }): Promise<{ username: string | null; recoveryCode: string } | null> {
    const account = this.#resolveLoginAccount(input.username);
    if (!account || account.disabled_at !== null) return null;
    if (!verifyRecoveryCode(account.recovery_hash, input.recoveryCode)) return null;
    const recoveryCode = await this.#writePassword(account.id, input.newPassword);
    return { username: account.username, recoveryCode };
  }

  /**
   * Réinitialisation par le propriétaire (ou par la ligne de commande, qui a de
   * toute façon déjà accès à la base). Retourne le nouveau code de récupération.
   */
  async resetPasswordForced(userId: string, newPassword: string): Promise<{ recoveryCode: string }> {
    const account = this.#findById(userId);
    if (!account) throw new Error('Compte introuvable.');
    const recoveryCode = await this.#writePassword(userId, newPassword);
    return { recoveryCode };
  }

  /** Émet un nouveau code de récupération (l'ancien devient inutilisable). */
  regenerateRecoveryCode(userId: string): { recoveryCode: string } {
    const account = this.#findById(userId);
    if (!account) throw new Error('Compte introuvable.');
    const recoveryCode = generateRecoveryCode();
    this.#db.run(
      'UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?',
      hashRecoveryCode(recoveryCode),
      new Date().toISOString(),
      userId,
    );
    return { recoveryCode };
  }

  /* ---------------------------------------------------------------- cookies */

  buildCookie(token: string): string {
    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${this.#ttlMinutes * 60}`,
    ];
    if (this.#secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  buildLogoutCookie(): string {
    const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this.#secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  /* -------------------------------------------------------------- interne */

  async #writePassword(userId: string, newPassword: string): Promise<string> {
    const passwordHash = await hashPassword(newPassword);
    const recoveryCode = generateRecoveryCode();
    const now = new Date().toISOString();
    this.#db.run(
      `UPDATE users SET password_hash = ?, password_changed_at = ?, recovery_hash = ?, updated_at = ?
        WHERE id = ?`,
      passwordHash,
      now,
      hashRecoveryCode(recoveryCode),
      now,
      userId,
    );
    // Un changement de mot de passe révoque toutes les sessions : un jeton volé
    // ne survit pas à la reprise en main du compte.
    this.#db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    return recoveryCode;
  }

  #resolveLoginAccount(username: string | null): AccountRow | null {
    if (username !== null && username.trim() !== '') {
      return this.#findByUsername(normalizeUsername(username));
    }
    // Sans identifiant : uniquement si un seul compte existe (comportement
    // historique). Dès qu'il y en a plusieurs, l'identifiant est exigé.
    const rows = this.#all();
    return rows.length === 1 ? (rows[0] as AccountRow) : null;
  }

  #findByUsername(username: string): AccountRow | null {
    const row = this.#db.get<AccountRow>('SELECT * FROM users WHERE LOWER(username) = ?', username);
    return row ?? null;
  }

  #findById(id: string): AccountRow | null {
    const row = this.#db.get<AccountRow>('SELECT * FROM users WHERE id = ?', id);
    return row ?? null;
  }

  #all(): AccountRow[] {
    return this.#db.all<AccountRow>('SELECT * FROM users ORDER BY created_at');
  }

  #countAccounts(): number {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    return row?.count ?? 0;
  }

  #createSession(userId: string, meta: SessionMeta): { token: string; csrfToken: string } {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.#ttlMinutes * 60_000).toISOString();
    this.#db.run(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomToken(12),
      userId,
      sha256(token),
      csrfToken,
      now.toISOString(),
      expiresAt,
      now.toISOString(),
      meta.userAgent,
      meta.ip,
    );
    return { token, csrfToken };
  }
}

function toSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'OWNER' ? 'OWNER' : 'MEMBER',
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
    hasRecoveryCode: row.recovery_hash !== null,
  };
}

/** Extrait la valeur d'un cookie depuis l'en-tête `Cookie`. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}