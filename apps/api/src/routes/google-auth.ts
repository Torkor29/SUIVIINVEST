import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GoogleConfigResponse, GoogleStatusResponse } from '@suiviinvest/api-contract';
import type { AuditRepository, SettingsRepository } from '../repositories/connections.ts';
import { REGISTRATION_SETTING } from './auth.ts';
import { GOOGLE_BROWSER_COOKIE, GoogleAuthError, type GoogleAuth } from '../security/google.ts';
import { SESSION_COOKIE, type AuthService, type AuthenticatedSession } from '../security/sessions.ts';
import { sendError } from './auth.ts';

/**
 * Connexion avec Google.
 *
 *  - `GET /api/auth/google/status`   : la connexion Google est-elle proposée ?
 *  - `GET /api/auth/google/start`    : redirige vers Google (connexion, ou liaison depuis le profil) ;
 *  - `GET /api/auth/google/callback` : retour de Google, puis redirection vers l'application ;
 *  - `DELETE /api/auth/google/link`  : délie le compte Google du compte connecté ;
 *  - `GET|PUT|DELETE /api/auth/google/config` : identifiants de l'application Google (propriétaire).
 *
 * Les issues sont renvoyées à l'interface par `?google=<code>` : jamais de
 * détail technique dans l'adresse.
 */

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';

export interface GoogleRoutesDeps {
  readonly auth: AuthService;
  readonly google: GoogleAuth;
  readonly audit: AuditRepository;
  /** Réglages de l'installation : ouverture des inscriptions. */
  readonly settings?: SettingsRepository;
  readonly publicUrl: string | null;
  readonly trustProxy: boolean;
  readonly cookieSecure: boolean;
}

export async function registerGoogleAuthRoutes(app: FastifyInstance, deps: GoogleRoutesDeps): Promise<void> {
  const { auth, google, audit } = deps;

  function redirectUri(request: FastifyRequest): string {
    if (deps.publicUrl) return `${deps.publicUrl}${GOOGLE_CALLBACK_PATH}`;
    // Google n'accepte que les adresses de retour déclarées dans la console :
    // un en-tête falsifié ne mène nulle part.
    const forwardedProto = deps.trustProxy ? request.headers['x-forwarded-proto'] : undefined;
    const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0] : null) ?? request.protocol;
    const forwardedHost = deps.trustProxy ? request.headers['x-forwarded-host'] : undefined;
    const host = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0] : null) ?? request.headers.host ?? 'localhost';
    return `${proto}://${host}${GOOGLE_CALLBACK_PATH}`;
  }

  function browserCookie(value: string, maxAge: number): string {
    const attributes = [`${GOOGLE_BROWSER_COOKIE}=${value}`, 'Path=/api/auth/google', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (deps.cookieSecure) attributes.push('Secure');
    return attributes.join('; ');
  }

  function session(request: FastifyRequest): AuthenticatedSession | null {
    return auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
  }

  function writeSession(request: FastifyRequest, reply: FastifyReply, owner = false): AuthenticatedSession | null {
    const current = session(request);
    if (!current) {
      sendError(reply, 401, 'UNAUTHENTICATED', 'Session expirée ou absente.');
      return null;
    }
    const token = request.headers['x-csrf-token'];
    if (!auth.verifyCsrf(current, typeof token === 'string' ? token : null)) {
      sendError(reply, 403, 'FORBIDDEN', 'Jeton CSRF manquant ou invalide.');
      return null;
    }
    if (owner && !current.admin) {
      sendError(reply, 403, 'FORBIDDEN', 'Seul le propriétaire peut régler la connexion avec Google.');
      return null;
    }
    return current;
  }

  const back = (reply: FastifyReply, path: string, code: string): FastifyReply =>
    reply.header('set-cookie', browserCookie('', 0)).redirect(`${path}?google=${encodeURIComponent(code)}`, 302);

  app.get('/api/auth/google/status', async (_request, reply) => {
    const body: GoogleStatusResponse = { enabled: (await google.credentials()) !== null };
    return reply.send(body);
  });

  app.get('/api/auth/google/start', async (request, reply) => {
    const query = z
      .object({ mode: z.enum(['login', 'link']).default('login'), csrf: z.string().max(200).optional() })
      .safeParse(request.query);
    const mode = query.success ? query.data.mode : 'login';
    let userId: string | null = null;
    if (mode === 'link') {
      // Liaison : session ouverte ET jeton CSRF, pour qu'un site tiers ne puisse
      // pas lier un compte Google à la session d'un visiteur.
      const current = session(request);
      if (!current || !query.success || !auth.verifyCsrf(current, query.data.csrf ?? null)) {
        return back(reply, '/profil', 'link_refused');
      }
      userId = current.userId;
    }
    try {
      const { url, browserToken } = await google.start({ mode, userId, redirectUri: redirectUri(request) });
      return reply.header('set-cookie', browserCookie(browserToken, 600)).redirect(url, 302);
    } catch (error) {
      const code = error instanceof GoogleAuthError ? error.code : 'error';
      return back(reply, mode === 'link' ? '/profil' : '/', code);
    }
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    const query = z
      .object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() })
      .parse(request.query);
    if (query.error || !query.code || !query.state) {
      // L'utilisateur a annulé chez Google (ou Google a refusé).
      return back(reply, '/', query.error === 'access_denied' ? 'cancelled' : 'error');
    }
    let result;
    try {
      result = await google.complete({
        code: query.code,
        state: query.state,
        browserToken: request.cookies[GOOGLE_BROWSER_COOKIE] ?? null,
      });
    } catch (error) {
      audit.log({ actor: 'google', action: 'auth.google_failed', details: { reason: error instanceof GoogleAuthError ? error.code : 'error' } });
      return back(reply, '/', error instanceof GoogleAuthError ? error.code : 'error');
    }

    if (result.mode === 'link') {
      const current = session(request);
      if (!current || current.userId !== result.userId) return back(reply, '/profil', 'link_refused');
      try {
        auth.linkGoogle(current.userId, result.identity);
      } catch {
        return back(reply, '/profil', 'already_linked');
      }
      audit.log({ actor: current.username ?? current.userId, action: 'auth.google_linked' });
      return back(reply, '/profil', 'linked');
    }

    const outcome = await auth.googleSignIn(
      result.identity,
      { userAgent: request.headers['user-agent'] ?? null, ip: request.ip },
      // Inscription libre (ouverte par défaut) : un nouveau compte Google reçoit son propre espace.
      { allowRegistration: (deps.settings?.get(REGISTRATION_SETTING) ?? 'open') !== 'closed' },
    );
    if (outcome.outcome === 'NOT_INVITED') {
      audit.log({ actor: 'google', action: 'auth.google_not_invited' });
      return back(reply, '/', 'not_invited');
    }
    if (outcome.outcome === 'DISABLED') return back(reply, '/', 'disabled');
    if (outcome.outcome === 'OTHER_GOOGLE_ACCOUNT' || !('session' in outcome)) return back(reply, '/', 'other_account');
    audit.log({
      actor: outcome.session.username ?? outcome.session.userId,
      action:
        outcome.outcome === 'CREATED_OWNER'
          ? 'auth.setup_google'
          : outcome.outcome === 'REGISTERED'
            ? 'auth.register_google'
            : 'auth.login_google',
    });
    return reply
      .header('set-cookie', [auth.buildCookie(outcome.session.token), browserCookie('', 0)])
      .redirect(outcome.outcome === 'LOGGED_IN' ? '/' : '/?google=welcome', 302);
  });

  app.delete('/api/auth/google/link', async (request, reply) => {
    const current = writeSession(request, reply);
    if (!current) return reply;
    try {
      const profile = auth.unlinkGoogle(current.userId);
      audit.log({ actor: current.username ?? current.userId, action: 'auth.google_unlinked' });
      return reply.send(profile);
    } catch (error) {
      return sendError(reply, 409, 'CONFLICT', error instanceof Error ? error.message : 'Impossible de délier Google.');
    }
  });

  const configBody = async (request: FastifyRequest): Promise<GoogleConfigResponse> => {
    const credentials = await google.credentials();
    return {
      configured: credentials !== null,
      source: credentials?.source ?? null,
      clientId: credentials?.clientId ?? null,
      redirectUri: redirectUri(request),
      origin: redirectUri(request).replace(GOOGLE_CALLBACK_PATH, ''),
    };
  };

  app.get('/api/auth/google/config', async (request, reply) => {
    const current = session(request);
    if (!current) return sendError(reply, 401, 'UNAUTHENTICATED', 'Session expirée ou absente.');
    if (!current.admin) return sendError(reply, 403, 'FORBIDDEN', 'Réservé à l’administrateur de l’installation.');
    return reply.send(await configBody(request));
  });

  app.put('/api/auth/google/config', async (request, reply) => {
    const current = writeSession(request, reply, true);
    if (!current) return reply;
    const parsed = z
      .object({
        clientId: z.string().trim().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'Identifiant client attendu : …apps.googleusercontent.com'),
        clientSecret: z.string().trim().min(10).max(200),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Identifiants Google invalides.');
    }
    google.saveCredentials(parsed.data.clientId, parsed.data.clientSecret);
    audit.log({ actor: current.username ?? current.userId, action: 'auth.google_configured' });
    return reply.send(await configBody(request));
  });

  app.delete('/api/auth/google/config', async (request, reply) => {
    const current = writeSession(request, reply, true);
    if (!current) return reply;
    google.removeCredentials();
    audit.log({ actor: current.username ?? current.userId, action: 'auth.google_removed' });
    return reply.send(await configBody(request));
  });
}
