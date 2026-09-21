import type { Db } from '../db/database.ts';
import { randomToken, safeEqual, sha256 } from './crypto.ts';
import { hashPassword, verifyPassword } from './password.ts';

/**
 * Authentification par session, adaptée à une application mono-utilisateur
 * auto-hébergée.
 *
 * Choix de sécurité :
 *  - le jeton de session n'est jamais stocké en clair : on persiste son SHA-256 ;
 *  - cookie `HttpOnly` + `Secure` (configurable pour un accès LAN en HTTP) +
 *    `SameSite=Lax` : le SPA est sur la même origine, donc Lax suffit et bloque
 *    les requêtes inter-sites (protection CSRF de base) ;
 *  - jeton CSRF distinct, obligatoire sur toute écriture (`x-csrf-token`) :
 *    défense en profondeur même si SameSite était contourné ;
 *  - expiration absolue + prolongation glissante à chaque usage.
 */

export interface SessionMeta {
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: string;
  readonly csrfToken: string;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly csrfToken: string;
  readonly sessionId: string;
}

export const SESSION_COOKIE = 'suiviinvest_session';

export class AuthService {
  readonly #db: Db;
  readonly #ttlMinutes: number;
  readonly #secure: boolean;

  constructor(db: Db, options: { ttlMinutes: number; cookieSecure: boolean }) {
    this.#db = db;
    this.#ttlMinutes = options.ttlMinutes;
    this.#secure = options.cookieSecure;
  }

  needsSetup(): boolean {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    return (row?.count ?? 0) === 0;
  }

  /** Création du compte unique. Refusée si un compte existe déjà. */
  async setup(password: string, meta: SessionMeta): Promise<{ token: string; csrfToken: string }> {
    if (!this.needsSetup()) {
      throw new Error('Un compte existe déjà : utilisez la connexion.');
    }
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    this.#db.run(
      'INSERT INTO users (id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
      'owner',
      passwordHash,
      now,
      now,
    );
    return this.#createSession('owner', meta);
  }

  async login(password: string, meta: SessionMeta): Promise<{ token: string; csrfToken: string } | null> {
    const user = this.#db.get<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users LIMIT 1',
    );
    if (!user) return null;
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) return null;
    return this.#createSession(user.id, meta);
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
    const expiresAt = new Date(Date.now() + this.#ttlMinutes * 60_000).toISOString();
    this.#db.run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      new Date().toISOString(),
      expiresAt,
      row.id,
    );
    return { userId: row.user_id, csrfToken: row.csrf_token, sessionId: row.id };
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

/** Extrait la valeur d'un cookie depuis l'en-tête `Cookie`. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}