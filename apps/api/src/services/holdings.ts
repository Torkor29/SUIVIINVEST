import { randomUUID } from 'node:crypto';
import { computePositions, round, startOfPeriod, sum, type AssetKind } from '@suiviinvest/core';
import type {
  AddAssetRequest,
  AllocationSlice,
  DcaPlanDto,
  DcaPlanRequest,
  HoldingAssetDto,
  HoldingDetailResponse,
  HoldingKind,
  HoldingOperationDto,
  HoldingOperationRequest,
  HoldingPositionDto,
  HoldingPriceSource,
  HoldingsHistoryResponse,
  HoldingsResponse,
  HoldingValuePoint,
  PeriodKey,
} from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository, InstrumentRepository, type AccountRow, type InstrumentRow } from '../repositories/accounts.ts';
import { ActivityRepository, toDomainActivity, ValuationRepository, type ActivityRow } from '../repositories/activities.ts';
import { MarketRepository } from '../repositories/market.ts';
import {
  convertToEur,
  kindLabel,
  MarketClient,
  priceOnOrAfter,
  priceOnOrBefore,
  shiftDay,
  type PricePoint,
} from './market-client.ts';

/**
 * Portefeuille saisi à la main.
 *
 * L'utilisateur déclare ce qu'il possède ; l'application suit les cours.
 *
 *  - Deux comptes sont créés au besoin : « Mes investissements » (titres) et
 *    « Mes cryptos ». Ce sont des comptes ordinaires : patrimoine, tableau de
 *    bord et courbes les prennent en compte sans code particulier.
 *  - Les cours sont stockés **en euros** dans `quotes` (convertis au taux du
 *    jour de chaque cours) : la valorisation existante (quantité × cours) reste
 *    juste quelle que soit la devise de cotation.
 *  - Achat, vente, position existante : une activité `BUY`/`SELL` en euros.
 *  - Investissement programmé (DCA) : chaque échéance passée devient un achat
 *    au cours de clôture du jour (ou du jour de bourse suivant), en fractions de
 *    titre. Identifiant `dca:<plan>:<échéance>` : relancer ne crée pas de doublon.
 */

export const MANUAL_SECURITIES_ID = 'manual-portfolio';
export const MANUAL_CRYPTO_ID = 'manual-crypto';

const INVESTMENT_ACCOUNT_TYPES = new Set(['SECURITIES', 'CRYPTO', 'OTHER']);
const POSITION_TYPES = new Set(['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'CRYPTO_TRANSFER', 'STAKING_REWARD', 'SPLIT']);
/** Historique chargé à l'ajout d'un actif (pour les courbes « Max »). */
const HISTORY_START: Readonly<Record<'yahoo' | 'coingecko', string>> = { yahoo: '2000-01-01', coingecko: '2014-01-01' };
/** Au-delà, une échéance sans cours est considérée comme « en attente ». */
const MAX_SETTLEMENT_DAYS = 10;

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  BUY: 'Achat',
  SELL: 'Vente',
  TRANSFER_IN: 'Entrée',
  TRANSFER_OUT: 'Sortie',
  CRYPTO_TRANSFER: 'Transfert',
  STAKING_REWARD: 'Récompense',
  SPLIT: 'Division',
};

export class HoldingsError extends Error {
  readonly status: number;
  readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'CONNECTOR_ERROR';
  constructor(status: number, code: HoldingsError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface DcaPlanRow {
  id: string;
  instrument_id: string;
  account_id: string;
  amount: number;
  currency: string;
  frequency: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
  day_of_month: number;
  weekday: number | null;
  start_date: string;
  end_date: string | null;
  fees: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface Aggregate {
  instrumentId: string;
  quantity: number;
  invested: number;
  realized: number;
  editable: boolean;
  accounts: Set<string>;
}

export interface HoldingsServiceOptions {
  readonly client?: MarketClient;
  readonly now?: () => Date;
}

export class HoldingsService {
  readonly #db: Db;
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #valuations: ValuationRepository;
  readonly #market: MarketRepository;
  readonly #client: MarketClient;
  readonly #now: () => Date;

  constructor(db: Db, options: HoldingsServiceOptions = {}) {
    this.#db = db;
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#valuations = new ValuationRepository(db);
    this.#market = new MarketRepository(db);
    this.#now = options.now ?? (() => new Date());
    this.#client = options.client ?? new MarketClient({ now: this.#now });
  }

  get client(): MarketClient {
    return this.#client;
  }

  /* ================================================================ actifs */

  /** Ajoute (ou retrouve) un actif et charge son historique de cours. */
  async addAsset(input: AddAssetRequest): Promise<{ asset: HoldingAssetDto; quotes: number; warning: string | null }> {
    const kind = normalizeKind(input.kind);
    const source: HoldingPriceSource = input.source;
    if (source !== 'manual' && !input.priceSymbol) {
      throw new HoldingsError(400, 'INVALID_REQUEST', 'Symbole de cotation manquant.');
    }
    const symbol = (input.symbol ?? input.priceSymbol ?? '').trim() || null;
    // Un actif coté est identifié par sa source + son symbole : deux cryptos
    // homonymes (« SOL ») ne sont jamais confondues.
    const existing =
      source === 'manual'
        ? null
        : this.#db.get<InstrumentRow>(
            'SELECT * FROM instruments WHERE price_source = ? AND price_symbol = ?',
            source,
            input.priceSymbol ?? null,
          );
    let instrument: InstrumentRow;
    if (existing) {
      instrument = existing;
    } else {
      const byIsin = input.isin ? this.#instruments.findByIsin(input.isin.toUpperCase()) : null;
      instrument =
        byIsin ??
        this.#insertInstrument({
          kind,
          name: input.name.trim(),
          symbol: symbol ? symbol.toUpperCase() : null,
          isin: input.isin?.toUpperCase() ?? null,
          exchange: input.exchange ?? null,
          currency: source === 'manual' ? (input.currency ?? 'EUR').toUpperCase() : 'EUR',
        });
      this.#db.run(
        'UPDATE instruments SET price_source = ?, price_symbol = ?, kind = ?, updated_at = ? WHERE id = ?',
        source,
        source === 'manual' ? null : (input.priceSymbol ?? null),
        kind,
        this.#now().toISOString(),
        instrument.id,
      );
    }
    let quotes = 0;
    let warning: string | null = null;
    if (source !== 'manual') {
      const result = await this.refreshInstrument(instrument.id, { full: true });
      quotes = result.quotes;
      warning = result.error;
    }
    return { asset: this.#assetDto(this.#requireInstrument(instrument.id)), quotes, warning };
  }

  /** Recharge les cours d'un actif (intégralement, ou seulement les derniers jours). */
  async refreshInstrument(instrumentId: string, options: { full?: boolean; from?: string } = {}): Promise<{ quotes: number; error: string | null }> {
    const instrument = this.#requireInstrument(instrumentId);
    const source = instrument.price_source as HoldingPriceSource | null;
    if (!source || source === 'manual' || !instrument.price_symbol) return { quotes: 0, error: null };
    const last = this.#db.get<{ date: string }>(
      'SELECT MAX(date) AS date FROM quotes WHERE instrument_id = ?',
      instrumentId,
    )?.date;
    const from =
      options.from ??
      (options.full || !last ? HISTORY_START[source] : shiftDay(last, -7));
    const history = await this.#client.history(source, instrument.price_symbol, from);
    if (!history || history.points.length === 0) {
      return { quotes: 0, error: `Cours indisponibles pour ${instrument.name} (source momentanément injoignable).` };
    }
    const rates = await this.#client.ratesToEur(history.currency, history.points[0]?.date ?? from);
    const converted = convertToEur(history.points, rates);
    if (!converted) {
      return { quotes: 0, error: `Taux ${history.currency}/EUR indisponible : cours de ${instrument.name} non convertis.` };
    }
    const fetchedAt = this.#now().toISOString();
    const count = this.#market.upsertQuotes(
      converted.map((point) => ({
        instrumentId,
        date: point.date,
        close: round(point.close, 8),
        currency: 'EUR',
        provider: history.provider,
        fetchedAt,
      })),
    );
    this.#db.run(
      'UPDATE instruments SET quote_currency = ?, updated_at = ? WHERE id = ?',
      history.currency,
      fetchedAt,
      instrumentId,
    );
    return { quotes: count, error: null };
  }

  /** Cours saisi à la main (obligation, fonds non coté…), en euros ou dans `currency`. */
  async setManualPrice(instrumentId: string, date: string, price: number, currency = 'EUR'): Promise<void> {
    const instrument = this.#requireInstrument(instrumentId);
    if (!(price > 0)) throw new HoldingsError(400, 'INVALID_REQUEST', 'Le cours doit être positif.');
    const rate = await this.#rateOn(currency, date);
    this.#market.upsertQuotes([
      {
        instrumentId: instrument.id,
        date,
        close: round(price * rate, 8),
        currency: 'EUR',
        provider: 'manual',
        fetchedAt: this.#now().toISOString(),
      },
    ]);
  }

  /**
   * Rafraîchit les cours de tous les actifs suivis, puis calcule les échéances
   * programmées devenues exécutables.
   */
  async refreshAll(): Promise<{ instruments: number; quotes: number; errors: string[]; executions: number }> {
    const rows = this.#db.all<{ id: string }>(
      `SELECT id FROM instruments WHERE price_source IN ('yahoo','coingecko') AND price_symbol IS NOT NULL`,
    );
    let quotes = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const result = await this.refreshInstrument(row.id).catch((error: unknown) => ({
        quotes: 0,
        error: error instanceof Error ? error.message : String(error),
      }));
      quotes += result.quotes;
      if (result.error) errors.push(result.error);
    }
    const plans = await this.runPlans();
    return { instruments: rows.length, quotes, errors, executions: plans.created };
  }

  /* ============================================================ opérations */

  async addOperation(input: HoldingOperationRequest): Promise<HoldingOperationDto> {
    const instrument = this.#requireInstrument(input.instrumentId);
    const account = this.#accountFor(instrument);
    const currency = (input.currency ?? 'EUR').toUpperCase();
    const date = input.date;
    // Un jour de marge : le serveur compte en UTC, le navigateur en heure locale
    // (juste après minuit à Paris, « aujourd'hui » est encore la veille en UTC).
    if (date > shiftDay(this.#today(), 1)) {
      throw new HoldingsError(400, 'INVALID_REQUEST', 'La date ne peut pas être dans le futur.');
    }
    const rate = await this.#rateOn(currency, date);
    const fees = round((input.fees ?? 0) * rate, 8);

    let unitPrice: number | null = input.unitPrice !== undefined ? round(input.unitPrice * rate, 8) : null;
    if (unitPrice === null) {
      const quotes = this.#quotes(instrument.id);
      const onDay = priceOnOrBefore(quotes, date) ?? priceOnOrAfter(quotes, date);
      if (!onDay) {
        throw new HoldingsError(
          400,
          'INVALID_REQUEST',
          'Aucun cours connu à cette date : indiquez le prix payé par titre.',
        );
      }
      unitPrice = onDay.close;
    }
    if (!(unitPrice > 0)) throw new HoldingsError(400, 'INVALID_REQUEST', 'Prix unitaire invalide.');

    let quantity: number;
    if (input.quantity !== undefined && input.quantity > 0) {
      quantity = input.quantity;
    } else if (input.amount !== undefined && input.amount > 0) {
      quantity = round((input.amount * rate) / unitPrice, 8);
    } else {
      throw new HoldingsError(400, 'INVALID_REQUEST', 'Indiquez une quantité ou un montant.');
    }
    if (!(quantity > 0)) throw new HoldingsError(400, 'INVALID_REQUEST', 'Quantité nulle.');

    if (input.type === 'SELL') {
      const held = this.#quantityHeld(instrument.id, account.id, date);
      if (quantity > held + 1e-9) {
        throw new HoldingsError(
          400,
          'INVALID_REQUEST',
          `Vente impossible : ${formatQty(held)} détenu(s) à cette date dans « ${account.name} ».`,
        );
      }
    }

    const gross = round(quantity * unitPrice, 8);
    const amount = input.type === 'BUY' ? -round(gross + fees, 8) : round(gross - fees, 8);
    const result = this.#activities.write({
      accountId: account.id,
      instrumentId: instrument.id,
      type: input.type,
      date,
      quantity,
      unitPrice,
      amount,
      currency: 'EUR',
      fees,
      taxes: 0,
      description: `${input.type === 'BUY' ? 'Achat' : 'Vente'} ${instrument.name}`,
      providerId: 'manual',
      externalAccountId: account.external_account_id,
      externalTransactionId: `manual-op:${randomUUID()}`,
      externalAssetId: instrument.symbol ?? instrument.isin,
      rawSourceType: 'manual.operation',
      syncRunId: null,
      importId: null,
      lastSyncedAt: this.#now().toISOString(),
    });
    const row = this.#activities.byId(result.id) as ActivityRow;
    return this.#operationDto(row, account);
  }

  deleteOperation(activityId: string): void {
    const row = this.#activities.byId(activityId);
    if (!row) throw new HoldingsError(404, 'NOT_FOUND', 'Opération introuvable.');
    if (row.provider_id !== 'manual' || !(row.raw_source_type ?? '').startsWith('manual.')) {
      throw new HoldingsError(
        409,
        'CONFLICT',
        'Cette opération provient d’une source synchronisée : elle se corrige à la source.',
      );
    }
    if (row.type === 'BUY' && row.instrument_id) {
      // Supprimer un achat ne doit pas rendre une vente ultérieure impossible.
      const remaining = this.#db
        .all<ActivityRow>('SELECT * FROM activities WHERE account_id = ? AND instrument_id = ? AND id != ?', row.account_id, row.instrument_id, row.id);
      try {
        const account = this.#accounts.get(row.account_id) as AccountRow;
        computePositions({ activities: remaining.map((item) => toDomainActivity(item, account.currency)), currency: account.currency });
      } catch {
        throw new HoldingsError(409, 'CONFLICT', 'Supprimez d’abord la vente qui dépend de cet achat.');
      }
    }
    this.#db.run('DELETE FROM activities WHERE id = ?', activityId);
  }

  /* ================================================== investissements programmés */

  async createPlan(input: DcaPlanRequest): Promise<DcaPlanDto> {
    const instrument = this.#requireInstrument(input.instrumentId);
    const account = this.#accountFor(instrument);
    validatePlan(input);
    const id = randomUUID();
    const now = this.#now().toISOString();
    this.#db.run(
      `INSERT INTO dca_plans (id, instrument_id, account_id, amount, currency, frequency, day_of_month, weekday,
         start_date, end_date, fees, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      instrument.id,
      account.id,
      input.amount,
      input.currency.toUpperCase(),
      input.frequency,
      input.dayOfMonth ?? Number(input.startDate.slice(8, 10)),
      isoWeekday(input.startDate),
      input.startDate,
      input.endDate ?? null,
      input.fees ?? 0,
      input.active === false ? 0 : 1,
      now,
      now,
    );
    await this.runPlans(id);
    return this.#planDto(this.#requirePlan(id));
  }

  async updatePlan(id: string, patch: Partial<DcaPlanRequest>): Promise<DcaPlanDto> {
    const plan = this.#requirePlan(id);
    const merged: DcaPlanRequest = {
      instrumentId: plan.instrument_id,
      amount: patch.amount ?? plan.amount,
      currency: patch.currency ?? plan.currency,
      frequency: patch.frequency ?? plan.frequency,
      dayOfMonth: patch.dayOfMonth ?? plan.day_of_month,
      startDate: patch.startDate ?? plan.start_date,
      endDate: patch.endDate === undefined ? plan.end_date : patch.endDate,
      fees: patch.fees ?? plan.fees,
      active: patch.active ?? plan.active === 1,
    };
    validatePlan(merged);
    this.#db.run(
      `UPDATE dca_plans SET amount = ?, currency = ?, frequency = ?, day_of_month = ?, weekday = ?, start_date = ?,
         end_date = ?, fees = ?, active = ?, updated_at = ? WHERE id = ?`,
      merged.amount,
      merged.currency.toUpperCase(),
      merged.frequency,
      merged.dayOfMonth ?? plan.day_of_month,
      isoWeekday(merged.startDate),
      merged.startDate,
      merged.endDate ?? null,
      merged.fees ?? 0,
      merged.active === false ? 0 : 1,
      this.#now().toISOString(),
      id,
    );
    // Les achats déjà calculés restent tels quels (ils ont eu lieu) ; seules les
    // échéances à venir suivent les nouveaux réglages.
    await this.runPlans(id);
    return this.#planDto(this.#requirePlan(id));
  }

  deletePlan(id: string, options: { removeOperations: boolean }): void {
    this.#requirePlan(id);
    if (options.removeOperations) {
      this.#db.run(`DELETE FROM activities WHERE raw_source_type = 'manual.dca' AND external_transaction_id LIKE ?`, `dca:${id}:%`);
    }
    this.#db.run('DELETE FROM dca_plans WHERE id = ?', id);
  }

  listPlans(instrumentId?: string): DcaPlanDto[] {
    const rows = instrumentId
      ? this.#db.all<DcaPlanRow>('SELECT * FROM dca_plans WHERE instrument_id = ? ORDER BY created_at', instrumentId)
      : this.#db.all<DcaPlanRow>('SELECT * FROM dca_plans ORDER BY created_at');
    return rows.map((row) => this.#planDto(row));
  }

  /**
   * Transforme en achats les échéances passées des plans actifs. Une échéance
   * est exécutée au cours de clôture du jour, ou du premier jour de bourse
   * suivant ; sans cours disponible, elle attend (elle sera calculée au prochain
   * passage).
   */
  async runPlans(planId?: string): Promise<{ created: number; pending: number }> {
    const plans = planId
      ? [this.#requirePlan(planId)]
      : this.#db.all<DcaPlanRow>('SELECT * FROM dca_plans WHERE active = 1');
    const today = this.#today();
    let created = 0;
    let pending = 0;
    for (const plan of plans) {
      if (plan.active !== 1) continue;
      const instrument = this.#instruments.get(plan.instrument_id);
      const account = this.#accounts.get(plan.account_id);
      if (!instrument || !account) continue;
      const dates = planOccurrences(plan, today).filter((date) => !this.#dcaExecuted(plan.id, date));
      if (dates.length === 0) continue;
      let quotes = this.#quotes(instrument.id);
      // Historique insuffisant pour la première échéance : on le complète.
      const first = dates[0] as string;
      if ((quotes[0]?.date ?? '9999') > first && instrument.price_source && instrument.price_source !== 'manual') {
        await this.refreshInstrument(instrument.id, { from: shiftDay(first, -10) }).catch(() => null);
        quotes = this.#quotes(instrument.id);
      }
      const rates = plan.currency === 'EUR' ? new Map<string, number>() : await this.#client.ratesToEur(plan.currency, shiftDay(first, -10));
      for (const date of dates) {
        const execution = priceOnOrAfter(quotes, date);
        if (!execution || execution.date > today || daysBetween(date, execution.date) > MAX_SETTLEMENT_DAYS) {
          pending++;
          continue;
        }
        const rate = plan.currency === 'EUR' ? 1 : rateAt(rates, execution.date);
        if (rate === null) {
          pending++;
          continue;
        }
        const amountEur = round(plan.amount * rate, 8);
        const feesEur = round(plan.fees * rate, 8);
        const quantity = round(Math.max(0, amountEur - feesEur) / execution.close, 8);
        if (!(quantity > 0)) continue;
        const result = this.#activities.write({
          accountId: account.id,
          instrumentId: instrument.id,
          type: 'BUY',
          date: execution.date,
          quantity,
          unitPrice: execution.close,
          amount: -amountEur,
          currency: 'EUR',
          fees: feesEur,
          taxes: 0,
          description: `Investissement programmé ${instrument.name}`,
          providerId: 'manual',
          externalAccountId: account.external_account_id,
          externalTransactionId: `dca:${plan.id}:${date}`,
          externalAssetId: instrument.symbol ?? instrument.isin,
          rawSourceType: 'manual.dca',
          syncRunId: null,
          importId: null,
          lastSyncedAt: this.#now().toISOString(),
        });
        if (result.outcome === 'CREATED') created++;
      }
    }
    return { created, pending };
  }

  /* =============================================================== lecture */

  overview(): HoldingsResponse {
    const aggregates = this.#aggregate();
    const warnings: string[] = [];
    const latest = this.#market.latestQuotes();
    const positions: HoldingPositionDto[] = [];
    let dayChange = 0;
    let previousValue = 0;
    for (const aggregate of aggregates.values()) {
      if (aggregate.quantity <= 1e-12) continue;
      const instrument = this.#instruments.get(aggregate.instrumentId);
      if (!instrument) continue;
      const position = this.#positionDto(instrument, aggregate, latest.get(instrument.id) ?? null);
      if (position.lastPrice === null) {
        warnings.push(`${instrument.name} : aucun cours connu, valorisé au prix de revient.`);
      }
      positions.push(position);
      if (position.dayChangePercent !== null) {
        const before = position.value / (1 + position.dayChangePercent / 100);
        dayChange += position.value - before;
        previousValue += before;
      } else {
        previousValue += position.value;
      }
    }
    const value = round(sum(positions.map((position) => position.value)), 2);
    const invested = round(sum(positions.map((position) => position.invested)), 2);
    for (const position of positions) {
      (position as { weightPercent: number }).weightPercent = value > 0 ? round((position.value / value) * 100, 2) : 0;
    }
    positions.sort((a, b) => b.value - a.value);
    const realized = round(sum([...aggregates.values()].map((aggregate) => aggregate.realized)));
    const lastUpdate = this.#db.get<{ at: string | null }>(
      `SELECT MAX(fetched_at) AS at FROM quotes q JOIN instruments i ON i.id = q.instrument_id WHERE i.price_source IS NOT NULL`,
    )?.at ?? null;
    return {
      totals: {
        value,
        invested,
        pnl: round(value - invested, 2),
        pnlPercent: invested > 0 ? round(((value - invested) / invested) * 100, 2) : 0,
        realizedPnl: round(realized, 2),
        dayChange: round(dayChange, 2),
        dayChangePercent: previousValue > 0 ? round((dayChange / previousValue) * 100, 2) : 0,
      },
      positions,
      plans: this.listPlans(),
      allocation: allocationByKind(positions),
      lastPriceUpdate: lastUpdate,
      warnings,
    };
  }

  detail(instrumentId: string, period: PeriodKey): HoldingDetailResponse {
    const instrument = this.#requireInstrument(instrumentId);
    const aggregate = this.#aggregate(instrumentId).get(instrumentId);
    const latest = this.#market.latestQuote(instrumentId);
    const position =
      aggregate && aggregate.quantity > 1e-12
        ? this.#positionDto(instrument, aggregate, latest ? { date: latest.date, close: latest.close, currency: latest.currency } : null)
        : null;
    const quotes = this.#quotes(instrumentId);
    const today = this.#today();
    const from = startOfPeriod(today, period, quotes[0]?.date ?? today);
    const prices = quotes.filter((point) => point.date >= from).map((point) => ({ date: point.date, total: point.close }));
    const firstPrice = prices[0]?.total;
    const lastPrice = prices[prices.length - 1]?.total;
    const accountNames = new Map(this.#accounts.list().map((account) => [account.id, account]));
    const operations = this.#db
      .all<ActivityRow>(
        `SELECT * FROM activities WHERE instrument_id = ? ORDER BY date DESC, created_at DESC`,
        instrumentId,
      )
      .filter((row) => accountNames.has(row.account_id) && INVESTMENT_ACCOUNT_TYPES.has((accountNames.get(row.account_id) as AccountRow).type))
      .map((row) => this.#operationDto(row, accountNames.get(row.account_id) as AccountRow));
    return {
      asset: this.#assetDto(instrument),
      position,
      operations,
      plans: this.listPlans(instrumentId),
      prices,
      history: this.#valueSeries(from, today, instrumentId),
      period,
      priceChangePercent:
        firstPrice !== undefined && lastPrice !== undefined && firstPrice > 0
          ? round(((lastPrice - firstPrice) / firstPrice) * 100, 2)
          : null,
    };
  }

  history(period: PeriodKey): HoldingsHistoryResponse {
    const today = this.#today();
    const first = this.#db.get<{ date: string | null }>(
      `SELECT MIN(a.date) AS date FROM activities a JOIN accounts c ON c.id = a.account_id
        WHERE c.type IN ('SECURITIES','CRYPTO','OTHER') AND a.instrument_id IS NOT NULL`,
    )?.date ?? today;
    const from = startOfPeriod(today, period, first);
    const points = this.#valueSeries(from < first ? first : from, today);
    const start = points[0];
    const end = points[points.length - 1];
    // Variation = évolution de la valeur moins l'argent ajouté sur la période.
    const change = start && end ? round(end.value - start.value - (end.invested - start.invested), 2) : 0;
    const base = start ? start.value + Math.max(0, (end?.invested ?? 0) - start.invested) : 0;
    return {
      period,
      points,
      change,
      changePercent: base > 0 ? round((change / base) * 100, 2) : 0,
    };
  }

  /* ================================================================ interne */

  /** Positions par instrument (tous les comptes d'investissement), en euros. */
  #aggregate(onlyInstrument?: string): Map<string, Aggregate> {
    const result = new Map<string, Aggregate>();
    for (const account of this.#accounts.list()) {
      if (!INVESTMENT_ACCOUNT_TYPES.has(account.type) || account.is_active !== 1) continue;
      const rows = this.#activities
        .listForAccount(account.id)
        .filter((row) => row.instrument_id && POSITION_TYPES.has(row.type) && (!onlyInstrument || row.instrument_id === onlyInstrument));
      const withActivities = new Set<string>();
      if (rows.length > 0) {
        let calc;
        try {
          calc = computePositions({ activities: rows.map((row) => toDomainActivity(row, account.currency)), currency: account.currency });
        } catch {
          continue;
        }
        for (const position of calc.positions) {
          if (!position.instrumentId) continue;
          withActivities.add(position.instrumentId);
          const entry = entryFor(result, position.instrumentId);
          entry.quantity = round(entry.quantity + position.quantity, 8);
          entry.invested = round(entry.invested + position.costBasis, 8);
          entry.realized = round(entry.realized + position.realizedPnl, 8);
          entry.accounts.add(account.name);
          if (account.provider_id === 'manual') entry.editable = true;
        }
      }
      // Soldes déclarés par une source sans historique d'achats (wallet, plateforme).
      for (const declared of this.#valuations.latestPositionsForAccount(account.id)) {
        if (withActivities.has(declared.instrumentId)) continue;
        if (onlyInstrument && declared.instrumentId !== onlyInstrument) continue;
        if (declared.quantity === null || declared.quantity <= 0) continue;
        const entry = entryFor(result, declared.instrumentId);
        entry.quantity = round(entry.quantity + declared.quantity, 8);
        entry.invested = round(entry.invested + declared.value, 8);
        entry.accounts.add(account.name);
      }
    }
    return result;
  }

  #positionDto(
    instrument: InstrumentRow,
    aggregate: Aggregate,
    latest: { date: string; close: number; currency: string } | null,
  ): HoldingPositionDto {
    const recent = this.#db.all<{ date: string; close: number }>(
      'SELECT date, close FROM quotes WHERE instrument_id = ? ORDER BY date DESC LIMIT 31',
      instrument.id,
    );
    const lastPrice = latest?.close ?? null;
    const value = round(aggregate.quantity * (lastPrice ?? (aggregate.quantity > 0 ? aggregate.invested / aggregate.quantity : 0)), 2);
    const invested = round(aggregate.invested, 2);
    const previous = recent[1]?.close;
    return {
      ...this.#assetDto(instrument),
      quantity: aggregate.quantity,
      lastPrice,
      priceDate: latest?.date ?? null,
      value,
      invested,
      pnl: round(value - invested, 2),
      pnlPercent: invested > 0 ? round(((value - invested) / invested) * 100, 2) : 0,
      realizedPnl: round(aggregate.realized, 2),
      dayChangePercent: lastPrice !== null && previous ? round(((lastPrice - previous) / previous) * 100, 2) : null,
      weightPercent: 0,
      editable: aggregate.editable,
      accounts: [...aggregate.accounts],
      sparkline: recent.slice(0, 30).reverse().map((row) => row.close),
    };
  }

  /** Valeur et montant investi, jour par jour, d'une ligne ou de tout le portefeuille. */
  #valueSeries(from: string, to: string, instrumentId?: string): HoldingValuePoint[] {
    const accounts = new Map(
      this.#accounts
        .list()
        .filter((account) => INVESTMENT_ACCOUNT_TYPES.has(account.type) && account.is_active === 1)
        .map((account) => [account.id, account]),
    );
    const rows = this.#activities
      .listAll()
      .filter((row) => accounts.has(row.account_id) && row.instrument_id && POSITION_TYPES.has(row.type))
      .filter((row) => !instrumentId || row.instrument_id === instrumentId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const quotes = new Map<string, PricePoint[]>();
    const quotesOf = (id: string): PricePoint[] => {
      let list = quotes.get(id);
      if (!list) {
        list = this.#quotes(id);
        quotes.set(id, list);
      }
      return list;
    };
    const quantity = new Map<string, number>();
    const cost = new Map<string, number>();
    const points: HoldingValuePoint[] = [];
    let cursor = 0;
    const days = enumerateDays(from, to);
    const pointerByInstrument = new Map<string, number>();
    for (const day of days) {
      while (cursor < rows.length && (rows[cursor] as ActivityRow).date <= day) {
        const row = rows[cursor] as ActivityRow;
        const id = row.instrument_id as string;
        const qty = row.quantity ?? 0;
        const held = quantity.get(id) ?? 0;
        const basis = cost.get(id) ?? 0;
        const incoming =
          row.type === 'BUY' || row.type === 'TRANSFER_IN' || row.type === 'STAKING_REWARD' || (row.type === 'CRYPTO_TRANSFER' && row.amount > 0);
        if (row.type === 'SPLIT') {
          quantity.set(id, round(held * (qty > 0 ? qty : 1), 8));
        } else if (incoming) {
          quantity.set(id, round(held + qty, 8));
          cost.set(id, round(basis + Math.abs(row.amount || qty * (row.unit_price ?? 0)), 8));
        } else {
          const unit = held > 0 ? basis / held : 0;
          const next = Math.max(0, held - qty);
          quantity.set(id, round(next, 8));
          cost.set(id, next <= 1e-9 ? 0 : round(basis - qty * unit, 8));
        }
        cursor++;
      }
      let value = 0;
      let invested = 0;
      for (const [id, held] of quantity) {
        if (held <= 1e-12) continue;
        const list = quotesOf(id);
        // Parcours incrémental : les jours sont croissants.
        let index = pointerByInstrument.get(id) ?? -1;
        while (index + 1 < list.length && (list[index + 1] as PricePoint).date <= day) index++;
        pointerByInstrument.set(id, index);
        const basis = cost.get(id) ?? 0;
        const price = index >= 0 ? (list[index] as PricePoint).close : basis / held;
        value += held * price;
        invested += basis;
      }
      points.push({ date: day, value: round(value, 2), invested: round(invested, 2) });
    }
    return points;
  }

  #planDto(plan: DcaPlanRow): DcaPlanDto {
    const instrument = this.#instruments.get(plan.instrument_id);
    const stats = this.#db.get<{ n: number; invested: number | null; qty: number | null }>(
      `SELECT COUNT(*) AS n, SUM(-amount) AS invested, SUM(quantity) AS qty FROM activities
        WHERE raw_source_type = 'manual.dca' AND external_transaction_id LIKE ?`,
      `dca:${plan.id}:%`,
    );
    const today = this.#today();
    const due = planOccurrences(plan, today).filter((date) => !this.#dcaExecuted(plan.id, date));
    const upcoming = plan.active === 1 ? planOccurrences(plan, shiftDay(today, 400), today).find((date) => date > today) ?? null : null;
    return {
      id: plan.id,
      instrumentId: plan.instrument_id,
      assetName: instrument?.name ?? 'Actif supprimé',
      assetSymbol: instrument?.symbol ?? null,
      amount: plan.amount,
      currency: plan.currency,
      frequency: plan.frequency,
      dayOfMonth: plan.day_of_month,
      startDate: plan.start_date,
      endDate: plan.end_date,
      fees: plan.fees,
      active: plan.active === 1,
      executions: stats?.n ?? 0,
      investedEur: round(stats?.invested ?? 0, 2),
      quantity: round(stats?.qty ?? 0, 8),
      nextDate: upcoming,
      pending: plan.active === 1 ? due.length : 0,
    };
  }

  #operationDto(row: ActivityRow, account: AccountRow): HoldingOperationDto {
    const external = row.external_transaction_id ?? '';
    return {
      id: row.id,
      date: row.date,
      type: row.type,
      typeLabel: row.raw_source_type === 'manual.dca' ? 'Achat programmé' : (OPERATION_LABELS[row.type] ?? row.type),
      quantity: row.quantity ?? 0,
      unitPrice: row.unit_price,
      amount: row.amount,
      fees: row.fees,
      accountName: account.name,
      planId: external.startsWith('dca:') ? (external.split(':')[1] ?? null) : null,
      deletable: row.provider_id === 'manual' && (row.raw_source_type ?? '').startsWith('manual.'),
      description: row.description,
    };
  }

  #assetDto(instrument: InstrumentRow): HoldingAssetDto {
    const kind = normalizeKind(instrument.kind);
    return {
      instrumentId: instrument.id,
      name: instrument.name,
      symbol: instrument.symbol,
      isin: instrument.isin,
      kind,
      kindLabel: kindLabel(kind),
      exchange: instrument.exchange,
      priceSource: (instrument.price_source as HoldingPriceSource | null | undefined) ?? null,
      priceSymbol: instrument.price_symbol ?? null,
      quoteCurrency: instrument.quote_currency ?? null,
    };
  }

  /** Compte « Mes investissements » ou « Mes cryptos », créé au premier besoin. */
  #accountFor(instrument: InstrumentRow): AccountRow {
    const crypto = instrument.kind === 'CRYPTO';
    const { account } = this.#accounts.upsertFromProvider({
      name: crypto ? 'Mes cryptos' : 'Mes investissements',
      type: crypto ? 'CRYPTO' : 'SECURITIES',
      providerId: 'manual',
      currency: 'EUR',
      externalAccountId: crypto ? MANUAL_CRYPTO_ID : MANUAL_SECURITIES_ID,
    });
    return account;
  }

  #insertInstrument(input: {
    kind: HoldingKind;
    name: string;
    symbol: string | null;
    isin: string | null;
    exchange: string | null;
    currency: string;
  }): InstrumentRow {
    const id = randomUUID();
    const now = this.#now().toISOString();
    this.#db.run(
      `INSERT INTO instruments (id, kind, symbol, isin, name, currency, exchange, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.symbol,
      input.isin,
      input.name,
      input.currency,
      input.exchange,
      now,
      now,
    );
    return this.#requireInstrument(id);
  }

  #quotes(instrumentId: string): PricePoint[] {
    return this.#db.all<PricePoint>('SELECT date, close FROM quotes WHERE instrument_id = ? ORDER BY date', instrumentId);
  }

  #quantityHeld(instrumentId: string, accountId: string, date: string): number {
    const account = this.#accounts.get(accountId) as AccountRow;
    const rows = this.#activities
      .listForAccount(accountId)
      .filter((row) => row.instrument_id === instrumentId && row.date <= date && POSITION_TYPES.has(row.type));
    if (rows.length === 0) return 0;
    const calc = computePositions({ activities: rows.map((row) => toDomainActivity(row, account.currency)), currency: account.currency });
    return calc.positions.find((position) => position.instrumentId === instrumentId)?.quantity ?? 0;
  }

  #dcaExecuted(planId: string, date: string): boolean {
    return (
      this.#db.get<{ id: string }>(
        `SELECT id FROM activities WHERE provider_id = 'manual' AND external_transaction_id = ?`,
        `dca:${planId}:${date}`,
      ) !== null
    );
  }

  async #rateOn(currency: string, date: string): Promise<number> {
    const code = currency.toUpperCase();
    if (code === 'EUR') return 1;
    const rates = await this.#client.ratesToEur(code, shiftDay(date, -10));
    const rate = rates ? rateAt(rates, date) : null;
    if (rate === null) {
      throw new HoldingsError(502, 'CONNECTOR_ERROR', `Taux ${code}/EUR indisponible pour le ${date} : réessayez plus tard.`);
    }
    return rate;
  }

  #requireInstrument(id: string): InstrumentRow {
    const instrument = this.#instruments.get(id);
    if (!instrument) throw new HoldingsError(404, 'NOT_FOUND', 'Actif introuvable.');
    return instrument;
  }

  #requirePlan(id: string): DcaPlanRow {
    const plan = this.#db.get<DcaPlanRow>('SELECT * FROM dca_plans WHERE id = ?', id);
    if (!plan) throw new HoldingsError(404, 'NOT_FOUND', 'Investissement programmé introuvable.');
    return plan;
  }

  #today(): string {
    return this.#now().toISOString().slice(0, 10);
  }
}

/* ================================================================== outils */

/**
 * Échéances d'un plan entre son début et `until` (inclus), en ignorant celles
 * antérieures à `after` quand il est fourni. Mensuel : le jour demandé, ramené
 * au dernier jour du mois s'il n'existe pas (31 -> 30 avril, 28/29 février).
 */
export function planOccurrences(
  plan: Pick<DcaPlanRow, 'frequency' | 'day_of_month' | 'start_date' | 'end_date'>,
  until: string,
  after?: string,
): string[] {
  const end = plan.end_date && plan.end_date < until ? plan.end_date : until;
  const dates: string[] = [];
  if (plan.frequency === 'WEEKLY') {
    for (let day = plan.start_date; day <= end && dates.length < 5000; day = shiftDay(day, 7)) {
      if (!after || day > after) dates.push(day);
    }
    return dates;
  }
  const step = plan.frequency === 'QUARTERLY' ? 3 : 1;
  let year = Number(plan.start_date.slice(0, 4));
  let month = Number(plan.start_date.slice(5, 7));
  for (let guard = 0; guard < 2000; guard++) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(plan.day_of_month, last);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (date > end) break;
    if (date >= plan.start_date && (!after || date > after)) dates.push(date);
    month += step;
    while (month > 12) {
      month -= 12;
      year++;
    }
  }
  return dates;
}

function validatePlan(input: DcaPlanRequest): void {
  if (!(input.amount > 0)) throw new HoldingsError(400, 'INVALID_REQUEST', 'Le montant doit être positif.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new HoldingsError(400, 'INVALID_REQUEST', 'Date de début invalide.');
  if (input.endDate && input.endDate < input.startDate) {
    throw new HoldingsError(400, 'INVALID_REQUEST', 'La date de fin précède la date de début.');
  }
  if (input.dayOfMonth !== undefined && (input.dayOfMonth < 1 || input.dayOfMonth > 31)) {
    throw new HoldingsError(400, 'INVALID_REQUEST', 'Jour du mois invalide (1 à 31).');
  }
  if ((input.fees ?? 0) < 0 || (input.fees ?? 0) >= input.amount) {
    throw new HoldingsError(400, 'INVALID_REQUEST', 'Frais invalides.');
  }
}

function normalizeKind(kind: string): HoldingKind {
  const upper = kind.toUpperCase();
  return (['EQUITY', 'ETF', 'FUND', 'BOND', 'CRYPTO', 'OTHER'] as const).includes(upper as HoldingKind)
    ? (upper as HoldingKind)
    : 'OTHER';
}

function entryFor(map: Map<string, Aggregate>, instrumentId: string): Aggregate {
  let entry = map.get(instrumentId);
  if (!entry) {
    entry = { instrumentId, quantity: 0, invested: 0, realized: 0, editable: false, accounts: new Set() };
    map.set(instrumentId, entry);
  }
  return entry;
}

function allocationByKind(positions: readonly HoldingPositionDto[]): AllocationSlice[] {
  const total = sum(positions.map((position) => position.value));
  const byKind = new Map<string, number>();
  for (const position of positions) byKind.set(position.kind, (byKind.get(position.kind) ?? 0) + position.value);
  return [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, value]) => ({
      key: kind,
      label: kindLabel(kind as AssetKind),
      value: round(value, 2),
      percent: total > 0 ? round((value / total) * 100, 2) : 0,
    }));
}

function rateAt(rates: Map<string, number> | null, date: string): number | null {
  if (!rates) return null;
  if (rates.size === 0) return 1;
  let best: string | null = null;
  for (const day of rates.keys()) {
    if (day <= date && (best === null || day > best)) best = day;
  }
  if (best === null) {
    best = [...rates.keys()].sort()[0] ?? null;
  }
  return best === null ? null : (rates.get(best) ?? null);
}

function isoWeekday(day: string): number {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 20_000; day = shiftDay(day, 1)) days.push(day);
  return days;
}

function formatQty(value: number): string {
  return value.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
}
