import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ConnectorError,
  EnableBankingClient,
  FetchHttpClient,
  type EnableBankingCredentials,
  type HttpClient,
  type Logger,
} from '@suiviinvest/connectors';
import type { Db } from '../db/database.ts';
import { AuditRepository, ConnectionRepository, SettingsRepository } from '../repositories/connections.ts';
import type { SecretsStore } from '../security/secrets.ts';
import type { SyncService } from '../services/sync.ts';
import { sendError } from './auth.ts';

/**
 * Parcours d'autorisation bancaire via Enable Banking (open banking PSD2).
 *
 *  - `GET    /api/enable-banking/status`     : application configurée ? URL de retour à déclarer ;
 *  - `PUT    /api/enable-banking/app`        : enregistre l'identifiant + la clé privée (chiffrés) ;
 *  - `DELETE /api/enable-banking/app`        : les retire ;
 *  - `GET    /api/enable-banking/aspsps`     : banques disponibles dans un pays ;
 *  - `POST   /api/enable-banking/authorize`  : adresse de la banque où donner son accord ;
 *  - `POST   /api/enable-banking/complete`   : échange le code de retour, crée (ou renouvelle)
 *    la connexion et lance une première synchronisation.
 *
 * Les routes sont derrière l'authentification et le jeton CSRF globaux (préfixe `/api/`).
 */

export interface EnableBankingRoutesDeps {
  readonly db: Db;
  readonly secrets: SecretsStore;
  readonly sync: SyncService;
  readonly logger: Logger;
  readonly publicUrl: string | null;
  readonly trustProxy: boolean;
  /** URL de retour imposée (sinon : adresse publique + /connexions/banque). */
  readonly redirectUrl?: string | null;
  readonly integrationKeys: Readonly<Record<string, string>>;
  /** Client HTTP injectable (tests). */
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

const APP_ID_SECRET = 'global:enablebanking_application_id';
const APP_KEY_SECRET = 'global:enablebanking_private_key';
const PENDING_KEY = 'enablebanking.pending';
const PENDING_TTL_MS = 60 * 60_000;
const DEFAULT_CONSENT_DAYS = 180;
export const ENABLE_BANKING_CALLBACK_PATH = '/connexions/banque';

interface PendingAuthorization {
  readonly aspspName: string;
  readonly country: string;
  readonly connectionId: string | null;
  readonly createdAt: string;
}

export async function registerEnableBankingRoutes(app: FastifyInstance, deps: EnableBankingRoutesDeps): Promise<void> {
  const settings = new SettingsRepository(deps.db);
  const connections = new ConnectionRepository(deps.db);
  const audit = new AuditRepository(deps.db);
  const http = deps.http ?? new FetchHttpClient({ providerId: 'enable_banking' });
  const now = deps.now ?? (() => new Date());

  async function credentials(): Promise<EnableBankingCredentials | null> {
    const applicationId =
      (await deps.secrets.get(APP_ID_SECRET)) ?? deps.integrationKeys.enablebanking_application_id ?? null;
    const privateKey = (await deps.secrets.get(APP_KEY_SECRET)) ?? deps.integrationKeys.enablebanking_private_key ?? null;
    if (!applicationId || !privateKey) return null;
    return { applicationId, privateKey };
  }

  function redirectUrl(request: FastifyRequest): string {
    if (deps.redirectUrl) return deps.redirectUrl;
    if (deps.publicUrl) return `${deps.publicUrl}${ENABLE_BANKING_CALLBACK_PATH}`;
    // Sans adresse publique déclarée, on reprend celle de la requête : Enable
    // Banking n'accepte de toute façon que les adresses enregistrées dans
    // l'application, un en-tête falsifié ne mène nulle part.
    const forwardedProto = deps.trustProxy ? request.headers['x-forwarded-proto'] : undefined;
    const proto = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0] : null) ?? request.protocol;
    const forwardedHost = deps.trustProxy ? request.headers['x-forwarded-host'] : undefined;
    const host = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0] : null) ?? request.headers.host ?? 'localhost';
    return `${proto}://${host}${ENABLE_BANKING_CALLBACK_PATH}`;
  }

  function pending(): Record<string, PendingAuthorization> {
    const all = settings.getJson<Record<string, PendingAuthorization>>(PENDING_KEY, {});
    const threshold = now().getTime() - PENDING_TTL_MS;
    return Object.fromEntries(Object.entries(all).filter(([, value]) => Date.parse(value.createdAt) >= threshold));
  }

  function connectorFailure(reply: Parameters<typeof sendError>[0], error: unknown) {
    if (error instanceof ConnectorError) {
      const status = error.kind === 'AUTH_REQUIRED' ? 400 : error.kind === 'RATE_LIMITED' ? 429 : 502;
      return sendError(reply, status, 'CONNECTOR_ERROR', error.message.replace(/^\[[^\]]+\]\s*/, ''));
    }
    deps.logger.error('Enable Banking : erreur inattendue', { message: error instanceof Error ? error.message : String(error) });
    return sendError(reply, 500, 'INTERNAL', 'Erreur inattendue avec Enable Banking.');
  }

  app.get('/api/enable-banking/status', async (request, reply) => {
    const creds = await credentials();
    return reply.send({
      configured: creds !== null,
      applicationId: creds?.applicationId ?? null,
      redirectUrl: redirectUrl(request),
    });
  });

  app.put('/api/enable-banking/app', async (request, reply) => {
    const parsed = z
      .object({ applicationId: z.string().min(8).max(200), privateKey: z.string().min(100).max(20_000) })
      .safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Identifiant d’application ou clé privée manquant.');
    }
    const creds = { applicationId: parsed.data.applicationId.trim(), privateKey: parsed.data.privateKey.trim() };
    // Vérification immédiate : on n'enregistre pas une clé qui ne marche pas.
    try {
      await new EnableBankingClient(http, creds, now).listAspsps('FR');
    } catch (error) {
      return connectorFailure(reply, error);
    }
    deps.secrets.set(APP_ID_SECRET, creds.applicationId);
    deps.secrets.set(APP_KEY_SECRET, creds.privateKey);
    audit.log({ actor: 'owner', action: 'enable_banking.app_configured' });
    return reply.send({ configured: true, applicationId: creds.applicationId, redirectUrl: redirectUrl(request) });
  });

  app.delete('/api/enable-banking/app', async (_request, reply) => {
    deps.secrets.delete(APP_ID_SECRET);
    deps.secrets.delete(APP_KEY_SECRET);
    audit.log({ actor: 'owner', action: 'enable_banking.app_removed' });
    return reply.send({ configured: false });
  });

  app.get('/api/enable-banking/aspsps', async (request, reply) => {
    const query = z.object({ country: z.string().length(2).default('FR') }).safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Pays invalide.');
    const creds = await credentials();
    if (!creds) return sendError(reply, 400, 'INVALID_REQUEST', 'Configurez d’abord votre application Enable Banking.');
    try {
      const aspsps = await new EnableBankingClient(http, creds, now).listAspsps(query.data.country.toUpperCase());
      return reply.send({
        aspsps: aspsps
          .map((aspsp) => ({ name: aspsp.name, country: aspsp.country, logo: aspsp.logo ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      });
    } catch (error) {
      return connectorFailure(reply, error);
    }
  });

  app.post('/api/enable-banking/authorize', async (request, reply) => {
    const parsed = z
      .object({
        aspspName: z.string().min(1).max(200),
        country: z.string().length(2),
        connectionId: z.string().max(64).optional().nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Banque invalide.');
    const creds = await credentials();
    if (!creds) return sendError(reply, 400, 'INVALID_REQUEST', 'Configurez d’abord votre application Enable Banking.');
    if (parsed.data.connectionId && !connections.get(parsed.data.connectionId)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Connexion introuvable.');
    }

    const client = new EnableBankingClient(http, creds, now);
    const country = parsed.data.country.toUpperCase();
    let consentSeconds = DEFAULT_CONSENT_DAYS * 86_400;
    try {
      const aspsp = (await client.listAspsps(country)).find((row) => row.name === parsed.data.aspspName);
      if (aspsp?.maximum_consent_validity) consentSeconds = Math.min(consentSeconds, aspsp.maximum_consent_validity);
    } catch {
      /* durée par défaut */
    }
    const state = randomBytes(24).toString('base64url');
    try {
      const { url } = await client.startAuthorization({
        aspspName: parsed.data.aspspName,
        country,
        redirectUrl: redirectUrl(request),
        state,
        validUntil: new Date(now().getTime() + consentSeconds * 1000),
      });
      settings.setJson(PENDING_KEY, {
        ...pending(),
        [state]: {
          aspspName: parsed.data.aspspName,
          country,
          connectionId: parsed.data.connectionId ?? null,
          createdAt: now().toISOString(),
        } satisfies PendingAuthorization,
      });
      return reply.send({ url });
    } catch (error) {
      return connectorFailure(reply, error);
    }
  });

  app.post('/api/enable-banking/complete', async (request, reply) => {
    const parsed = z
      .object({
        code: z.string().max(4000).optional(),
        state: z.string().max(200).optional(),
        /** Adresse complète de retour, collée par l'utilisateur (repli). */
        returnUrl: z.string().max(8000).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Retour de la banque invalide.');

    let code = parsed.data.code ?? null;
    let state = parsed.data.state ?? null;
    if (parsed.data.returnUrl) {
      try {
        const url = new URL(parsed.data.returnUrl.trim());
        code = url.searchParams.get('code') ?? code;
        state = url.searchParams.get('state') ?? state;
        const bankError = url.searchParams.get('error');
        if (bankError) {
          return sendError(reply, 400, 'INVALID_REQUEST', `La banque a refusé l’accès (${bankError}).`);
        }
      } catch {
        return sendError(reply, 400, 'INVALID_REQUEST', 'Adresse de retour illisible : copiez-la en entier.');
      }
    }
    if (!code || !state) return sendError(reply, 400, 'INVALID_REQUEST', 'Code ou état de retour manquant.');

    const all = pending();
    const entry = all[state];
    if (!entry) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Autorisation inconnue ou trop ancienne : recommencez depuis Connexions.');
    }
    const creds = await credentials();
    if (!creds) return sendError(reply, 400, 'INVALID_REQUEST', 'Application Enable Banking non configurée.');

    let session;
    try {
      session = await new EnableBankingClient(http, creds, now).createSession(code);
    } catch (error) {
      return connectorFailure(reply, error);
    }
    const { [state]: _used, ...rest } = all;
    settings.setJson(PENDING_KEY, rest);

    const config = { aspsp_name: entry.aspspName, aspsp_country: entry.country };
    let connectionId = entry.connectionId;
    if (connectionId && connections.get(connectionId)) {
      connections.updateConfig(connectionId, config, ['enablebanking_session_id']);
    } else {
      connectionId = connections.create({
        providerId: 'enable_banking',
        label: entry.aspspName,
        config,
        secretNames: ['enablebanking_session_id'],
      }).id;
    }
    deps.secrets.set(`${connectionId}:enablebanking_session_id`, session.session_id);
    audit.log({
      actor: 'owner',
      action: 'enable_banking.session_created',
      entity: 'connection',
      entityId: connectionId,
      details: { aspsp: entry.aspspName, accounts: session.accounts.length },
    });

    let outcome = null;
    try {
      outcome = await deps.sync.syncConnection(connectionId, 'MANUAL');
    } catch (error) {
      deps.logger.warn('Première synchronisation bancaire impossible', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return reply.send({
      connectionId,
      bank: entry.aspspName,
      accounts: session.accounts.length,
      validUntil: session.access?.valid_until ?? null,
      sync: outcome === null ? null : { status: outcome.status, message: outcome.message, created: outcome.created },
    });
  });
}
