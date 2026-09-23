import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { randomToken, sha256 } from './crypto.ts';
import type { SecretsStore } from './secrets.ts';

/**
 * Connexion avec Google (OpenID Connect, flux « authorization code » + PKCE).
 *
 * Défenses :
 *  - `state` à usage unique (10 min), stocké en empreinte, ET lié au navigateur
 *    par un cookie HttpOnly : un lien de retour volé ou forgé ne peut pas
 *    connecter quelqu'un d'autre à un compte tiers (« login CSRF ») ;
 *  - PKCE (S256) : le code d'autorisation seul ne suffit pas ;
 *  - jeton d'identité vérifié ici : signature RS256 avec les clés publiques de
 *    Google, émetteur, audience (notre identifiant client), expiration, `nonce`
 *    et e-mail confirmé par Google.
 *
 * Aucun jeton d'accès Google n'est conservé : seul l'identifiant stable `sub`
 * du compte Google est enregistré, pour le reconnaître aux connexions suivantes.
 */

export const GOOGLE_BROWSER_COOKIE = 'suiviinvest_oauth';
const STATE_TTL_MS = 10 * 60_000;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export const GOOGLE_CLIENT_ID_SECRET = 'global:google_client_id';
export const GOOGLE_CLIENT_SECRET_SECRET = 'global:google_client_secret';

export interface GoogleCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: 'env' | 'app';
}

export interface GoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name: string | null;
}

export type GoogleMode = 'login' | 'link';

export class GoogleAuthError extends Error {
  /** Code court transmis à l'interface (`?google=<code>`). */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface GoogleAuthOptions {
  readonly db: Db;
  readonly secrets: SecretsStore;
  readonly env?: { readonly clientId: string | null; readonly clientSecret: string | null };
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export class GoogleAuth {
  readonly #db: Db;
  readonly #secrets: SecretsStore;
  readonly #env: { clientId: string | null; clientSecret: string | null };
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #jwks: { at: number; keys: JsonWebKey[] } | null = null;

  constructor(options: GoogleAuthOptions) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#env = { clientId: options.env?.clientId ?? null, clientSecret: options.env?.clientSecret ?? null };
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /** Identifiants Google : variables d'environnement d'abord, sinon réglage de l'application. */
  async credentials(): Promise<GoogleCredentials | null> {
    if (this.#env.clientId && this.#env.clientSecret) {
      return { clientId: this.#env.clientId, clientSecret: this.#env.clientSecret, source: 'env' };
    }
    const clientId = await this.#secrets.get(GOOGLE_CLIENT_ID_SECRET);
    const clientSecret = await this.#secrets.get(GOOGLE_CLIENT_SECRET_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret, source: 'app' } : null;
  }

  saveCredentials(clientId: string, clientSecret: string): void {
    this.#secrets.set(GOOGLE_CLIENT_ID_SECRET, clientId.trim());
    this.#secrets.set(GOOGLE_CLIENT_SECRET_SECRET, clientSecret.trim());
  }

  removeCredentials(): void {
    this.#secrets.delete(GOOGLE_CLIENT_ID_SECRET);
    this.#secrets.delete(GOOGLE_CLIENT_SECRET_SECRET);
  }

  /**
   * Prépare une demande : renvoie l'adresse Google où envoyer le navigateur et
   * la valeur du cookie qui lie la demande à ce navigateur.
   */
  async start(input: { mode: GoogleMode; userId: string | null; redirectUri: string }): Promise<{ url: string; browserToken: string }> {
    const credentials = await this.credentials();
    if (!credentials) throw new GoogleAuthError('not_configured', 'La connexion avec Google n’est pas configurée.');
    this.#purge();
    const state = randomToken(24);
    const browserToken = randomToken(24);
    const nonce = randomToken(16);
    const verifier = randomToken(48);
    this.#db.run(
      `INSERT INTO oauth_states (state_hash, browser_hash, nonce, code_verifier, mode, user_id, redirect_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sha256(state),
      sha256(browserToken),
      nonce,
      verifier,
      input.mode,
      input.userId,
      input.redirectUri,
      this.#now().toISOString(),
    );
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
    });
    return { url: `${AUTH_ENDPOINT}?${params.toString()}`, browserToken };
  }

  /** Retour de Google : vérifie tout, puis renvoie l'identité et le contexte de la demande. */
  async complete(input: {
    code: string;
    state: string;
    browserToken: string | null;
  }): Promise<{ identity: GoogleIdentity; mode: GoogleMode; userId: string | null }> {
    const row = this.#db.get<{
      state_hash: string;
      browser_hash: string;
      nonce: string;
      code_verifier: string;
      mode: GoogleMode;
      user_id: string | null;
      redirect_uri: string;
      created_at: string;
    }>('SELECT * FROM oauth_states WHERE state_hash = ?', sha256(input.state));
    // Usage unique, quoi qu'il arrive ensuite.
    if (row) this.#db.run('DELETE FROM oauth_states WHERE state_hash = ?', row.state_hash);
    if (!row || Date.parse(row.created_at) + STATE_TTL_MS < this.#now().getTime()) {
      throw new GoogleAuthError('expired', 'La demande de connexion a expiré : recommencez.');
    }
    if (!input.browserToken || sha256(input.browserToken) !== row.browser_hash) {
      throw new GoogleAuthError('browser_mismatch', 'La connexion doit être terminée dans le navigateur qui l’a commencée.');
    }
    const credentials = await this.credentials();
    if (!credentials) throw new GoogleAuthError('not_configured', 'La connexion avec Google n’est pas configurée.');

    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code: input.code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: row.redirect_uri,
        grant_type: 'authorization_code',
        code_verifier: row.code_verifier,
      }).toString(),
    }).catch(() => null);
    if (!response || !response.ok) {
      throw new GoogleAuthError('token', 'Google a refusé la connexion (identifiants de l’application ou adresse de retour incorrects).');
    }
    const payload = (await response.json()) as { id_token?: string };
    if (!payload.id_token) throw new GoogleAuthError('token', 'Réponse de Google incomplète.');
    const claims = await this.#verifyIdToken(payload.id_token, credentials.clientId);
    if (claims.nonce !== row.nonce) throw new GoogleAuthError('invalid_token', 'Jeton Google non valable pour cette demande.');
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
      throw new GoogleAuthError('email_unverified', 'Adresse e-mail Google non confirmée.');
    }
    if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
      throw new GoogleAuthError('invalid_token', 'Jeton Google incomplet.');
    }
    return {
      identity: { sub: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : null },
      mode: row.mode,
      userId: row.user_id,
    };
  }

  async #verifyIdToken(token: string, clientId: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new GoogleAuthError('invalid_token', 'Jeton Google illisible.');
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
      claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new GoogleAuthError('invalid_token', 'Jeton Google illisible.');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new GoogleAuthError('invalid_token', 'Algorithme de jeton refusé.');
    const key = await this.#key(header.kid);
    const valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${rawHeader}.${rawPayload}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(rawSignature, 'base64url'),
    );
    if (!valid) throw new GoogleAuthError('invalid_token', 'Signature du jeton Google invalide.');
    const now = Math.floor(this.#now().getTime() / 1000);
    if (!ISSUERS.has(String(claims.iss))) throw new GoogleAuthError('invalid_token', 'Émetteur du jeton inattendu.');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(clientId)) throw new GoogleAuthError('invalid_token', 'Jeton destiné à une autre application.');
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new GoogleAuthError('invalid_token', 'Jeton Google expiré.');
    return claims;
  }

  async #key(kid: string): Promise<JsonWebKey> {
    const fresh = this.#jwks && Date.now() - this.#jwks.at < 60 * 60_000;
    let key = fresh ? this.#jwks?.keys.find((item) => item.kid === kid) : undefined;
    if (!key) {
      // Clé inconnue : Google a pu en publier une nouvelle, on recharge.
      const response = await this.#fetch(JWKS_ENDPOINT).catch(() => null);
      if (!response || !response.ok) throw new GoogleAuthError('invalid_token', 'Clés publiques de Google injoignables.');
      const payload = (await response.json()) as { keys?: JsonWebKey[] };
      this.#jwks = { at: Date.now(), keys: payload.keys ?? [] };
      key = this.#jwks.keys.find((item) => item.kid === kid);
    }
    if (!key) throw new GoogleAuthError('invalid_token', 'Clé de signature Google inconnue.');
    return key;
  }

  #purge(): void {
    this.#db.run('DELETE FROM oauth_states WHERE created_at < ?', new Date(this.#now().getTime() - STATE_TTL_MS).toISOString());
  }
}
