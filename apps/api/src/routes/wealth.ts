import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccountDto, PeriodKey } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository, type AccountRow } from '../repositories/accounts.ts';
import { ActivityRepository, ValuationRepository } from '../repositories/activities.ts';
import type { PropertyRepository } from '../repositories/properties.ts';
import type { CryptoService } from '../services/crypto.ts';
import type { PortfolioService } from '../services/portfolio.ts';
import type { RealEstateService } from '../services/realestate.ts';
import { sendError } from './auth.ts';

/**
 * Routes de patrimoine : tout ce qui est en lecture (plus la gestion manuelle
 * des comptes et des biens). Aucune route de cette application ne permet de
 * passer un ordre, de virer des fonds ou de signer une transaction.
 */

/**
 * Convertit une ligne SQL (snake_case) en DTO (camelCase).
 * Aucune ligne brute ne doit atteindre le client : cela évite de figer les noms
 * de colonnes dans le contrat et de fuiter des champs internes.
 */
function toAccountDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    providerId: row.provider_id,
    currency: row.currency,
    initialBalance: row.initial_balance,
    isActive: row.is_active === 1,
    externalAccountId: row.external_account_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WealthRoutesDeps {
  readonly db: Db;
  readonly portfolio: PortfolioService;
  readonly crypto: CryptoService;
  readonly realEstate: RealEstateService;
  readonly properties: PropertyRepository;
}

const periodSchema = z.enum(['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'MAX']).default('1Y');

const accountSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['SECURITIES', 'CASH', 'CRYPTO', 'REAL_ESTATE', 'LIABILITY', 'OTHER']),
  providerId: z.enum([
    'degiro',
    'trade_republic',
    'credit_agricole',
    'revolut',
    'metamask',
    'enable_banking',
    'bitcoin',
    'solana',
    'binance',
    'kraken',
    'coinbase',
    'bitpanda',
    'manual',
    'csv',
  ]),
  currency: z.string().length(3).toUpperCase(),
  initialBalance: z.number().finite().optional(),
  notes: z.string().max(2000).optional(),
});

const propertySchema = z.object({
  accountId: z.string().optional(),
  name: z.string().min(1).max(160),
  kind: z.string().min(1).max(60),
  address: z.string().max(300).nullable().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  purchasePrice: z.number().min(0),
  notaryFees: z.number().min(0).optional(),
  agencyFees: z.number().min(0).optional(),
  initialWorks: z.number().min(0).optional(),
  surfaceM2: z.number().min(0).nullable().optional(),
  currentValue: z.number().min(0),
  notes: z.string().max(4000).nullable().optional(),
  loan: z
    .object({
      loanType: z.enum(['AMORTIZABLE', 'IN_FINE', 'VARIABLE', 'OTHER']),
      principal: z.number().min(0),
      annualRate: z.number().min(0).max(30),
      months: z.number().int().min(1).max(600),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      monthlyPayment: z.number().min(0).optional(),
      insuranceMonthly: z.number().min(0).optional(),
    })
    .nullable()
    .optional(),
});

const cashFlowSchema = z.object({
  direction: z.enum(['INCOME', 'EXPENSE']),
  category: z.enum([
    'RENT',
    'RENT_CHARGES',
    'OTHER_INCOME',
    'PROPERTY_TAX',
    'PNO_INSURANCE',
    'LOAN_INSURANCE',
    'CONDO_FEES',
    'WORKS',
    'MAINTENANCE',
    'AGENCY',
    'ACCOUNTANT',
    'BANK_FEES',
    'VACANCY',
    'CUSTOM',
  ]),
  label: z.string().min(1).max(120),
  amount: z.number().min(0),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recurrence: z.enum(['ONE_OFF', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  received: z.boolean().optional(),
});

const transactionsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  providerId: z.string().optional(),
  accountId: z.string().optional(),
  type: z.string().optional(),
  currency: z.string().optional(),
  minAmount: z.coerce.number().optional(),
  maxAmount: z.coerce.number().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

export async function registerWealthRoutes(app: FastifyInstance, deps: WealthRoutesDeps): Promise<void> {
  const accounts = new AccountRepository(deps.db);

  app.get('/api/networth', async (request, reply) => {
    const query = z.object({ period: periodSchema.optional() }).parse(request.query);
    return reply.send(deps.portfolio.netWorth((query.period ?? '1Y') as PeriodKey));
  });

  app.get('/api/accounts', async (_request, reply) => reply.send(deps.portfolio.accounts()));

  app.post('/api/accounts', async (request, reply) => {
    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Compte invalide.', parsed.error.flatten());
    }
    const account = accounts.create({
      name: parsed.data.name,
      type: parsed.data.type,
      providerId: parsed.data.providerId,
      currency: parsed.data.currency,
      initialBalance: parsed.data.initialBalance ?? 0,
      notes: parsed.data.notes ?? null,
    });
    return reply.code(201).send(toAccountDto(account));
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = accountSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Modification invalide.');
    }
    const updated = accounts.update(id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
      ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    });
    if (!updated) return sendError(reply, 404, 'NOT_FOUND', 'Compte introuvable.');
    return reply.send(toAccountDto(updated));
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const withActivities = deps.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM activities WHERE account_id = ?',
      id,
    );
    if ((withActivities?.count ?? 0) > 0) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        `Ce compte contient ${withActivities?.count} opération(s). Désactivez-le plutôt que de le supprimer, ` +
          'ou supprimez explicitement ses opérations.',
      );
    }
    if (!accounts.delete(id)) return sendError(reply, 404, 'NOT_FOUND', 'Compte introuvable.');
    return reply.code(204).send();
  });

  app.get('/api/investments', async (request, reply) => {
    const query = z.object({ accountId: z.string().optional() }).parse(request.query);
    return reply.send(deps.portfolio.investments(query.accountId));
  });

  app.get('/api/crypto', async (_request, reply) => reply.send(deps.crypto.crypto()));

  app.get('/api/real-estate', async (_request, reply) => reply.send(deps.realEstate.list()));

  app.get('/api/real-estate/:accountId', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const property = deps.realEstate.get(accountId);
    if (!property) return sendError(reply, 404, 'NOT_FOUND', 'Bien introuvable.');
    return reply.send(property);
  });

  app.post('/api/real-estate', async (request, reply) => {
    const parsed = propertySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Bien invalide.', parsed.error.flatten());
    }
    const data = parsed.data;
    const accountId = deps.realEstate.ensureAccount({
      ...(data.accountId ? { accountId: data.accountId } : {}),
      name: data.name,
      currency: 'EUR',
    });
    deps.properties.upsert({
      accountId,
      name: data.name,
      kind: data.kind,
      address: data.address ?? null,
      purchaseDate: data.purchaseDate ?? null,
      purchasePrice: data.purchasePrice,
      notaryFees: data.notaryFees ?? 0,
      agencyFees: data.agencyFees ?? 0,
      initialWorks: data.initialWorks ?? 0,
      surfaceM2: data.surfaceM2 ?? null,
      currentValue: data.currentValue,
      notes: data.notes ?? null,
    });
    if (data.loan) {
      deps.properties.upsertLoan(accountId, {
        loanType: data.loan.loanType,
        principal: data.loan.principal,
        annualRate: data.loan.annualRate,
        months: data.loan.months,
        startDate: data.loan.startDate,
        monthlyPayment: data.loan.monthlyPayment ?? 0,
        insuranceMonthly: data.loan.insuranceMonthly ?? 0,
      });
    }
    deps.properties.addAppraisal(accountId, new Date().toISOString().slice(0, 10), data.currentValue, 'Valeur initiale');
    return reply.code(201).send(deps.realEstate.get(accountId));
  });

  app.patch('/api/real-estate/:accountId', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const existing = deps.properties.load(accountId);
    if (!existing) return sendError(reply, 404, 'NOT_FOUND', 'Bien introuvable.');
    const parsed = propertySchema.partial().safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Modification invalide.');
    const data = parsed.data;
    deps.properties.upsert({
      accountId,
      name: data.name ?? existing.details.name,
      kind: data.kind ?? existing.details.kind,
      address: data.address === undefined ? existing.details.address : data.address,
      purchaseDate: data.purchaseDate === undefined ? existing.details.purchaseDate : data.purchaseDate,
      purchasePrice: data.purchasePrice ?? existing.details.purchasePrice,
      notaryFees: data.notaryFees ?? existing.details.notaryFees,
      agencyFees: data.agencyFees ?? existing.details.agencyFees,
      initialWorks: data.initialWorks ?? existing.details.initialWorks,
      surfaceM2: data.surfaceM2 === undefined ? existing.details.surfaceM2 : data.surfaceM2,
      currentValue: data.currentValue ?? existing.details.currentValue,
      notes: data.notes === undefined ? existing.details.notes : data.notes,
    });
    if (data.currentValue !== undefined && data.currentValue !== existing.details.currentValue) {
      // Toute nouvelle estimation est historisée : l'évolution de la valeur est
      // une donnée, elle ne doit pas être écrasée silencieusement.
      deps.properties.addAppraisal(
        accountId,
        new Date().toISOString().slice(0, 10),
        data.currentValue,
        'Réévaluation manuelle',
      );
    }
    if (data.loan === null) deps.properties.deleteLoan(accountId);
    if (data.loan) {
      deps.properties.upsertLoan(accountId, {
        loanType: data.loan.loanType,
        principal: data.loan.principal,
        annualRate: data.loan.annualRate,
        months: data.loan.months,
        startDate: data.loan.startDate,
        monthlyPayment: data.loan.monthlyPayment ?? 0,
        insuranceMonthly: data.loan.insuranceMonthly ?? 0,
      });
    }
    return reply.send(deps.realEstate.get(accountId));
  });

  app.delete('/api/real-estate/:accountId', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const loaded = deps.properties.load(accountId);
    if (!loaded) return sendError(reply, 404, 'NOT_FOUND', 'Bien introuvable.');
    deps.properties.delete(accountId);
    return reply.code(204).send();
  });

  app.post('/api/real-estate/:accountId/cashflows', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    if (!deps.properties.load(accountId)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Bien introuvable.');
    }
    const parsed = cashFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Mouvement invalide.', parsed.error.flatten());
    }
    const id = deps.properties.addCashFlow(accountId, {
      direction: parsed.data.direction,
      category: parsed.data.category,
      label: parsed.data.label,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      date: parsed.data.date,
      recurrence: parsed.data.recurrence,
      received: parsed.data.received ?? true,
    });
    return reply.code(201).send({ id, accountId });
  });

  app.delete('/api/real-estate/:accountId/cashflows/:cashFlowId', async (request, reply) => {
    const { accountId, cashFlowId } = z
      .object({ accountId: z.string(), cashFlowId: z.string() })
      .parse(request.params);
    if (!deps.properties.deleteCashFlow(accountId, cashFlowId)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Mouvement introuvable.');
    }
    return reply.code(204).send();
  });

  app.get('/api/transactions', async (request, reply) => {
    const parsed = transactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Filtres invalides.', parsed.error.flatten());
    }
    return reply.send(deps.portfolio.transactions(parsed.data));
  });

  app.get('/api/income', async (request, reply) => {
    const query = z.object({ period: periodSchema.optional() }).parse(request.query);
    return reply.send(deps.portfolio.income((query.period ?? '1Y') as PeriodKey));
  });

  app.get('/api/analytics', async (request, reply) => {
    const query = z.object({ period: periodSchema.optional() }).parse(request.query);
    return reply.send(deps.portfolio.analytics((query.period ?? '1Y') as PeriodKey));
  });

  app.post('/api/valuations', async (request, reply) => {
    const schema = z.object({
      accountId: z.string(),
      instrumentId: z.string().nullable().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      value: z.number(),
      currency: z.string().length(3).optional(),
      note: z.string().max(500).nullable().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'Valorisation invalide.');
    const account = accounts.get(parsed.data.accountId);
    if (!account) return sendError(reply, 404, 'NOT_FOUND', 'Compte introuvable.');
    new ValuationRepository(deps.db).upsert({
      accountId: parsed.data.accountId,
      instrumentId: parsed.data.instrumentId ?? null,
      date: parsed.data.date,
      value: parsed.data.value,
      currency: parsed.data.currency ?? account.currency,
      source: 'MANUAL',
      note: parsed.data.note ?? null,
    });
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/timeline/summary', async (request, reply) => {
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const activities = new ActivityRepository(deps.db);
    return reply.send({ byType: activities.sumByType(query) });
  });
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.code(204);
}