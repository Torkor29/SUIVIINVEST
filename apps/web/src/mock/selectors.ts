/**
 * Sélecteurs de la maquette : construisent les réponses DTO à partir des
 * données de fixtures. Fonctions pures (hors `now`), réutilisables par les tests.
 */
import type {
  AccountsResponse,
  AllocationSlice,
  CryptoResponse,
  InvestmentsResponse,
  NetWorthResponse,
  PeriodKey,
  PropertyDto,
  RealEstateResponse,
  TransactionDto,
  TransactionsQuery,
  TransactionsResponse,
  AccountSummary,
} from '@suiviinvest/api-contract';
import { buildAccounts, accountValueEur } from './accounts.ts';
import { buildProperties } from './realestate.ts';
import { buildPositions } from './holdings.ts';
import { buildWallets, cryptoTotalEur } from './crypto.ts';
import { buildTransactions } from './transactions.ts';
import { buildNetWorthSeries, currentNetWorthEur, debtsEur, grossAssetsEur } from './networth.ts';
import { PROVIDERS, TYPE_LABELS, providerName } from './accountsMeta.ts';
import { slicesFromValues, topSlices } from '../lib/allocation.ts';
import { filterSeriesByPeriod, variationsFromSeries } from '../lib/period.ts';
import { toIsoDay } from '../lib/format.ts';
import { round2 } from './random.ts';

const WARNINGS: readonly string[] = [
  'Revolut (USD) converti au taux du jour retenu (1 USD = 0,92 €).',
  '2 instruments sans cotation récente valorisés au dernier prix connu.',
];

function classOf(account: AccountSummary): string {
  switch (account.type) {
    case 'INVESTMENT':
      return 'Actions-ETF';
    case 'CRYPTO':
      return 'Crypto';
    case 'REAL_ESTATE':
      return 'Immobilier';
    case 'CASH':
    case 'SAVINGS':
      return account.id === 'acc-divers' ? 'Autres actifs' : 'Cash';
    default:
      return 'Autres actifs';
  }
}

function assetsAccounts(now: Date): AccountSummary[] {
  return buildAccounts(now).filter((account) => account.type !== 'REAL_ESTATE');
}

/** Répartition par grande classe d'actif (dettes en négatif). */
export function byClassSlices(now: Date = new Date()): AllocationSlice[] {
  const buckets = new Map<string, number>();
  for (const account of assetsAccounts(now)) {
    const value = accountValueEur(account) ?? 0;
    buckets.set(classOf(account), (buckets.get(classOf(account)) ?? 0) + value);
  }
  const properties = buildProperties().reduce((sum, property) => sum + property.currentValue, 0);
  buckets.set('Immobilier', (buckets.get('Immobilier') ?? 0) + properties);
  const slices = slicesFromValues(
    [...buckets.entries()].map(([label, value]) => ({ key: label, label, value: round2(value) })),
    grossAssetsEur(now),
  );
  const debts = debtsEur();
  if (debts > 0) {
    slices.push({ key: 'Dettes', label: 'Dettes', value: -debts, percent: round2((-debts / grossAssetsEur(now)) * 100) });
  }
  return slices.sort((a, b) => b.value - a.value);
}

/** Répartition par établissement (Crédit Agricole, DEGIRO, …). */
export function byProviderSlices(now: Date = new Date()): AllocationSlice[] {
  const buckets = new Map<string, { value: number; label: string }>();
  for (const account of assetsAccounts(now)) {
    const value = accountValueEur(account) ?? 0;
    const label = providerName(account.providerId);
    const current = buckets.get(account.providerId);
    buckets.set(account.providerId, { value: (current?.value ?? 0) + value, label });
  }
  const properties = buildProperties().reduce((sum, property) => sum + property.currentValue, 0);
  const huge = buckets.get('autres');
  buckets.set('autres', { value: (huge?.value ?? 0) + properties, label: 'Autres' });
  const slices = slicesFromValues(
    [...buckets.entries()].map(([key, bucket]) => ({ key, label: bucket.label, value: round2(bucket.value) })),
  );
  return slices.length === 0 ? slicesFromValues(PROVIDERS.map((provider) => ({ key: provider.id, label: provider.name, value: 0 }))) : slices;
}

/** Répartition par devise de cotation. */
export function byCurrencySlices(now: Date = new Date()): AllocationSlice[] {
  const buckets = new Map<string, number>();
  for (const account of buildAccounts(now)) {
    if (account.type === 'REAL_ESTATE') continue;
    buckets.set(account.valueCurrency, (buckets.get(account.valueCurrency) ?? 0) + (accountValueEur(account) ?? 0));
  }
  const properties = buildProperties().reduce((sum, property) => sum + property.currentValue, 0);
  buckets.set('EUR', (buckets.get('EUR') ?? 0) + properties);
  return slicesFromValues([...buckets.entries()].map(([code, value]) => ({ key: code, label: code === 'EUR' ? 'Euro (EUR)' : code, value: round2(value) })));
}

export function netWorthResponse(period: PeriodKey = '1Y', now: Date = new Date()): NetWorthResponse {
  const fullSeries = buildNetWorthSeries(now);
  const variations = variationsFromSeries(fullSeries, now);
  return {
    asOf: toIsoDay(now),
    // La maquette mélange un historique reconstruit depuis les opérations et des
    // relevés réellement enregistrés : elle se déclare donc `MIXED`.
    historySource: 'MIXED',
    recordedSince: '2026-09-01',
    currency: 'EUR',
    total: currentNetWorthEur(now),
    variationToday: variations.today,
    variation1M: variations.oneMonth,
    variationYtd: variations.ytd,
    variation1Y: variations.oneYear,
    variationAll: variations.all,
    series: filterSeriesByPeriod(fullSeries, period, now),
    byClass: byClassSlices(now),
    byProvider: byProviderSlices(now),
    byCurrency: byCurrencySlices(now),
    warnings: WARNINGS,
  };
}

export function accountsResponse(): AccountsResponse {
  const accounts = buildAccounts();
  const byType = slicesFromValues(
    [...accounts.reduce((map, account) => map.set(account.type, (map.get(account.type) ?? 0) + (accountValueEur(account) ?? 0)), new Map<string, number>()).entries()].map(
      ([type, value]) => ({ key: type, label: TYPE_LABELS[type] ?? type, value: round2(value) }),
    ),
  );
  return {
    accounts,
    totals: {
      byType,
      byProvider: byProviderSlices(),
      total: round2(accounts.reduce((sum, account) => sum + (accountValueEur(account) ?? 0), 0)),
    },
  };
}
/** Positions par compte, pour la page Investissements. */
export function investmentsResponse(accountId?: string | null): InvestmentsResponse {
  const all = buildPositions();
  const positions = accountId === undefined || accountId === null || accountId === '' ? all : all.filter((position) => position.accountId === accountId);
  const marketValue = round2(positions.reduce((sum, position) => sum + position.marketValueEur, 0));
  const costBasis = round2(positions.reduce((sum, position) => sum + position.costBasis, 0));
  const unrealizedPnl = round2(positions.reduce((sum, position) => sum + position.unrealizedPnl, 0));
  return {
    positions,
    currency: 'EUR',
    totals: {
      marketValue,
      costBasis,
      unrealizedPnl,
      unrealizedPnlPercent: costBasis === 0 ? 0 : round2((unrealizedPnl / costBasis) * 100),
      realizedPnl: round2(positions.reduce((sum, position) => sum + position.realizedPnl, 0)),
      dividends: round2(positions.reduce((sum, position) => sum + position.dividends, 0)),
      fees: round2(positions.reduce((sum, position) => sum + position.fees, 0)),
    },
    performance: {
      twr: 8.42,
      xirr: 7.18,
      maxDrawdown: -12.6,
      annualized: 7.94,
      period: '1Y',
      note: 'Performance quotidienne, hors flux de trésorerie.',
    },
    allocation: topSlices(
      slicesFromValues(positions.map((position) => ({ key: position.instrumentId, label: position.symbol ?? position.name, value: position.marketValueEur }))),
      8,
    ),
    warnings: WARNINGS,
  };
}

export function cryptoResponse(): CryptoResponse {
  const wallets = buildWallets();
  const assets = wallets.flatMap((wallet) => wallet.assets);
  return {
    wallets,
    totalEur: cryptoTotalEur(),
    allocation: slicesFromValues(assets.map((asset) => ({ key: asset.symbol, label: asset.symbol, value: asset.valueEur }))),
    byChain: slicesFromValues(
      [...assets.reduce((map, asset) => map.set(asset.chain, (map.get(asset.chain) ?? 0) + asset.valueEur), new Map<string, number>()).entries()].map(
        ([chain, value]) => ({ key: chain, label: chain.charAt(0).toUpperCase() + chain.slice(1), value: round2(value) }),
      ),
    ),
    warnings: ['Clé publique uniquement : aucune signature ni transfert possible depuis SuiviInvest.'],
  };
}

export function realEstateResponse(): RealEstateResponse {
  const properties = buildProperties();
  const currentValue = round2(properties.reduce((sum, property) => sum + property.currentValue, 0));
  const loanBalance = round2(properties.reduce((sum, property) => sum + property.metrics.loanBalance, 0));
  const annualIncome = round2(properties.reduce((sum, property) => sum + property.metrics.annualIncome, 0));
  return {
    properties,
    totals: {
      currentValue,
      loanBalance,
      equity: round2(currentValue - loanBalance),
      annualIncome,
      annualExpenses: round2(properties.reduce((sum, property) => sum + property.metrics.annualExpenses, 0)),
      annualCashFlowAfterLoan: round2(properties.reduce((sum, property) => sum + property.metrics.annualCashFlowAfterLoan, 0)),
      interestPaid: round2(properties.reduce((sum, property) => sum + property.metrics.interestPaid, 0)),
      unrealizedGain: round2(properties.reduce((sum, property) => sum + property.metrics.unrealizedGain, 0)),
    },
    portfolio: {
      grossYield: currentValue === 0 ? 0 : round2((annualIncome / currentValue) * 100),
      netYield:
        currentValue === 0
          ? 0
          : round2((round2(properties.reduce((sum, property) => sum + property.metrics.annualCashFlow, 0)) / currentValue) * 100),
      monthlyCashFlow: round2(properties.reduce((sum, property) => sum + property.metrics.monthlyCashFlowAfterLoan, 0)),
    },
  };
}

export function propertyDto(accountId: string): PropertyDto | null {
  return buildProperties().find((property) => property.accountId === accountId) ?? null;
}

/** Filtre l'historique selon la requête Transactions (recherche, montants, curseur). */
export function filterTransactions(items: readonly TransactionDto[], query: TransactionsQuery): TransactionDto[] {
  const search = query.search?.trim().toLowerCase() ?? '';
  return items.filter((item) => {
    if (query.from !== undefined && item.date < query.from) return false;
    if (query.to !== undefined && item.date > query.to) return false;
    if (query.providerId !== undefined && item.providerId !== query.providerId) return false;
    if (query.accountId !== undefined && item.accountId !== query.accountId) return false;
    if (query.type !== undefined && item.type !== query.type) return false;
    if (query.currency !== undefined && item.currency !== query.currency) return false;
    if (query.minAmount !== undefined && item.amountEur < query.minAmount) return false;
    if (query.maxAmount !== undefined && item.amountEur > query.maxAmount) return false;
    if (search !== '') {
      const haystack = `${item.description ?? ''} ${item.instrumentName ?? ''} ${item.isin ?? ''} ${item.accountName}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export function transactionsResponse(query: TransactionsQuery, now: Date = new Date()): TransactionsResponse {
  const all = buildTransactions(now);
  const filtered = filterTransactions(all, query);
  const limit = query.limit ?? 50;
  const offset = query.cursor === undefined || query.cursor === null || query.cursor === '' ? 0 : Number.parseInt(query.cursor, 10);
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const items = filtered.slice(start, start + limit);
  const nextOffset = start + items.length;
  return {
    items,
    nextCursor: nextOffset < filtered.length ? `${nextOffset}` : null,
    total: filtered.length,
    totalsByType: slicesFromValues(
      [...filtered.reduce((map, item) => map.set(item.type, (map.get(item.type) ?? 0) + Math.abs(item.amountEur)), new Map<string, number>()).entries()].map(
        ([type, value]) => ({ key: type, label: type, value: round2(value) }),
      ),
    ),
  };
}
