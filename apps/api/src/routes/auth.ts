import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiError, SessionResponse } from '@suiviinvest/api-contract';
import type { AuthService } from '../security/sessions.ts';
import { LOGIN_RATE_LIMIT, RateLimiter } from '../security/rate-limit.ts';
import { SESSION_COOKIE } from '../security/sessions.ts';
import type { AuditRepository } from '../repositories/connections.ts';

/**
 * Routes d'authentification.
 *
 * Mesures appliquées :
 *  - limitation de débit par IP avec blocage progressif (8 essais / 15 min) ;
 *  - réponse générique en cas d'échec : aucune information sur l'existence du compte ;
 *  - cookie HttpOnly/SameSite=Lax (+ Secure en production) ;
 *  - jeton CSRF renvoyé par /session et exigé sur toute écriture (voir app.ts).
 */

export interface AuthRoutesDeps {
  readonly auth: AuthService;
  readonly audit: AuditRepository;
  readonly loginLimiter?: RateLimiter;
}

const loginSchema = z.object({ password: z.string().min(1).max(200) });
const setupSchema = z.object({ password: z.string().min(10).max(200) });

export function clientKey(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return (forwarded.split(',')[0] as string).trim();
  }
  return request.ip;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  const limiter = deps.loginLimiter ?? new RateLimiter(LOGIN_RATE_LIMIT);

  app.get('/api/auth/session', async (request, reply) => {
    const session = deps.auth.authenticate(request.cookies[SESSION_COOKIE] ?? null);
    const payload: SessionResponse = {
      authenticated: session !== null,
      csrfToken: session?.csrfToken ?? null,
      needsSetup: deps.auth.needsSetup(),
    };
    return reply.send(payload);
  });

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
        'Mot de passe refusé : 10 caractères minimum (200 maximum).',
      );
    }
    try {
      const { token, csrfToken } = await deps.auth.setup(parsed.data.password, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: key,
      });
      limiter.record(key, true);
      deps.audit.log({ actor: 'owner', action: 'auth.setup' });
      return reply
        .header('set-cookie', deps.auth.buildCookie(token))
        .send({ authenticated: true, csrfToken, needsSetup: false } satisfies SessionResponse);
    } catch (error) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        error instanceof Error ? error.message : 'Configuration impossible.',
      );
    }
  });

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

    const result = await deps.auth.login(parsed.data.password, {
      userAgent: request.headers['user-agent'] ?? null,
      ip: key,
    });
    if (!result) {
      const state = limiter.record(key, false);
      deps.audit.log({ actor: 'inconnu', action: 'auth.login_failed', details: { ip: key } });
      if (!state.allowed) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Trop de tentatives. Compte temporairement bloqué.');
      }
      // Message volontairement identique dans tous les cas d'échec.
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Mot de passe incorrect.');
    }

    limiter.record(key, true);
    deps.audit.log({ actor: 'owner', action: 'auth.login' });
    return reply
      .header('set-cookie', deps.auth.buildCookie(result.token))
      .send({ authenticated: true, csrfToken: result.csrfToken, needsSetup: false } satisfies SessionResponse);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    deps.auth.logout(request.cookies[SESSION_COOKIE] ?? null);
    return reply
      .header('set-cookie', deps.auth.buildLogoutCookie())
      .send({ authenticated: false, csrfToken: null, needsSetup: false } satisfies SessionResponse);
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