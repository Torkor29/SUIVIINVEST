import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AssetSearchResponse, PeriodKey } from '@suiviinvest/api-contract';
import { HoldingsError, type HoldingsService } from '../services/holdings.ts';
import type { AuditRepository } from '../repositories/connections.ts';
import { sendError } from './auth.ts';

/**
 * Portefeuille saisi à la main : recherche d'actifs, ajout, achats/ventes,
 * investissements programmés, détail et courbes.
 */

export interface HoldingsRoutesDeps {
  readonly holdings: HoldingsService;
  readonly audit: AuditRepository;
}

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');
const KIND = z.enum(['EQUITY', 'ETF', 'FUND', 'BOND', 'CRYPTO', 'OTHER']);
const PERIOD = z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'MAX']).default('1Y');
const CURRENCY = z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase());

const assetSchema = z.object({
  source: z.enum(['onvista', 'yahoo', 'coingecko', 'manual']),
  priceSymbol: z.string().min(1).max(64).optional(),
  symbol: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(160),
  kind: KIND,
  isin: z.string().regex(/^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/).nullable().optional(),
  exchange: z.string().max(40).nullable().optional(),
  currency: CURRENCY.optional(),
  /** Source « manual » : premier cours connu. */
  price: z.number().positive().optional(),
  priceDate: DAY.optional(),
});

const operationSchema = z.object({
  instrumentId: z.string().min(1),
  type: z.enum(['BUY', 'SELL']),
  date: DAY,
  quantity: z.number().positive().optional(),
  amount: z.number().positive().optional(),
  unitPrice: z.number().positive().optional(),
  currency: CURRENCY.optional(),
  fees: z.number().min(0).optional(),
});

const planSchema = z.object({
  instrumentId: z.string().min(1),
  amount: z.number().positive(),
  currency: CURRENCY,
  frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY']),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  startDate: DAY,
  endDate: DAY.nullable().optional(),
  fees: z.number().min(0).optional(),
  active: z.boolean().optional(),
});

export async function registerHoldingsRoutes(app: FastifyInstance, deps: HoldingsRoutesDeps): Promise<void> {
  const { holdings, audit } = deps;

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HoldingsError) return sendError(reply, error.status, error.code, error.message);
    if (error instanceof z.ZodError) {
      return sendError(reply, 400, 'INVALID_REQUEST', error.issues[0]?.message ?? 'Requête invalide.');
    }
    throw error;
  };

  app.get('/api/holdings/search', async (request, reply) => {
    const { q } = z.object({ q: z.string().max(80).default('') }).parse(request.query);
    const outcome = await holdings.client.search(q);
    const body: AssetSearchResponse = outcome;
    return reply.send(body);
  });

  app.get('/api/holdings', async (_request, reply) => reply.send(holdings.overview()));

  app.get('/api/holdings/history', async (request, reply) => {
    const { period } = z.object({ period: PERIOD }).parse(request.query);
    return reply.send(holdings.history(period as PeriodKey));
  });

  app.get('/api/holdings/assets/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { period } = z.object({ period: PERIOD }).parse(request.query);
      return reply.send(holdings.detail(id, period as PeriodKey));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/holdings/assets', async (request, reply) => {
    try {
      const input = assetSchema.parse(request.body);
      const result = await holdings.addAsset(input);
      if (input.source === 'manual' && input.price !== undefined) {
        await holdings.setManualPrice(
          result.asset.instrumentId,
          input.priceDate ?? new Date().toISOString().slice(0, 10),
          input.price,
          input.currency ?? 'EUR',
        );
      }
      audit.log({ actor: 'owner', action: 'holdings.asset.add', entity: 'instrument', entityId: result.asset.instrumentId });
      return reply.code(201).send(result);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/holdings/assets/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const result = holdings.deleteAsset(id);
      audit.log({ actor: 'owner', action: 'holdings.asset.delete', entity: 'instrument', entityId: id });
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/holdings/assets/:id/price', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z.object({ date: DAY, price: z.number().positive(), currency: CURRENCY.optional() }).parse(request.body);
      await holdings.setManualPrice(id, body.date, body.price, body.currency ?? 'EUR');
      await holdings.runPlans();
      return reply.send({ ok: true });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/holdings/operations', async (request, reply) => {
    try {
      const input = operationSchema.parse(request.body);
      const operation = await holdings.addOperation(input);
      audit.log({ actor: 'owner', action: 'holdings.operation.add', entity: 'activity', entityId: operation.id });
      return reply.code(201).send(operation);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/holdings/operations/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      holdings.deleteOperation(id);
      audit.log({ actor: 'owner', action: 'holdings.operation.delete', entity: 'activity', entityId: id });
      return reply.send({ ok: true });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/holdings/plans', async (_request, reply) => reply.send(holdings.listPlans()));

  app.post('/api/holdings/plans', async (request, reply) => {
    try {
      const plan = await holdings.createPlan(planSchema.parse(request.body));
      audit.log({ actor: 'owner', action: 'holdings.plan.create', entity: 'dca_plan', entityId: plan.id });
      return reply.code(201).send(plan);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/holdings/plans/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const patch = planSchema.omit({ instrumentId: true }).partial().parse(request.body);
      const plan = await holdings.updatePlan(id, patch);
      audit.log({ actor: 'owner', action: 'holdings.plan.update', entity: 'dca_plan', entityId: id });
      return reply.send(plan);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/holdings/plans/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { removeOperations } = z
        .object({ removeOperations: z.enum(['true', 'false']).default('false') })
        .parse(request.query);
      holdings.deletePlan(id, { removeOperations: removeOperations === 'true' });
      audit.log({ actor: 'owner', action: 'holdings.plan.delete', entity: 'dca_plan', entityId: id });
      return reply.send({ ok: true });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/holdings/refresh', async (_request, reply) => {
    const result = await holdings.refreshAll();
    return reply.send(result);
  });
}
