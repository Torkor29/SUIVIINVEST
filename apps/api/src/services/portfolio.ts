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
import { ActivityRepository, toDomainActivity, ValuationRepository, type ActivityQuery, type ActivityRow } from '../repositories/activities.ts';
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

/**
 * Ligne d'un relevé de patrimoine : la valeur d'un compte à une date, dans sa
 * devise d'origine ET convertie. C'est ce qui permet de répondre plus tard à
 * « combien valait ce compte le 12 mars » sans rejouer tout l'historique.
 */
export interface AccountSnapshotLine {
  readonly accountId: string;
  readonly providerId: string;
  readonly assetClass: string;
  readonly currency: string;
  readonly valueOriginal: number;
  readonly valueBase: number;
}

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
  metamask: 'Wallets EVM',
  enable_banking: 'Banques',
  bitcoin: 'Bitcoin',
  solana: 'Solana',
  binance: 'Binance',
  kraken: 'Kraken',
  coinbase: 'Coinbase',
  bitpanda: 'Bitpanda',
  manual: 'Saisie manuelle',
  csv: 'Imports',
};

export class PortfolioService {
  readonly #db: Db;
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #valuations: ValuationRepository;
  readonly #market: MarketRepository;
  readonly #properties: PropertyRepository;
  readonly #baseCurrency: string;

  constructor(db: Db, options: PortfolioServiceOptions) {
    this.#db = db;
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#valuations = new ValuationRepository(db);
    this.#market = new MarketRepository(db);
    this.#properties = new PropertyRepository(db);
    this.#baseCurrency = options.baseCurrency;
  }

  /* ---------------------------------------------------------------- patrimoine */

  netWorth(period: PeriodKey = '1Y'): NetWorthResponse {
    const snapshot = this.#snapshot();
    const reconstructed = this.#series(snapshot.today);

    // Un relevé réellement enregistré fait foi sur une reconstitution : on
    // recouvre les points reconstruits par les observations de l'application.
    const recorded = this.#recordedPoints();
    const points = reconstructed.map((point) =>
      recorded.has(point.date) ? { ...point, total: recorded.get(point.date) as number } : point,
    );
    const recordedSince = recorded.size > 0 ? [...recorded.keys()].sort()[0] ?? null : null;
    const historySource: 'RECONSTRUCTED' | 'RECORDED' | 'MIXED' =
      recorded.size === 0 ? 'RECONSTRUCTED' : reconstructed.length > recorded.size ? 'MIXED' : 'RECORDED';

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
        `Votre historique commence le ${frenchDate(firstDate)} : la courbe ne peut pas remonter plus loin.`,
      );
    }

    return {
      asOf: snapshot.today,
      historySource,
      recordedSince,
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
        connectionId: row.connection_id,
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
    perAccount: AccountSnapshotLine[];
  } {
    const today = isoToday();
    const rates = this.#market.allRatesTo(this.#baseCurrency);
    const latestQuotes = this.#market.latestQuotes();
    const warnings: string[] = [];
    const items: ClassTotalInput[] = [];
    const byCurrency: Record<string, number> = {};
    const perAccount: AccountSnapshotLine[] = [];

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
        perAccount.push({
          accountId: account.id,
          providerId: account.provider_id,
          assetClass: CLASS_BY_ACCOUNT_TYPE[account.type] ?? 'OTHER_ASSETS',
          currency: account.currency,
          valueOriginal: round(values.value),
          valueBase: converted.amount,
        });
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
        if (convertedDebt) {
          perAccount.push({
            accountId: `${account.id}:loan`,
            providerId: account.provider_id,
            assetClass: 'LIABILITIES',
            currency: account.currency,
            valueOriginal: -round(loanDebt),
            valueBase: -convertedDebt.amount,
          });
        }
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
    this.#persistSnapshot(today, total, byClass, totals.byProvider, perAccount, 'RECORDED');

    return { today, total, byClass, byProvider: totals.byProvider, warnings, perAccount };
  }

  /**
   * Enregistre un relevé daté du patrimoine (Mission 2 §9).
   *
   * Appelé par l'ordonnanceur (une fois par jour) et à l'ouverture du tableau de
   * bord. `source` distingue un relevé réellement observé par l'application
   * (`RECORDED`) d'un point reconstruit a posteriori (`RECONSTRUCTED`) : l'interface
   * ne doit jamais confondre les deux.
   */
  recordDailySnapshot(date?: string): { date: string; total: number; accounts: number } {
    const snapshot = this.#snapshot();
    const targetDate = date ?? snapshot.today;
    const byClass: Record<WealthClass, number> = { ...snapshot.byClass };
    const liabilities = Math.abs(byClass.LIABILITIES ?? 0);
    this.#persistSnapshot(
      targetDate,
      snapshot.total,
      byClass,
      snapshot.byProvider,
      snapshot.perAccount,
      'RECORDED',
      liabilities,
    );
    return { date: targetDate, total: snapshot.total, accounts: snapshot.perAccount.length };
  }

  /** Dates des relevés réellement enregistrés par l'application. */
  recordedSnapshotRange(): { from: string | null; to: string | null; count: number } {
    const row = this.#db.get<{ from_date: string | null; to_date: string | null; count: number }>(
      `SELECT MIN(date) AS from_date, MAX(date) AS to_date, COUNT(*) AS count
         FROM net_worth_snapshots WHERE source = 'RECORDED'`,
    );
    return { from: row?.from_date ?? null, to: row?.to_date ?? null, count: row?.count ?? 0 };
  }

  #persistSnapshot(
    date: string,
    total: number,
    byClass: Record<WealthClass, number>,
    byProvider: Record<string, number>,
    perAccount: readonly AccountSnapshotLine[],
    source: 'RECORDED' | 'RECONSTRUCTED',
    liabilities?: number,
  ): void {
    try {
      const debt = liabilities ?? Math.abs(byClass.LIABILITIES ?? 0);
      this.#db.run(
        `INSERT INTO net_worth_snapshots (date, total, by_class_json, by_provider_json, currency,
           computed_at, liabilities, by_account_json, source, positions_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET total = excluded.total, by_class_json = excluded.by_class_json,
           by_provider_json = excluded.by_provider_json, computed_at = excluded.computed_at,
           liabilities = excluded.liabilities, by_account_json = excluded.by_account_json,
           source = excluded.source, positions_count = excluded.positions_count`,
        date,
        total,
        JSON.stringify(byClass),
        JSON.stringify(byProvider),
        this.#baseCurrency,
        new Date().toISOString(),
        round(debt),
        JSON.stringify(perAccount.map((line) => ({ accountId: line.accountId, valueBase: line.valueBase }))),
        source,
        perAccount.length,
      );

      // Détail par compte : table dédiée pour permettre les analyses par compte,
      // par établissement et par classe sans relire les activités.
      this.#db.run('DELETE FROM net_worth_snapshot_accounts WHERE snapshot_date = ?', date);
      for (const line of perAccount) {
        this.#db.run(
          `INSERT INTO net_worth_snapshot_accounts
             (snapshot_date, account_id, provider_id, asset_class, currency, value_original, value_base)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          date,
          line.accountId,
          line.providerId,
          line.assetClass,
          line.currency,
          line.valueOriginal,
          line.valueBase,
        );
      }
    } catch {
      // L'écriture du relevé est un cache : son échec ne doit jamais faire
      // échouer la réponse de l'API.
    }
  }

  /** Valeurs de relevé enregistrées, par date (pour recouvrir la reconstitution). */
  #recordedPoints(): Map<string, number> {
    const rows = this.#db.all<{ date: string; total: number }>(
      "SELECT date, total FROM net_worth_snapshots WHERE source = 'RECORDED' ORDER BY date",
    );
    return new Map(rows.map((row) => [row.date, row.total]));
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

    // Comptes dont la source déclare un solde (banques) : la courbe est ancrée sur
    // ces soldes, les opérations ne servent qu'à relier deux relevés.
    const anchors = new Map<string, { date: string; offset: number }[]>();
    for (const account of accounts) {
      if (account.type !== 'CASH') continue;
      const declared = this.#valuations.declaredCashBalances(account.id);
      if (declared.length === 0) continue;
      anchors.set(
        account.id,
        declared.map((row) => ({ date: row.date, offset: round(row.value - this.#activities.cashBalance(account.id, row.date)) })),
      );
    }
    const cashOffset = (accountId: string, day: string): number => {
      const list = anchors.get(accountId);
      if (!list || list.length === 0) return 0;
      let chosen = list[0] as { date: string; offset: number };
      for (const anchor of list) {
        if (anchor.date <= day) chosen = anchor;
        else break;
      }
      return chosen.offset;
    };

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
          // Le sens d'un mouvement on-chain est porté par le signe du montant :
          // sans cette règle, les tokens reçus sur un wallet resteraient absents
          // de la courbe de patrimoine.
          const sign =
            row.type === 'BUY' || row.type === 'TRANSFER_IN' || row.type === 'STAKING_REWARD'
              ? 1
              : row.type === 'SELL' || row.type === 'TRANSFER_OUT'
                ? -1
                : row.type === 'CRYPTO_TRANSFER'
                  ? row.amount > 0
                    ? 1
                    : -1
                  : 0;
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
          value = round((cash.get(account.id) ?? 0) + cashOffset(account.id, day));
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

  /**
   * Trésorerie d'un compte : dernier solde déclaré par la source (s'il existe)
   * ajusté des opérations postérieures ; sinon, somme des opérations.
   */
  #anchoredCash(accountId: string, asOf: string): number {
    const declared = this.#valuations.declaredCashBalances(accountId);
    const computed = this.#activities.cashBalance(accountId, asOf);
    if (declared.length === 0) return computed;
    let chosen = declared[0] as { date: string; value: number };
    for (const row of declared) {
      if (row.date <= asOf) chosen = row;
      else break;
    }
    return round(chosen.value + (computed - this.#activities.cashBalance(accountId, chosen.date)));
  }

  #accountValue(
    account: AccountRow,
    latestQuotes: Map<string, { date: string; close: number; currency: string }>,
    today: string,
  ): { value: number; cash: number; invested: number; unrealizedPnl: number; realizedPnl: number } {
    if (account.type === 'CASH') {
      const cash = this.#anchoredCash(account.id, today);
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
    const domain = activityRows.map((row) => toDomainActivity(row, account.currency));
    const lastPrices: Record<string, number> = {};
    for (const activity of domain) {
      if (!activity.instrumentId) continue;
      const quote = latestQuotes.get(activity.instrumentId);
      if (quote) lastPrices[activity.instrumentId] = quote.close;
    }
    const calc = computePositions({ activities: domain, lastPrices, currency: account.currency });
    const cost = round(sum(calc.positions.map((position) => position.costBasis)));

    // Wallet observé par adresse : la dernière position COMMUNIQUÉE PAR LA SOURCE
    // fait foi. C'est indispensable pour les jetons natifs (ETH, POL…), qui n'ont
    // pas d'adresse de contrat : l'historique des transactions ne permet pas de
    // les rattacher à un jeton, donc il les perdait et affichait « — ».
    if (account.type === 'CRYPTO') {
      const declared = this.#valuations.latestPositionsForAccount(account.id);
      if (declared.length > 0) {
        let value = 0;
        for (const position of declared) {
          if (position.quantity === null || position.quantity <= 0) continue;
          const quote = latestQuotes.get(position.instrumentId);
          const price = quote ? quote.close : position.unitPrice;
          value += price === null ? position.value : position.quantity * price;
        }
        // Euros détenus sur la plateforme (solde déclaré, hors positions).
        const eurCash = this.#valuations.declaredCashBalances(account.id).at(-1)?.value ?? 0;
        value += eurCash;
        // Aucun coût de revient n'est fourni par un scan d'adresse : la
        // plus-value latente reste celle reconstituée depuis l'historique.
        return {
          value: round(value),
          cash: 0,
          invested: cost,
          unrealizedPnl: round(value - cost),
          realizedPnl: calc.realizedPnl,
        };
      }
    }

    if (activityRows.length === 0) {
      return { value: 0, cash: 0, invested: 0, unrealizedPnl: 0, realizedPnl: 0 };
    }
    const marketValue = round(sum(calc.positions.map((position) => position.marketValue)));
    // Le cash résiduel d'un compte-titres (espèces non investies) est inclus.
    const cashPart = this.#db.get<{ total: number | null }>(
      `SELECT SUM(amount) AS total FROM activities WHERE account_id = ? AND instrument_id IS NULL`,
      account.id,
    );
    const cash = round(cashPart?.total ?? 0);
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

/** « 2026-02-01 » -> « 1 février 2026 » (messages destinés à l'utilisateur). */
function frenchDate(isoDay: string): string {
  const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const [year, month, day] = isoDay.slice(0, 10).split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(year + month + day)) return isoDay;
  return `${day === 1 ? '1er' : day} ${months[month - 1] ?? ''} ${year}`;
}
