import {
  aggregateClassTotals,
  amortizationSchedule,
  allocation,
  buildSummary,
  buildXirrFlows,
  classifyFlows,
  computePropertyMetrics,
  computePositions,
  convert,
  densify,
  findRate,
  maxDrawdown,
  mergePositions,
  PERIOD_DAYS,
  pointAt,
  round,
  startOfPeriod,
  sum,
  twr,
  variation,
  xirr,
  WEALTH_CLASSES,
  type ClassTotalInput,
  type FxRate,
  type NetWorthPoint,
  type PeriodKey,
  type WealthClass,
} from '@suiviinvest/core';
import type {
  AccountSummary,
  AccountsResponse,
  AllocationSlice,
  AnalyticsResponse,
  IncomeResponse,
  InvestmentsResponse,
  NetWorthResponse,
  PositionDto,
  SeriesPoint,
  TransactionDto,
  TransactionsResponse,
} from '@suiviinvest/api-contract';

/** Version mutable des DTO pour les calculs intermédiaires (les DTO exposés restent en lecture seule). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
import type { Db } from '../db/database.ts';
import { AccountRepository, InstrumentRepository, type AccountRow } from '../repositories/accounts.ts';
import { ActivityRepository, toDomainActivity, type ActivityQuery, type ActivityRow } from '../repositories/activities.ts';
import { MarketRepository } from '../repositories/market.ts';
import { PropertyRepository } from '../repositories/properties.ts';

/**
 * Calculs de patrimoine et de performance.
 *
 * Approche : un parcours en mémoire des activités et des cours, et non une
 * requête SQL par jour. Pour une patrimoine personnel (quelques milliers de
 * lignes) c'est instantané, déterministe et testable — et cela évite une table
 * d'agrégats à maintenir.
 *
 * Invariants :
 *  - un compte dont la devise ne peut pas être convertie est EXCLU du total et
 *    signalé dans `warnings` : jamais de total silencieusement faux ;
 *  - les dettes entrent en négatif dans `LIABILITIES` ;
 *  - un transfert entre deux comptes internes est neutralisé dans la performance.
 */

export interface PortfolioServiceOptions {
  readonly baseCurrency: string;
}

const CLASS_BY_ACCOUNT_TYPE: Record<string, WealthClass> = {
  SECURITIES: 'EQUITIES',
  CRYPTO: 'CRYPTO',
  REAL_ESTATE: 'REAL_ESTATE',
  CASH: 'CASH',
  OTHER: 'OTHER_ASSETS',
  LIABILITY: 'LIABILITIES',
};

const CLASS_LABELS: Record<WealthClass, string> = {
  EQUITIES: 'Actions / ETF',
  CRYPTO: 'Crypto',
  REAL_ESTATE: 'Immobilier',
  CASH: 'Cash',
  OTHER_ASSETS: 'Autres actifs',
  LIABILITIES: 'Dettes',
};

const PROVIDER_LABELS: Record<string, string> = {
  degiro: 'DEGIRO',
  trade_republic: 'Trade Republic',
  credit_agricole: 'Crédit Agricole',
  revolut: 'Revolut',
  metamask: 'MetaMask',
  manual: 'Saisie manuelle',
  csv: 'Imports',
};

export class PortfolioService {
  readonly #db: Db;
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #market: MarketRepository;
  readonly #properties: PropertyRepository;
  readonly #baseCurrency: string;

  constructor(db: Db, options: PortfolioServiceOptions) {
    this.#db = db;
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#market = new MarketRepository(db);
    this.#properties = new PropertyRepository(db);
    this.#baseCurrency = options.baseCurrency;
  }

  /* ---------------------------------------------------------------- patrimoine */

  netWorth(period: PeriodKey = '1Y'): NetWorthResponse {
    const snapshot = this.#snapshot();
    const points = this.#series(snapshot.today);
    const summary = buildSummary(points, this.#baseCurrency);

    const firstDate = points[0]?.date ?? snapshot.today;
    const windowStart = startOfPeriod(snapshot.today, period, firstDate);
    const series: SeriesPoint[] = densify(points, windowStart, snapshot.today).map((point) => ({
      date: point.date,
      total: point.total,
    }));

    // Si l'historique est trop court pour la période demandée, on le dit.
    const warnings = [...snapshot.warnings];
    if (windowStart < firstDate) {
      warnings.push(
        `Historique limité : les données commencent le ${firstDate} (période demandée depuis le ${windowStart}).`,
      );
    }

    return {
      asOf: snapshot.today,
      currency: this.#baseCurrency,
      total: snapshot.total,
      variationToday: summary.variationToday,
      variation1M: summary.variation1M,
      variationYtd: summary.variationYtd,
      variation1Y: summary.variation1Y,
      variationAll: summary.variationAll,
      series,
      byClass: toSlices(snapshot.byClass, CLASS_LABELS),
      byProvider: toSlices(snapshot.byProvider, PROVIDER_LABELS),
      byCurrency: this.#allocationByCurrency(snapshot),
      warnings,
    };
  }

  accounts(): AccountsResponse {
    const rows = this.#accounts.list();
    const latestQuotes = this.#market.latestQuotes();
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const today = isoToday();
    const summaries: AccountSummary[] = [];
    const classItems: ClassTotalInput[] = [];

    for (const row of rows) {
      const values = this.#accountValue(row, latestQuotes, today);
      const converted = this.#convert(values.value, row.currency, rates, today);
      classItems.push({
        class: CLASS_BY_ACCOUNT_TYPE[row.type] ?? 'OTHER_ASSETS',
        providerId: row.provider_id,
        accountId: row.id,
        valueBaseCurrency: converted === null ? null : converted.amount,
      });
      const lastActivity = this.#db.get<{ date: string | null }>(
        'SELECT MAX(date) AS date FROM activities WHERE account_id = ?',
        row.id,
      );
      summaries.push({
        id: row.id,
        name: row.name,
        type: row.type,
        providerId: row.provider_id,
        currency: row.currency,
        value: round(values.value),
        valueCurrency: row.currency,
        cash: round(values.cash),
        invested: round(values.invested),
        unrealizedPnl: round(values.unrealizedPnl),
        unrealizedPnlPercent: values.invested > 0 ? round((values.unrealizedPnl / values.invested) * 100, 2) : 0,
        realizedPnl: round(values.realizedPnl),
        lastActivityDate: lastActivity?.date ?? null,
        isActive: row.is_active === 1,
        externalAccountId: row.external_account_id,
      });
    }

    const totals = aggregateClassTotals(classItems);
    return {
      accounts: summaries.sort((a, b) => b.value - a.value),
      totals: {
        byType: this.#groupSlices(summaries, (account) => account.type, (account) => account.value),
        byProvider: toSlices(totals.byProvider, PROVIDER_LABELS),
        total: round(sum(summaries.map((account) => account.value))),
      },
    };
  }

  investments(accountId?: string): InvestmentsResponse {
    const rows = accountId ? this.#accounts.list().filter((a) => a.id === accountId) : this.#accounts.list();
    const latestQuotes = this.#market.latestQuotes();
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const today = isoToday();
    const calculations = [];
    const warnings: string[] = [];
    const positions: Mutable<PositionDto>[] = [];

    for (const account of rows) {
      if (account.type !== 'SECURITIES' && account.type !== 'CRYPTO' && account.type !== 'OTHER') continue;
      const activityRows = this.#activities.listForAccount(account.id);
      if (activityRows.length === 0) continue;
      const domain = activityRows.map((row) => toDomainActivity(row, account.currency));
      const lastPrices: Record<string, number> = {};
      for (const activity of domain) {
        if (!activity.instrumentId) continue;
        const quote = latestQuotes.get(activity.instrumentId);
        if (quote) lastPrices[activity.instrumentId] = quote.close;
      }
      const calc = computePositions({ activities: domain, lastPrices, currency: account.currency });
      calculations.push(calc);

      for (const position of calc.positions) {
        if (position.quantity === 0 && position.realizedPnl === 0) continue;
        const instrument = position.instrumentId ? this.#instruments.get(position.instrumentId) : null;
        const quote = position.instrumentId ? latestQuotes.get(position.instrumentId) : undefined;
        const converted = this.#convert(position.marketValue, account.currency, rates, today);
        if (position.marketValue !== 0 && converted === null) {
          warnings.push(`Position ${instrument?.name ?? position.instrumentId} exclue : taux ${account.currency} indisponible.`);
          continue;
        }
        const orders = this.#db.all<{ count: number }>(
          'SELECT COUNT(*) AS count FROM activities WHERE account_id = ? AND instrument_id = ?',
          account.id,
          position.instrumentId,
        );
        void orders;
        positions.push({
          instrumentId: position.instrumentId,
          symbol: instrument?.symbol ?? null,
          isin: instrument?.isin ?? null,
          name: instrument?.name ?? position.instrumentId,
          kind: instrument?.kind ?? 'OTHER',
          accountId: account.id,
          accountName: account.name,
          quantity: position.quantity,
          averageCost: position.averageCost,
          lastPrice: position.lastPrice,
          currency: position.currency,
          marketValue: position.marketValue,
          marketValueEur: converted?.amount ?? 0,
          costBasis: position.costBasis,
          unrealizedPnl: position.unrealizedPnl,
          unrealizedPnlPercent:
            position.costBasis > 0 ? round((position.unrealizedPnl / position.costBasis) * 100, 2) : 0,
          realizedPnl: position.realizedPnl,
          dividends: position.dividends,
          fees: position.fees,
          weightPercent: 0,
          priceDate: quote?.date ?? null,
        });
      }
      for (const mixed of calc.mixedCurrencyInstruments) {
        warnings.push(
          `Instrument ${mixed} détenu dans une devise différente de celle du compte : conversion requise.`,
        );
      }
    }

    const merged = mergePositions(calculations);
    const totalValue = round(sum(positions.map((position) => position.marketValueEur)));
    for (const position of positions) {
      position.weightPercent = totalValue > 0 ? round((position.marketValueEur / totalValue) * 100, 2) : 0;
    }

    const costBasis = round(sum(positions.map((position) => position.costBasis)));
    const marketValue = round(sum(positions.map((position) => position.marketValue)));
    const unrealized = round(marketValue - sum(positions.map((position) => position.costBasis)));

    return {
      positions: positions.sort((a, b) => b.marketValueEur - a.marketValueEur),
      currency: this.#baseCurrency,
      totals: {
        marketValue,
        costBasis,
        unrealizedPnl: unrealized,
        unrealizedPnlPercent: costBasis > 0 ? round((unrealized / costBasis) * 100, 2) : 0,
        realizedPnl: merged.realizedPnl,
        dividends: merged.dividends,
        fees: merged.fees,
      },
      performance: this.#performanceFor('1Y'),
      allocation: this.#groupSlices(
        positions,
        (position) => (position.kind === 'CRYPTO' ? 'Crypto' : position.kind === 'ETF' ? 'ETF' : 'Actions'),
        (position) => position.marketValueEur,
      ),
      warnings,
    };
  }

  transactions(query: ActivityQuery): TransactionsResponse {
    const page = this.#activities.search({ ...query });
    const accountById = new Map(this.#accounts.list().map((account) => [account.id, account]));
    const rates = this.#market.allRatesTo(this.#baseCurrency);

    const items: TransactionDto[] = page.rows.map((row) => {
      const account = accountById.get(row.account_id);
      const instrument = row.instrument_id ? this.#instruments.get(row.instrument_id) : null;
      const converted = this.#convert(row.amount, row.currency, rates, row.date);
      return {
        id: row.id,
        date: row.date,
        type: row.type,
        accountId: row.account_id,
        accountName: account?.name ?? 'Compte supprimé',
        providerId: row.provider_id,
        instrumentId: row.instrument_id,
        instrumentName: instrument?.name ?? null,
        isin: instrument?.isin ?? null,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        amount: row.amount,
        currency: row.currency,
        amountEur: converted?.amount ?? 0,
        fees: row.fees,
        taxes: row.taxes,
        source: row.raw_source_type ?? row.provider_id,
      };
    });

    return {
      items,
      nextCursor: page.nextCursor,
      total: page.total,
      totalsByType: page.totalsByType.map((entry) => ({
        key: entry.type,
        label: entry.type,
        value: entry.amount,
        percent: page.total > 0 ? round((entry.count / page.total) * 100, 2) : 0,
      })),
    };
  }

  income(period: PeriodKey): IncomeResponse {
    const today = isoToday();
    const range = this.#activities.dateRange();
    const from = startOfPeriod(today, period, range.first ?? today);
    const incomeTypes = ['DIVIDEND', 'INTEREST', 'RENT', 'STAKING_REWARD'];
    const rows = this.#db.all<ActivityRow>(
      `SELECT * FROM activities WHERE date >= ? AND date <= ? AND type IN (${incomeTypes.map(() => '?').join(',')})
        ORDER BY date DESC`,
      from,
      today,
      ...incomeTypes,
    );
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const accountById = new Map(this.#accounts.list().map((account) => [account.id, account]));

    const items: TransactionDto[] = rows.map((row) => {
      const account = accountById.get(row.account_id);
      const converted = this.#convert(row.amount, row.currency, rates, row.date);
      return {
        id: row.id,
        date: row.date,
        type: row.type,
        accountId: row.account_id,
        accountName: account?.name ?? 'Compte supprimé',
        providerId: row.provider_id,
        instrumentId: row.instrument_id,
        instrumentName: row.instrument_id ? this.#instruments.get(row.instrument_id)?.name ?? null : null,
        isin: row.instrument_id ? this.#instruments.get(row.instrument_id)?.isin ?? null : null,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        amount: row.amount,
        currency: row.currency,
        amountEur: converted?.amount ?? 0,
        fees: row.fees,
        taxes: row.taxes,
        source: row.raw_source_type ?? row.provider_id,
      };
    });

    const byMonth = new Map<string, number>();
    for (const item of items) {
      const month = item.date.slice(0, 7);
      byMonth.set(month, round((byMonth.get(month) ?? 0) + item.amountEur));
    }

    const total = round(sum(items.map((item) => item.amountEur)));
    const monthsSpan = Math.max(
      1,
      Math.round(
        (Date.parse(today) - Date.parse(from)) / (30.44 * 86_400_000),
      ),
    );

    return {
      period,
      total,
      byType: this.#groupSlices(items, (item) => item.type, (item) => item.amountEur),
      byMonth: [...byMonth.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, value]) => ({ month, value })),
      byAccount: this.#groupSlices(items, (item) => item.accountName, (item) => item.amountEur),
      byProvider: this.#groupSlices(items, (item) => item.providerId, (item) => item.amountEur),
      forwardAnnualized: round((total / monthsSpan) * 12),
      items: items.slice(0, 100),
    };
  }

  analytics(period: PeriodKey): AnalyticsResponse {
    const snapshot = this.#snapshot();
    const points = this.#series(snapshot.today);
    const firstDate = points[0]?.date ?? snapshot.today;
    const from = startOfPeriod(snapshot.today, period, firstDate);

    const activityRows = this.#activities.listAll();
    const domainActivities = activityRows.map((row) => toDomainActivity(row));
    const flows = classifyFlows(domainActivities, from);
    const windowed = points.filter((point) => point.date >= from);
    const performance = this.#performanceFromPoints(windowed, flows.external, period, firstDate);

    const drawdown = windowed.length > 1 ? maxDrawdown(windowed.map((p) => ({ date: p.date, value: p.total }))) : null;
    const returns: number[] = [];
    for (let i = 1; i < windowed.length; i++) {
      const previous = windowed[i - 1] as NetWorthPoint;
      const current = windowed[i] as NetWorthPoint;
      if (previous.total <= 0) continue;
      returns.push(current.total / previous.total - 1);
    }
    const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance =
      returns.length > 1
        ? returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (returns.length - 1)
        : 0;
    const volatility = returns.length > 1 ? round(Math.sqrt(variance) * Math.sqrt(365) * 100, 2) : null;

    const monthBuckets = new Map<string, { invested: number; income: number; expenses: number; netWorth: number }>();
    for (const point of windowed) {
      const month = point.date.slice(0, 7);
      const bucket = monthBuckets.get(month) ?? { invested: 0, income: 0, expenses: 0, netWorth: 0 };
      bucket.netWorth = point.total;
      monthBuckets.set(month, bucket);
    }
    for (const activity of domainActivities) {
      if (activity.date < from) continue;
      const month = activity.date.slice(0, 7);
      const bucket = monthBuckets.get(month) ?? { invested: 0, income: 0, expenses: 0, netWorth: 0 };
      if (activity.type === 'DEPOSIT') bucket.invested += activity.amount;
      if (activity.type === 'BUY') bucket.invested += Math.abs(activity.amount);
      if (['DIVIDEND', 'INTEREST', 'RENT', 'STAKING_REWARD'].includes(activity.type)) bucket.income += activity.amount;
      if (['FEE', 'TAX', 'BANK_EXPENSE', 'REAL_ESTATE_EXPENSE'].includes(activity.type)) {
        bucket.expenses += Math.abs(activity.amount);
      }
      monthBuckets.set(month, bucket);
    }

    const portfolioValue = snapshot.total;
    const cryptoShare = portfolioValue > 0 ? round(((snapshot.byClass.CRYPTO ?? 0) / portfolioValue) * 100, 2) : 0;
    const realEstateShare =
      portfolioValue > 0 ? round(((snapshot.byClass.REAL_ESTATE ?? 0) / portfolioValue) * 100, 2) : 0;
    const grossAssets = WEALTH_CLASSES.filter((key) => key !== 'LIABILITIES').reduce(
      (acc, key) => acc + (snapshot.byClass[key] ?? 0),
      0,
    );
    const debts = Math.abs(snapshot.byClass.LIABILITIES ?? 0);

    return {
      period,
      performance,
      byAccount: this.accounts().accounts
        .filter((account) => account.type === 'SECURITIES' || account.type === 'CRYPTO')
        .slice(0, 40)
        .map((account) => ({
          accountId: account.id,
          accountName: account.name,
          providerId: account.providerId,
          value: account.value,
          performance: this.#performanceForAccount(account.id, period),
          contribution: portfolioValue !== 0 ? round((account.value / portfolioValue) * 100, 2) : 0,
        })),
      allocation: {
        byClass: toSlices(snapshot.byClass, CLASS_LABELS),
        byInstrument: this.investments().allocation,
        byCurrency: this.#allocationByCurrency(snapshot),
        byCountry: this.#allocationByCountry(),
      },
      risk: {
        maxDrawdown: drawdown,
        volatility,
        cryptoShare,
        realEstateShare,
        leverage: grossAssets > 0 ? round((debts / grossAssets) * 100, 2) : 0,
      },
      monthly: [...monthBuckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, bucket]) => ({
          month,
          invested: round(bucket.invested),
          income: round(bucket.income),
          expenses: round(bucket.expenses),
          netWorth: round(bucket.netWorth),
        })),
    };
  }

  /* ------------------------------------------------------------------ interne */

  #snapshot(): {
    today: string;
    total: number;
    byClass: Record<WealthClass, number>;
    byProvider: Record<string, number>;
    warnings: string[];
  } {
    const today = isoToday();
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const latestQuotes = this.#market.latestQuotes();
    const warnings: string[] = [];
    const items: ClassTotalInput[] = [];
    const byCurrency: Record<string, number> = {};

    for (const account of this.#accounts.list()) {
      if (account.is_active !== 1) continue;
      const values = this.#accountValue(account, latestQuotes, today);
      const converted = this.#convert(values.value, account.currency, rates, today);
      if (values.value !== 0 && converted === null) {
        warnings.push(
          `Compte « ${account.name} » exclu du patrimoine : aucun taux ${account.currency}->${this.#baseCurrency} disponible.`,
        );
        continue;
      }
      if (converted) {
        byCurrency[account.currency] = round((byCurrency[account.currency] ?? 0) + converted.amount);
      }
      items.push({
        class: CLASS_BY_ACCOUNT_TYPE[account.type] ?? 'OTHER_ASSETS',
        providerId: account.provider_id,
        accountId: account.id,
        valueBaseCurrency: converted ? converted.amount : 0,
      });

      // Le capital restant dû d'un crédit immobilier est une dette à part
      // entière : il diminue le patrimoine net même sans compte LIABILITY dédié.
      const loanDebt = this.#propertyLoanBalance(account.id);
      if (loanDebt > 0) {
        const convertedDebt = this.#convert(loanDebt, account.currency, rates, today);
        items.push({
          class: 'LIABILITIES',
          providerId: account.provider_id,
          accountId: `${account.id}:loan`,
          // Négatif dès l'agrégation : le patrimoine par établissement doit être net.
          valueBaseCurrency: convertedDebt ? -convertedDebt.amount : 0,
        });
      }
    }

    const totals = aggregateClassTotals(items);
    for (const excluded of totals.excluedBecauseNoFxRate) {
      void excluded;
    }
    // Les dettes sont déjà négatives (comptes LIABILITY et capital restant dû) :
    // le patrimoine net est donc la simple somme des classes.
    const byClass = { ...totals.byClass };
    const total = round(sum(WEALTH_CLASSES.map((key) => byClass[key] ?? 0)));
    this.#persistSnapshot(today, total, byClass, totals.byProvider);

    return { today, total, byClass, byProvider: totals.byProvider, warnings };
  }

  #persistSnapshot(
    date: string,
    total: number,
    byClass: Record<WealthClass, number>,
    byProvider: Record<string, number>,
  ): void {
    try {
      this.#db.run(
        `INSERT INTO net_worth_snapshots (date, total, by_class_json, by_provider_json, currency, computed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET total = excluded.total, by_class_json = excluded.by_class_json,
           by_provider_json = excluded.by_provider_json, computed_at = excluded.computed_at`,
        date,
        total,
        JSON.stringify(byClass),
        JSON.stringify(byProvider),
        this.#baseCurrency,
        new Date().toISOString(),
      );
    } catch {
      // L'écriture du snapshot est un cache : son échec ne doit jamais faire
      // échouer la réponse de l'API.
    }
  }

  /**
   * Série historique reconstruite depuis les activités et les cours.
   *
   * Un seul parcours chronologique : le cash est un cumul, les quantités sont
   * une file d'événements, et la valeur d'un instrument à une date est le
   * dernier cours connu à cette date (aucune extrapolation).
   */
  #series(today: string): NetWorthPoint[] {
    const accounts = this.#accounts.list().filter((account) => account.is_active === 1);
    const activityRows = this.#activities.listAll();
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const quotes = this.#market.quotesSince('1970-01-01');
    const propertyIds = new Set(this.#properties.listAccountIds());

    const events = activityRows
      .map((row) => ({ row, account: accounts.find((a) => a.id === row.account_id) }))
      .filter((event) => event.account)
      .sort((a, b) => (a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : 0));

    if (events.length === 0) {
      const snapshot = this.#snapshot();
      return [
        {
          date: today,
          total: snapshot.total,
          byClass: snapshot.byClass,
          byProvider: snapshot.byProvider,
        },
      ];
    }

    const firstDate = (events[0] as { row: ActivityRow }).row.date;
    const days = enumerateDays(firstDate, today);
    const cash = new Map<string, number>(accounts.map((account) => [account.id, account.initial_balance]));
    const quantities = new Map<string, number>();
    const costBasis = new Map<string, number>();
    const points: NetWorthPoint[] = [];
    let cursor = 0;

    const propertyValues = new Map<string, number>();
    for (const accountId of propertyIds) {
      const loaded = this.#properties.load(accountId);
      if (loaded) propertyValues.set(accountId, loaded.details.currentValue);
    }

    for (const day of days) {
      while (cursor < events.length && (events[cursor] as { row: ActivityRow }).row.date <= day) {
        const event = events[cursor] as { row: ActivityRow; account: AccountRow };
        const row = event.row;
        cash.set(row.account_id, round((cash.get(row.account_id) ?? 0) + row.amount));
        if (row.instrument_id && row.quantity) {
          const key = `${row.account_id}|${row.instrument_id}`;
          const sign = row.type === 'BUY' || row.type === 'TRANSFER_IN' ? 1 : row.type === 'SELL' || row.type === 'TRANSFER_OUT' ? -1 : 0;
          if (sign !== 0) {
            quantities.set(key, round((quantities.get(key) ?? 0) + sign * row.quantity));
            if (sign > 0) {
              costBasis.set(key, round((costBasis.get(key) ?? 0) + Math.abs(row.amount)));
            }
          }
        }
        cursor++;
      }

      const items: ClassTotalInput[] = [];
      for (const account of accounts) {
        let value = 0;
        if (account.type === 'CASH' || account.type === 'LIABILITY') {
          value = cash.get(account.id) ?? 0;
        } else if (account.type === 'REAL_ESTATE') {
          value = propertyValues.get(account.id) ?? 0;
        } else {
          for (const [key, quantity] of quantities) {
            if (!key.startsWith(`${account.id}|`)) continue;
            if (quantity === 0) continue;
            const instrumentId = key.slice(account.id.length + 1);
            const price = lastPriceAt(quotes.get(instrumentId) ?? [], day);
            const unitCost =
              quantity !== 0 ? (costBasis.get(key) ?? 0) / quantity : 0;
            value += quantity * (price ?? unitCost);
          }
        }
        const converted = this.#convert(value, account.currency, rates, day);
        if (converted === null) continue;
        items.push({
          class: CLASS_BY_ACCOUNT_TYPE[account.type] ?? 'OTHER_ASSETS',
          providerId: account.provider_id,
          accountId: account.id,
          valueBaseCurrency: converted.amount,
        });
        const loanDebt = this.#propertyLoanBalance(account.id, day);
        if (loanDebt > 0) {
          const convertedDebt = this.#convert(loanDebt, account.currency, rates, day);
          if (convertedDebt) {
            items.push({
              class: 'LIABILITIES',
              providerId: account.provider_id,
              accountId: `${account.id}:loan`,
              valueBaseCurrency: -convertedDebt.amount,
            });
          }
        }
      }

      const totals = aggregateClassTotals(items);
      const byClass = { ...totals.byClass };
      points.push({
        date: day,
        total: round(sum(WEALTH_CLASSES.map((key) => byClass[key] ?? 0))),
        byClass,
        byProvider: totals.byProvider,
      });
    }
    return points;
  }

  /**
   * Capital restant dû du crédit d'un bien à une date donnée.
   * Recalculé depuis l'échéancier (plutôt que lu en base) pour que la série
   * historique reflète l'amortissement réel mois après mois.
   */
  #propertyLoanBalance(accountId: string, asOf?: string): number {
    const loaded = this.#properties.load(accountId);
    const loan = loaded?.details.loan;
    if (!loan) return 0;
    if (loan.remainingPrincipal > 0) {
      // Capital restant dû fourni par la banque (relevé de prêt) : il fait foi.
      return loan.remainingPrincipal;
    }
    try {
      const schedule = amortizationSchedule({
        principal: loan.principal,
        annualRate: loan.annualRate,
        months: loan.months,
        startDate: loan.startDate,
        insuranceMonthly: loan.insuranceMonthly,
        monthlyPayment: loan.monthlyPayment,
        asOf: asOf ?? isoToday(),
      });
      return schedule.remainingPrincipal;
    } catch {
      // Échéancier impossible (mensualité insuffisante) : on n'invente pas de
      // montant, la dette est ignorée et le problème est visible dans l'IHM.
      return 0;
    }
  }

  #accountValue(
    account: AccountRow,
    latestQuotes: Map<string, { date: string; close: number; currency: string }>,
    today: string,
  ): { value: number; cash: number; invested: number; unrealizedPnl: number; realizedPnl: number } {
    if (account.type === 'CASH') {
      const cash = this.#activities.cashBalance(account.id, today);
      return { value: cash, cash, invested: 0, unrealizedPnl: 0, realizedPnl: 0 };
    }
    if (account.type === 'LIABILITY') {
      // Priorité au capital restant dû du crédit rattaché à un bien ; sinon le
      // solde du compte (montant négatif) fait foi.
      const loan = this.#db.get<{ remaining_principal: number }>(
        `SELECT l.remaining_principal FROM property_loans l
          JOIN properties p ON p.account_id = l.account_id WHERE p.account_id = ?`,
        account.id,
      );
      const value = loan ? -Math.abs(loan.remaining_principal) : -Math.abs(this.#activities.cashBalance(account.id, today));
      return { value, cash: 0, invested: 0, unrealizedPnl: 0, realizedPnl: 0 };
    }
    if (account.type === 'REAL_ESTATE') {
      const loaded = this.#properties.load(account.id);
      if (loaded) {
        const metrics = computePropertyMetrics({ property: loaded.details, cashFlows: loaded.cashFlows });
        return {
          value: loaded.details.currentValue,
          cash: 0,
          invested: metrics.totalCost,
          unrealizedPnl: metrics.unrealizedGain,
          realizedPnl: 0,
        };
      }
      const latest = this.#db.get<{ value: number }>(
        'SELECT value FROM valuations WHERE account_id = ? AND instrument_id IS NULL ORDER BY date DESC LIMIT 1',
        account.id,
      );
      return { value: latest?.value ?? 0, cash: 0, invested: 0, unrealizedPnl: 0, realizedPnl: 0 };
    }

    // Titres / crypto : positions calculées, valorisées au dernier cours connu.
    const activityRows = this.#activities.listForAccount(account.id);
    if (activityRows.length === 0) {
      return { value: 0, cash: 0, invested: 0, unrealizedPnl: 0, realizedPnl: 0 };
    }
    const domain = activityRows.map((row) => toDomainActivity(row, account.currency));
    const lastPrices: Record<string, number> = {};
    for (const activity of domain) {
      if (!activity.instrumentId) continue;
      const quote = latestQuotes.get(activity.instrumentId);
      if (quote) lastPrices[activity.instrumentId] = quote.close;
    }
    const calc = computePositions({ activities: domain, lastPrices, currency: account.currency });
    const marketValue = round(sum(calc.positions.map((position) => position.marketValue)));
    // Le cash résiduel d'un compte-titres (espèces non investies) est inclus.
    const cashPart = this.#db.get<{ total: number | null }>(
      `SELECT SUM(amount) AS total FROM activities WHERE account_id = ? AND instrument_id IS NULL`,
      account.id,
    );
    const cash = round(cashPart?.total ?? 0);
    const cost = round(sum(calc.positions.map((position) => position.costBasis)));
    return {
      value: round(marketValue + cash),
      cash,
      invested: cost,
      unrealizedPnl: round(marketValue - cost),
      realizedPnl: calc.realizedPnl,
    };
  }

  #convert(
    amount: number,
    from: string,
    rates: readonly FxRate[],
    date: string,
  ): { amount: number; rate: number } | null {
    if (from === this.#baseCurrency) return { amount: round(amount), rate: 1 };
    const converted = convert(amount, from, this.#baseCurrency, rates, date);
    if (converted) return converted;
    // Repli : certains fournisseurs ne publient que des paires pivot. On tente
    // une conversion via EUR si la paire directe manque.
    const direct = findRate(rates, from, this.#baseCurrency, date);
    if (direct) return { amount: round(amount * direct.rate), rate: direct.rate };
    return null;
  }

  #allocationByCurrency(snapshot: {
    byClass: Record<WealthClass, number>;
  }): AllocationSlice[] {
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const byCurrency = new Map<string, number>();
    for (const account of this.#accounts.list()) {
      const latestQuotes = this.#market.latestQuotes();
      const values = this.#accountValue(account, latestQuotes, isoToday());
      const converted = this.#convert(values.value, account.currency, rates, isoToday());
      if (converted) byCurrency.set(account.currency, round((byCurrency.get(account.currency) ?? 0) + converted.amount));
    }
    void snapshot;
    return toSlices(Object.fromEntries(byCurrency), {});
  }

  #allocationByCountry(): AllocationSlice[] {
    const rows = this.#db.all<{ country: string | null; total: number }>(
      `SELECT i.country, ROUND(SUM(COALESCE(a.amount, 0)), 2) AS total
         FROM instruments i JOIN activities a ON a.instrument_id = i.id
        WHERE a.type = 'BUY' GROUP BY i.country ORDER BY total DESC`,
    );
    const map: Record<string, number> = {};
    for (const row of rows) map[row.country ?? 'Non renseigné'] = row.total;
    return toSlices(map, {});
  }

  #groupSlices<T>(items: readonly T[], keyOf: (item: T) => string, valueOf: (item: T) => number): AllocationSlice[] {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = keyOf(item);
      map.set(key, round((map.get(key) ?? 0) + valueOf(item)));
    }
    return toSlices(Object.fromEntries(map), {});
  }

  #performanceFor(period: PeriodKey): InvestmentsResponse['performance'] {
    const snapshot = this.#snapshot();
    const points = this.#series(snapshot.today);
    const firstDate = points[0]?.date ?? snapshot.today;
    const from = startOfPeriod(snapshot.today, period, firstDate);
    const flows = classifyFlows(
      this.#activities.listAll().map((row) => toDomainActivity(row)),
      from,
    );
    return this.#performanceFromPoints(
      points.filter((point) => point.date >= from),
      flows.external,
      period,
      firstDate,
    );
  }

  #performanceForAccount(accountId: string, period: PeriodKey): InvestmentsResponse['performance'] {
    const rows = this.#activities.listForAccount(accountId);
    if (rows.length === 0) {
      return { twr: null, xirr: null, maxDrawdown: null, annualized: null, period, note: 'Aucune donnée pour ce compte.' };
    }
    const domain = rows.map((row) => toDomainActivity(row));
    const flows = classifyFlows(domain);
    const today = isoToday();
    const latestQuotes = this.#market.latestQuotes();
    const lastPrices: Record<string, number> = {};
    for (const activity of domain) {
      if (activity.instrumentId && latestQuotes.get(activity.instrumentId)) {
        lastPrices[activity.instrumentId] = latestQuotes.get(activity.instrumentId)!.close;
      }
    }
    const calc = computePositions({ activities: domain, lastPrices });
    const finalValue = round(sum(calc.positions.map((position) => position.marketValue)));
    const from = startOfPeriod(today, period, (rows[0] as ActivityRow).date);
    const windowedFlows = flows.external.filter((flow) => flow.date >= from);
    const rate = xirr(buildXirrFlows(windowedFlows, today, finalValue));
    return {
      twr: null,
      xirr: rate,
      maxDrawdown: null,
      annualized: null,
      period,
      note: 'TWR indisponible par compte : nécessite une valorisation quotidienne (synchro régulière).',
    };
  }

  #performanceFromPoints(
    points: readonly NetWorthPoint[],
    externalFlows: readonly { date: string; amount: number }[],
    period: PeriodKey,
    firstDate: string,
  ): InvestmentsResponse['performance'] {
    if (points.length < 2) {
      return {
        twr: null,
        xirr: null,
        maxDrawdown: null,
        annualized: null,
        period,
        note: 'Historique insuffisant : au moins deux points de valorisation sont nécessaires.',
      };
    }
    const values = points.map((point) => ({ date: point.date, value: point.total }));
    const twrPercent = twr(values, externalFlows);
    const last = points[points.length - 1] as NetWorthPoint;
    const first = points[0] as NetWorthPoint;
    const flowSum = round(sum(externalFlows.map((flow) => flow.amount)));
    const investedCapital = round(first.total + Math.max(0, flowSum));
    const rate = xirr(
      buildXirrFlows(externalFlows, last.date, last.total),
    );
    const days = Math.max(1, (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000);
    return {
      twr: twrPercent,
      xirr: rate,
      maxDrawdown: maxDrawdown(values),
      annualized:
        twrPercent === null
          ? null
          : round(((1 + twrPercent / 100) ** (365 / days) - 1) * 100, 4),
      period,
      note:
        investedCapital > 0
          ? `Capital de départ ${first.date} : ${round(first.total)} ${this.#baseCurrency}. Périmètre depuis ${firstDate}.`
          : null,
    };
  }
}

function toSlices(
  values: Readonly<Record<string, number>>,
  labels: Readonly<Record<string, string>>,
): AllocationSlice[] {
  const entries = Object.entries(values).filter(([, value]) => value !== 0);
  const total = sum(entries.map(([, value]) => Math.abs(value)));
  return entries
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      value: round(value),
      percent: total > 0 ? round((Math.abs(value) / total) * 100, 2) : 0,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

function lastPriceAt(
  quotes: readonly { date: string; close: number }[],
  day: string,
): number | null {
  let price: number | null = null;
  for (const quote of quotes) {
    if (quote.date <= day) price = quote.close;
    else break;
  }
  return price;
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < 20_000) {
    days.push(cursor);
    cursor = new Date(Date.parse(`${cursor}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    guard++;
  }
  if (days[days.length - 1] !== to) days.push(to);
  return days;
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export { PERIOD_DAYS, pointAt, variation, allocation, WEALTH_CLASSES, CLASS_LABELS };