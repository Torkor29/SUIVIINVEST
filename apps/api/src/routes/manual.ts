import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ManualPositionDto, OkResponse } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository, InstrumentRepository } from '../repositories/accounts.ts';
import { ActivityRepository } from '../repositories/activities.ts';
import { AuditRepository } from '../repositories/connections.ts';
import { ValuationRepository } from '../repositories/activities.ts';
import { sendError } from './auth.ts';

/**
 * Saisie et correction manuelles d'une position.
 *
 * Pourquoi c'est nécessaire : certaines sources ne fournissent pas les positions
 * (Crédit Agricole notamment — `iter_investment` n'est pas porté côté outils
 * publics). Sans saisie manuelle, un patrimoine réel resterait incomplet.
 *
 * Choix de modélisation : une position saisie à la main est enregistrée comme un
 * **TRANSFER_IN** (un avoir que l'on possède déjà), et non comme un achat :
 *  - le prix de revient est conservé (donc le PRU et la plus-value sont justes) ;
 *  - aucune date d'achat fictive n'apparaît dans la timeline ;
 *  - aucune opération de marché inexistante n'est créée.
 *
 * Idempotence : la clé externe est déterministe
 * (`manual-position:<compte>:<isin|symbole>`), donc soumettre deux fois la même
 * position met à jour au lieu de dupliquer.
 */

export interface ManualRoutesDeps {
  readonly db: Db;
}

const positionSchema = z
  .object({
    accountId: z.string().min(1),
    isin: z
      .string()
      .regex(/^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/, 'ISIN invalide (12 caractères attendus)')
      .nullable()
      .optional(),
    symbol: z.string().min(1).max(32).nullable().optional(),
    name: z.string().min(1).max(160).optional(),
    quantity: z.number().positive(),
    averageCost: z.number().nonnegative(),
    currency: z.string().length(3).toUpperCase().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    kind: z.enum(['EQUITY', 'ETF', 'FUND', 'BOND', 'CRYPTO', 'CASH', 'REAL_ESTATE', 'OTHER']).optional(),
    exchange: z.string().max(16).nullable().optional(),
  })
  .refine((value) => Boolean(value.isin) || Boolean(value.symbol), {
    message: 'Renseignez au moins un ISIN ou un symbole pour identifier l\'instrument.',
  });

export async function registerManualRoutes(app: FastifyInstance, deps: ManualRoutesDeps): Promise<void> {
  const accounts = new AccountRepository(deps.db);
  const instruments = new InstrumentRepository(deps.db);
  const activities = new ActivityRepository(deps.db);
  const valuations = new ValuationRepository(deps.db);
  const audit = new AuditRepository(deps.db);

  /**
   * Crée ou met à jour une position saisie manuellement.
   * `PATCH` est un alias explicite : les deux passent par le même code.
   */
  const upsertPosition = (payload: unknown): { status: number; body: ManualPositionDto | ReturnType<typeof errorOf> } => {
    const parsed = positionSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 400,
        body: errorOf('INVALID_REQUEST', 'Position invalide.', parsed.error.flatten()),
      };
    }
    const data = parsed.data;
    const account = accounts.get(data.accountId);
    if (!account) {
      return { status: 404, body: errorOf('NOT_FOUND', 'Compte introuvable.') };
    }

    const instrument = instruments.upsert({
      kind: data.kind ?? 'EQUITY',
      name: data.name ?? data.isin ?? data.symbol ?? 'Instrument saisi',
      currency: data.currency ?? account.currency,
      isin: data.isin ?? null,
      symbol: data.symbol ?? null,
      exchange: data.exchange ?? null,
    });

    const date = data.date ?? new Date().toISOString().slice(0, 10);
    const costBasis = data.quantity * data.averageCost;
    const externalTransactionId = `manual-position:${account.id}:${(data.isin ?? data.symbol ?? instrument.id).toUpperCase()}`;

    // TRANSFER_IN : la quantité ET le prix de revient entrent, sans créer d'achat.
    const result = activities.write({
      accountId: account.id,
      instrumentId: instrument.id,
      type: 'TRANSFER_IN',
      date,
      quantity: data.quantity,
      unitPrice: data.averageCost,
      amount: -costBasis,
      currency: data.currency ?? account.currency,
      fees: 0,
      taxes: 0,
      description: 'Position saisie manuellement',
      providerId: 'manual',
      externalAccountId: account.external_account_id,
      externalTransactionId,
      externalAssetId: data.isin ?? data.symbol ?? null,
      rawSourceType: 'manual.position',
      syncRunId: null,
      importId: null,
      lastSyncedAt: new Date().toISOString(),
    });

    // La valorisation manuelle du jour rend la position visible immédiatement,
    // même sans cours de marché disponible.
    valuations.upsert({
      accountId: account.id,
      instrumentId: instrument.id,
      date,
      value: costBasis,
      currency: data.currency ?? account.currency,
      source: 'MANUAL',
      note: 'Position saisie manuellement',
    });

    audit.log({
      actor: 'owner',
      action: result.outcome === 'CREATED' ? 'manual.position.create' : 'manual.position.update',
      entity: 'activity',
      entityId: result.id,
      details: {
        accountId: account.id,
        isin: data.isin ?? null,
        symbol: data.symbol ?? null,
        quantity: data.quantity,
        averageCost: data.averageCost,
      },
    });

    return {
      status: result.outcome === 'CREATED' ? 201 : 200,
      body: {
        activityId: result.id,
        accountId: account.id,
        instrumentId: instrument.id,
        isin: instrument.isin,
        symbol: instrument.symbol,
        name: instrument.name,
        quantity: data.quantity,
        averageCost: data.averageCost,
        costBasis,
        currency: data.currency ?? account.currency,
        date,
        outcome: result.outcome,
      },
    };
  };

  app.post('/api/manual/positions', async (request, reply) => {
    const { status, body } = upsertPosition(request.body);
    return reply.code(status).send(body);
  });

  app.patch('/api/manual/positions', async (request, reply) => {
    const { status, body } = upsertPosition(request.body);
    return reply.code(status).send(body);
  });

  /** Suppression d'une position saisie manuellement (par l'identifiant d'activité). */
  app.delete('/api/manual/positions/:activityId', async (request, reply) => {
    const { activityId } = z.object({ activityId: z.string() }).parse(request.params);
    const existing = activities.byId(activityId);
    if (!existing) return sendError(reply, 404, 'NOT_FOUND', 'Position introuvable.');
    if (existing.raw_source_type !== 'manual.position') {
      return sendError(
        reply,
        409,
        'CONFLICT',
        'Seules les positions saisies manuellement peuvent être supprimées ici : ' +
          'cette ligne provient d\'une source synchronisée et doit être corrigée à la source.',
      );
    }
    deps.db.run('DELETE FROM activities WHERE id = ?', activityId);
    audit.log({
      actor: 'owner',
      action: 'manual.position.delete',
      entity: 'activity',
      entityId: activityId,
    });
    const payload: OkResponse = { ok: true };
    return reply.code(200).send(payload);
  });

  /** Liste les positions saisies manuellement, pour les afficher et les corriger. */
  app.get('/api/manual/positions', async (_request, reply) => {
    const rows = deps.db.all<{
      id: string;
      account_id: string;
      instrument_id: string | null;
      date: string;
      quantity: number | null;
      unit_price: number | null;
      currency: string;
    }>(
      `SELECT id, account_id, instrument_id, date, quantity, unit_price, currency
         FROM activities WHERE raw_source_type = 'manual.position' ORDER BY date DESC, id DESC`,
    );
    const body: ManualPositionDto[] = rows.map((row) => {
      const instrument = row.instrument_id ? instruments.get(row.instrument_id) : null;
      const quantity = row.quantity ?? 0;
      const averageCost = row.unit_price ?? 0;
      return {
        activityId: row.id,
        accountId: row.account_id,
        instrumentId: row.instrument_id ?? '',
        isin: instrument?.isin ?? null,
        symbol: instrument?.symbol ?? null,
        name: instrument?.name ?? 'Instrument saisi',
        quantity,
        averageCost,
        costBasis: Math.round(quantity * averageCost * 1e8) / 1e8,
        currency: row.currency,
        date: row.date,
        outcome: null,
      };
    });
    return reply.send(body);
  });
}

interface ErrorPayload {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

function errorOf(code: string, message: string, details?: unknown): ErrorPayload {
  return { error: { code, message, ...(details ? { details } : {}) } };
}