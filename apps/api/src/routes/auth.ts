import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AccountCreatedResponse,
  AccountListResponse,
  ApiError,
  ChangePasswordResponse,
  DeviceSessionListResponse,
  ForgotPasswordResponse,
  ProfileResponse,
  RecoveryResponse,
  SessionResponse,
} from '@suiviinvest/api-contract';
import type { Logger } from '@suiviinvest/connectors';
import type { AuthenticatedSession, AuthService } from '../security/sessions.ts';
import { RESET_TOKEN_TTL_MINUTES, SESSION_COOKIE, validateUsername } from '../security/sessions.ts';
import { MAX_EMAIL_LENGTH } from '../security/pii.ts';
import { passwordResetEmail, type Mailer } from '../services/mailer.ts';
import { LOGIN_RATE_LIMIT, RateLimiter } from '../security/rate-limit.ts';
import { MIN_PASSWORD_LENGTH } from '../security/password.ts';
import type { AuditRepository } from '../repositories/connections.ts';

/**
 * Routes d'authentification et de comptes.
 *
 * Mesures appliquées :
 *  - limitation de débit par IP avec blocage progressif (8 essais / 15 min) sur
 *    toutes les routes qui acceptent un secret (connexion, récupération) ;
 *  - réponse générique en cas d'échec : aucune information sur l'existence d'un
 *    compte, ni sur la validité du code de récupération ;
 *  - les routes `/api/auth/*` étant exclues du crochet global, elles vérifient
 *    ELLES-MÊMES la session, le jeton CSRF et le rôle (voir `requireSession`) ;
 *  - aucune route ne renvoie jamais un hachage, un jeton de session ou un code
 *    de récupération existant : un code n'est visible qu'à sa création.
 */

export interface AuthRoutesDeps {
  readonly auth: AuthService;
  readonly audit: AuditRepository;
  readonly loginLimiter?: RateLimiter;
  readonly mailer?: Mailer;
  /** Adresse publique : obligatoire pour envoyer un lien (jamais déduite de l'en-tête Host). */
  readonly publicUrl?: string | null;
  readonly logger?: Logger;
}

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);
const usernameSchema = z.string().min(3).max(32);
const emailSchema = z.string().max(MAX_EMAIL_LENGTH);
/** Identifiant OU adresse e-mail. */
const identifierSchema = z.string().max(MAX_EMAIL_LENGTH);

const setupSchema = z.object({
  password: passwordSchema,
  username: usernameSchema.optional().nullable(),
  displayName: z.string().max(80).optional().nullable(),
  email: emailSchema.optional().nullable(),
});

const loginSchema = z.object({
  password: z.string().min(1).max(200),
  username: identifierSchema.optional().nullable(),
});

const createAccountSchema = z.object({
  username: usernameSchema,
  /** Absent : la personne invitée se connectera avec Google (e-mail obligatoire). */
  password: passwordSchema.optional().nullable(),
  displayName: z.string().max(80).optional().nullable(),
  role: z.enum(['OWNER', 'MEMBER']).optional(),
  email: emailSchema.optional().nullable(),
  ownerUsername: z.string().min(3).max(32).optional().nullable(),
});

const changePasswordSchema = z.object({
  // Vide pour un compte créé via Google qui définit son premier mot de passe.
  currentPassword: z.string().max(200).default(''),
  newPassword: passwordSchema,
});

const recoverySchema = z.object({
  recoveryCode: z.string().min(1).max(64),
  newPassword: passwordSchema,
  username: identifierSchema.optional().nullable(),
});

const profileSchema = z.object({
  displayName: z.string().max(80).optional().nullable(),
  email: emailSchema.optional().nullable(),
  username: usernameSchema.optional(),
});

const forgotSchema = z.object({ identifier: identifierSchema.min(1) });
const resetSchema = z.object({ token: z.string().min(10).max(200), newPassword: passwordSchema });

/** Réponse unique de « mot de passe oublié » : ne révèle jamais si le compte existe. */
const FORGOT_MESSAGE =
  'Si un compte avec une adresse e-mail correspond, un lien de réinitialisation vient d’être envoyé. ' +
  'Pensez à vérifier les courriers indésirables.';

export function clientKey(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return (forwarded.split(',')[0] as string).trim();
  }
  return request.ip;
}

/** Message unique renvoyé par tous les échecs d'authentification. */
const GENERIC_AUTH_FAILURE = 'Identifiant ou mot de passe incorrect.';
const GENERIC_RECOVERY_FAILURE = 'Code de récupération invalide pour ce compte.';

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  const limiter = deps.loginLimiter ?? new RateLimiter(LOGIN_RATE_LIMIT);
  const publicUrl = deps.publicUrl ?? null;
  const emailResetAvailable = (deps.mailer?.configured ?? false) && publicUrl !== null;

  /**
   * Contrôle d'accès des routes `/api/auth/*` (exclues du crochet global).
   * Vérifie la session, le jeton CSRF sur les écritures, et le rôle demandé.
   */
  function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { owner?: boolean } = {},
  ): AuthenticatedSession | null {
    const session = deps.auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
    if (!session) {
      sendError(reply, 401, 'UNAUTHENTICATED', 'Session expirée ou absente.');
      return null;
    }
    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    if (isWrite) {
      const token = request.headers['x-csrf-token'];
      if (!deps.auth.verifyCsrf(session, typeof token === 'string' ? token : null)) {
        sendError(reply, 403, 'FORBIDDEN', 'Jeton CSRF manquant ou invalide.');
        return null;
      }
    }
    if (options.owner && session.role !== 'OWNER') {
      sendError(reply, 403, 'FORBIDDEN', 'Seul le propriétaire peut gérer les comptes.');
      return null;
    }
    return session;
  }

  function sessionPayload(
    session: (Pick<AuthenticatedSession, 'csrfToken' | 'username' | 'role'> & { userId?: string }) | null,
  ): SessionResponse {
    const profile = session?.userId === undefined ? null : deps.auth.getProfile(session.userId);
    return {
      authenticated: session !== null,
      csrfToken: session?.csrfToken ?? null,
      needsSetup: deps.auth.needsSetup(),
      username: session?.username ?? null,
      role: session?.role ?? null,
      accountsCount: deps.auth.countAccounts(),
      usernameRequired: deps.auth.usernameRequired(),
      displayName: profile?.displayName ?? null,
      emailResetAvailable,
    };
  }

  /* ------------------------------------------------------------ état de session */

  app.get('/api/auth/session', async (request, reply) => {
    const session = deps.auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
    return reply.send(sessionPayload(session));
  });

  /* ------------------------------------------------------- premier lancement */

  app.post('/api/auth/setup', async (request, reply) => {
    const key = clientKey(request);
    const limit = limiter.check(key);
    if (!limit.allowed) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Trop de tentatives, réessayez plus tard.');
    }
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      limiter.record(key, false);
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Mot de passe refusé : ${MIN_PASSWORD_LENGTH} caractères minimum (200 maximum).`,
      );
    }
    if (parsed.data.username) {
      const problem = validateUsername(parsed.data.username);
      if (problem) {
        limiter.record(key, false);
        return sendError(reply, 400, 'INVALID_REQUEST', problem);
      }
    }
    try {
      const result = await deps.auth.setup(parsed.data.password, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: key,
      }, {
        username: parsed.data.username ?? null,
        displayName: parsed.data.displayName ?? null,
        email: parsed.data.email ?? null,
      });
      limiter.record(key, true);
      deps.audit.log({ actor: result.username ?? 'owner', action: 'auth.setup' });
      return reply
        .header('set-cookie', deps.auth.buildCookie(result.token))
        .send({
          ...sessionPayload({
            csrfToken: result.csrfToken,
            username: result.username,
            role: result.role,
            userId: result.userId,
          }),
          recoveryCode: result.recoveryCode,
        });
    } catch (error) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        error instanceof Error ? error.message : 'Configuration impossible.',
      );
    }
  });

  /* ------------------------------------------------------------- connexion */

  app.post('/api/auth/login', async (request, reply) => {
    const key = clientKey(request);
    const limit = limiter.check(key);
    if (!limit.allowed) {
      const seconds = Math.ceil(limit.retryAfterMs / 1000);
      reply.header('retry-after', String(seconds));
      return sendError(
        reply,
        429,
        'RATE_LIMITED',
        `Trop de tentatives. Réessayez dans ${seconds} seconde(s).`,
      );
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      limiter.record(key, false);
      return sendError(reply, 400, 'INVALID_REQUEST', 'Requête invalide.');
    }

    const result = await deps.auth.login(
      { password: parsed.data.password, username: parsed.data.username ?? null },
      { userAgent: request.headers['user-agent'] ?? null, ip: key },
    );
    if (!result) {
      const state = limiter.record(key, false);
      deps.audit.log({
        actor: parsed.data.username ?? 'inconnu',
        action: 'auth.login_failed',
        details: { ip: key },
      });
      if (!state.allowed) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Trop de tentatives. Compte temporairement bloqué.');
      }
      // Message volontairement identique dans tous les cas d'échec.
      return sendError(reply, 401, 'INVALID_CREDENTIALS', GENERIC_AUTH_FAILURE);
    }

    limiter.record(key, true);
    deps.audit.log({ actor: result.username ?? result.userId, action: 'auth.login' });
    return reply
      .header('set-cookie', deps.auth.buildCookie(result.token))
      .send(
        sessionPayload({
          csrfToken: result.csrfToken,
          username: result.username,
          role: result.role,
          userId: result.userId,
        }),
      );
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const session = deps.auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
    deps.auth.logout(request.cookies[SESSION_COOKIE] ?? null);
    if (session) deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.logout' });
    return reply
      .header('set-cookie', deps.auth.buildLogoutCookie())
      .send(sessionPayload(null));
  });

  /* -------------------------------------------------- mot de passe oublié */

  /**
   * Récupération d'accès par code.
   *
   * Aucune information n'est donnée sur l'existence du compte : même réponse,
   * même délai, que le compte existe ou non, et que le code soit bon ou non.
   */
  app.post('/api/auth/recovery', async (request, reply) => {
    const key = clientKey(request);
    const limit = limiter.check(key);
    if (!limit.allowed) {
      const seconds = Math.ceil(limit.retryAfterMs / 1000);
      reply.header('retry-after', String(seconds));
      return sendError(
        reply,
        429,
        'RATE_LIMITED',
        `Trop de tentatives. Réessayez dans ${seconds} seconde(s).`,
      );
    }
    const parsed = recoverySchema.safeParse(request.body);
    if (!parsed.success) {
      limiter.record(key, false);
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Nouveau mot de passe refusé : ${MIN_PASSWORD_LENGTH} caractères minimum.`,
      );
    }
    const result = await deps.auth.resetPasswordWithRecovery({
      username: parsed.data.username ?? null,
      recoveryCode: parsed.data.recoveryCode,
      newPassword: parsed.data.newPassword,
    });
    if (!result) {
      const state = limiter.record(key, false);
      deps.audit.log({
        actor: parsed.data.username ?? 'inconnu',
        action: 'auth.recovery_failed',
        details: { ip: key },
      });
      if (!state.allowed) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Trop de tentatives. Réessayez plus tard.');
      }
      return sendError(reply, 401, 'INVALID_CREDENTIALS', GENERIC_RECOVERY_FAILURE);
    }
    limiter.record(key, true);
    deps.audit.log({ actor: result.username ?? 'compte', action: 'auth.recovery' });
    const payload: RecoveryResponse = { username: result.username, recoveryCode: result.recoveryCode };
    return reply.send(payload);
  });

  /* ------------------------------------------- mot de passe oublié par e-mail */

  /**
   * Demande de lien. Réponse IDENTIQUE que le compte existe ou non, qu'il ait
   * une adresse ou non : aucune énumération possible. Le lien est construit à
   * partir de `SUIVIINVEST_PUBLIC_URL`, jamais depuis l'en-tête Host (sinon un
   * attaquant pourrait faire pointer le lien vers son propre site).
   */
  app.post('/api/auth/forgot', async (request, reply) => {
    const key = clientKey(request);
    const limit = limiter.check(key);
    if (!limit.allowed) {
      const seconds = Math.ceil(limit.retryAfterMs / 1000);
      reply.header('retry-after', String(seconds));
      return sendError(reply, 429, 'RATE_LIMITED', `Trop de demandes. Réessayez dans ${seconds} seconde(s).`);
    }
    if (!emailResetAvailable || !deps.mailer || publicUrl === null) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        'L’envoi d’e-mails n’est pas configuré sur ce serveur : utilisez votre code de récupération.',
      );
    }
    const parsed = forgotSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Saisissez votre identifiant ou votre e-mail.');
    // Chaque demande compte comme une tentative : on ne peut pas inonder une boîte.
    limiter.record(key, false);
    const reset = deps.auth.createPasswordReset(parsed.data.identifier);
    if (reset) {
      const link = `${publicUrl}/reinitialiser?token=${encodeURIComponent(reset.token)}`;
      try {
        await deps.mailer.send(
          passwordResetEmail({ to: reset.email, link, name: reset.name, validMinutes: RESET_TOKEN_TTL_MINUTES }),
        );
        deps.audit.log({ actor: parsed.data.identifier, action: 'auth.reset_link_sent' });
      } catch (error) {
        // L'échec d'envoi est journalisé côté serveur, jamais révélé au demandeur.
        deps.logger?.error('Envoi de l’e-mail de réinitialisation impossible', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      deps.audit.log({ actor: parsed.data.identifier, action: 'auth.reset_link_unknown' });
    }
    const payload: ForgotPasswordResponse = { message: FORGOT_MESSAGE };
    return reply.send(payload);
  });

  app.get('/api/auth/reset', async (request, reply) => {
    const query = z.object({ token: z.string().max(200).optional() }).safeParse(request.query);
    const token = query.success ? (query.data.token ?? '') : '';
    return reply.send({ valid: deps.auth.checkPasswordReset(token) });
  });

  app.post('/api/auth/reset', async (request, reply) => {
    const key = clientKey(request);
    const limit = limiter.check(key);
    if (!limit.allowed) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Trop de tentatives, réessayez plus tard.');
    }
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Nouveau mot de passe refusé : ${MIN_PASSWORD_LENGTH} caractères minimum.`,
      );
    }
    const result = await deps.auth.resetPasswordWithToken(parsed.data.token, parsed.data.newPassword);
    if (!result) {
      limiter.record(key, false);
      return sendError(
        reply,
        401,
        'INVALID_CREDENTIALS',
        'Ce lien n’est plus valable (expiré ou déjà utilisé). Faites une nouvelle demande.',
      );
    }
    limiter.record(key, true);
    deps.audit.log({ actor: result.username ?? 'compte', action: 'auth.reset_by_link' });
    const payload: RecoveryResponse = { username: result.username, recoveryCode: result.recoveryCode };
    return reply.send(payload);
  });

  /* ---------------------------------------------------------------- profil */

  app.get('/api/auth/me', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const profile = deps.auth.getProfile(session.userId);
    if (!profile) return sendError(reply, 404, 'NOT_FOUND', 'Compte introuvable.');
    const payload: ProfileResponse = profile;
    return reply.send(payload);
  });

  app.patch('/api/auth/me', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Profil invalide.');
    try {
      const profile = deps.auth.updateProfile(session.userId, {
        ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
        ...(parsed.data.email === undefined ? {} : { email: parsed.data.email }),
        ...(parsed.data.username === undefined ? {} : { username: parsed.data.username }),
      });
      deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.profile_updated' });
      const payload: ProfileResponse = profile;
      return reply.send(payload);
    } catch (error) {
      return sendError(reply, 409, 'CONFLICT', error instanceof Error ? error.message : 'Modification impossible.');
    }
  });

  /* ------------------------------------------------------ appareils connectés */

  app.get('/api/auth/sessions', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const payload: DeviceSessionListResponse = {
      sessions: deps.auth.listSessions(session.userId, session.sessionId),
    };
    return reply.send(payload);
  });

  app.post('/api/auth/sessions/logout-others', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const closed = deps.auth.logoutOtherSessions(session.userId, session.sessionId);
    deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.logout_others', details: { closed } });
    return reply.send({ closed });
  });

  app.delete('/api/auth/sessions/:id', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Session invalide.');
    if (!deps.auth.revokeSession(session.userId, params.data.id)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Session introuvable.');
    }
    deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.session_revoked' });
    const current = params.data.id === session.sessionId;
    if (current) reply.header('set-cookie', deps.auth.buildLogoutCookie());
    return reply.send({ closed: 1, current });
  });

  /* ------------------------------------------------ changement de mot de passe */

  app.post('/api/auth/password', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Nouveau mot de passe refusé : ${MIN_PASSWORD_LENGTH} caractères minimum.`,
      );
    }
    const result = await deps.auth.changePassword(
      session.userId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (!result.ok) {
      deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.password_change_failed' });
      return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
    }
    deps.audit.log({ actor: session.username ?? session.userId, action: 'auth.password_changed' });
    // Toutes les sessions du compte viennent d'être révoquées, y compris celle-ci :
    // on renvoie le nouveau code de récupération une seule fois, puis on ferme.
    const payload: ChangePasswordResponse = { recoveryCode: result.recoveryCode };
    return reply.header('set-cookie', deps.auth.buildLogoutCookie()).send(payload);
  });

  /* ------------------------------------------------------- gestion des comptes */

  app.get('/api/auth/accounts', async (request, reply) => {
    const session = requireSession(request, reply, { owner: true });
    if (!session) return reply;
    const payload: AccountListResponse = { accounts: deps.auth.listAccounts() };
    return reply.send(payload);
  });

  app.post('/api/auth/accounts', async (request, reply) => {
    const session = requireSession(request, reply, { owner: true });
    if (!session) return reply;
    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Compte refusé : identifiant de 3 à 32 caractères et mot de passe de ${MIN_PASSWORD_LENGTH} minimum.`,
      );
    }
    try {
      const created = await deps.auth.createAccount(
        {
          username: parsed.data.username,
          password: parsed.data.password ?? null,
          displayName: parsed.data.displayName ?? null,
          role: parsed.data.role,
          email: parsed.data.email ?? null,
        },
        session,
        parsed.data.ownerUsername ?? null,
      );
      deps.audit.log({
        actor: session.username ?? session.userId,
        action: 'auth.account_created',
        details: { username: created.account.username },
      });
      const payload: AccountCreatedResponse = created;
      return reply.status(201).send(payload);
    } catch (error) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        error instanceof Error ? error.message : 'Création du compte impossible.',
      );
    }
  });

  /** Nouveau code de récupération pour un compte (l'ancien cesse de fonctionner). */
  app.post('/api/auth/accounts/:id/recovery', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Compte invalide.');
    // Un membre ne peut régénérer que son propre code ; le propriétaire, tous.
    if (session.role !== 'OWNER' && params.data.id !== session.userId) {
      return sendError(reply, 403, 'FORBIDDEN', 'Seul le propriétaire peut agir sur ce compte.');
    }
    try {
      const { recoveryCode } = deps.auth.regenerateRecoveryCode(params.data.id);
      deps.audit.log({
        actor: session.username ?? session.userId,
        action: 'auth.recovery_regenerated',
        details: { accountId: params.data.id },
      });
      return reply.send({ recoveryCode });
    } catch (error) {
      return sendError(reply, 404, 'NOT_FOUND', error instanceof Error ? error.message : 'Compte introuvable.');
    }
  });

  /** Réinitialisation par le propriétaire (l'ancien mot de passe est remplacé). */
  app.post('/api/auth/accounts/:id/reset', async (request, reply) => {
    const session = requireSession(request, reply, { owner: true });
    if (!session) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    const body = z.object({ newPassword: passwordSchema }).safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(
        reply,
        400,
        'INVALID_REQUEST',
        `Nouveau mot de passe refusé : ${MIN_PASSWORD_LENGTH} caractères minimum.`,
      );
    }
    try {
      const { recoveryCode } = await deps.auth.resetPasswordForced(params.data.id, body.data.newPassword);
      deps.audit.log({
        actor: session.username ?? session.userId,
        action: 'auth.password_reset_by_owner',
        details: { accountId: params.data.id },
      });
      return reply.send({ recoveryCode });
    } catch (error) {
      return sendError(reply, 404, 'NOT_FOUND', error instanceof Error ? error.message : 'Compte introuvable.');
    }
  });

  app.patch('/api/auth/accounts/:id', async (request, reply) => {
    const session = requireSession(request, reply, { owner: true });
    if (!session) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    const body = z
      .object({ disabled: z.boolean().optional(), username: usernameSchema.optional() })
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Requête invalide.');
    }
    try {
      let account = deps.auth.listAccounts().find((row) => row.id === params.data.id) ?? null;
      if (!account) return sendError(reply, 404, 'NOT_FOUND', 'Compte introuvable.');
      if (body.data.username !== undefined) {
        account = deps.auth.setUsername(params.data.id, body.data.username);
      }
      if (body.data.disabled !== undefined) {
        account = deps.auth.setAccountDisabled(params.data.id, body.data.disabled);
      }
      deps.audit.log({
        actor: session.username ?? session.userId,
        action: 'auth.account_updated',
        details: { accountId: params.data.id },
      });
      return reply.send(account);
    } catch (error) {
      return sendError(reply, 409, 'CONFLICT', error instanceof Error ? error.message : 'Modification impossible.');
    }
  });
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiError['error']['code'],
  message: string,
  details?: unknown,
): unknown {
  const payload: ApiError = { error: { code, message, ...(details ? { details } : {}) } };
  return reply.status(status).send(payload);
}