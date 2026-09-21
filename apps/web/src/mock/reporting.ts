/**
 * Sélecteurs de reporting de la maquette : revenus, analyses, connexions,
 * paramètres, santé et imports.
 */
import type {
  AnalyticsResponse,
  ConnectionDto,
  ConnectionsResponse,
  HealthResponse,
  ImportAnalyzeResponse,
  ImportCommitResponse,
  ImportHistoryDto,
  IncomeResponse,
  PeriodKey,
  SettingsDto,
  SyncRunDto,
  TransactionDto,
} from '@suiviinvest/api-contract';
import { buildAccounts, accountValueEur } from './accounts.ts';
import { buildProperties } from './realestate.ts';
import { buildPositions } from './holdings.ts';
import { buildTransactions } from './transactions.ts';
import { buildNetWorthSeries, currentNetWorthEur, debtsEur, grossAssetsEur } from './networth.ts';
import { CONNECTIONS, PROVIDER_CATALOG, SYNC_RUNS } from './connections.ts';
import { HEALTH, IMPORT_HISTORY, MARKET_REFRESH, SETTINGS } from './settings.ts';
import { providerName } from '../lib/labels.ts';
import { cryptoTotalEur } from './crypto.ts';
import { byClassSlices, byCurrencySlices } from './selectors.ts';
import { slicesFromValues, topSlices } from '../lib/allocation.ts';
import { filterSeriesByPeriod, periodStart } from '../lib/period.ts';
import { toIsoDay } from '../lib/format.ts';
import { round2 } from './random.ts';

export function incomeTransactions(period: PeriodKey, now: Date = new Date()): TransactionDto[] {
  const start = periodStart(period, now);
  const startIso = start === null ? '0000-01-01' : toIsoDay(start);
  return buildTransactions(now).filter(
    (item) => item.date >= startIso && (item.type === 'DIVIDEND' || item.type === 'INTEREST' || item.type === 'RENT'),
  );
}

export function incomeResponse(period: PeriodKey = '1Y', now: Date = new Date()): IncomeResponse {
  const items = incomeTransactions(period, now);
  const total = round2(items.reduce((sum, item) => sum + item.amountEur, 0));
  const months = new Set(items.map((item) => item.date.slice(0, 7)));
  const monthCount = Math.max(months.size, 1);
  const byMonth = [...months]
    .sort()
    .map((month) => ({ month, value: round2(items.filter((item) => item.date.startsWith(month)).reduce((sum, item) => sum + item.amountEur, 0)) }));
  return {
    period,
    total,
    byType: slicesFromValues(
      [...items.reduce((map, item) => map.set(item.type, (map.get(item.type) ?? 0) + item.amountEur), new Map<string, number>()).entries()].map(
        ([type, value]) => ({ key: type, label: incomeTypeLabel(type), value: round2(value) }),
      ),
    ),
    byMonth,
    byAccount: slicesFromValues(
      [...items.reduce((map, item) => map.set(item.accountId, (map.get(item.accountId) ?? 0) + item.amountEur), new Map<string, number>()).entries()].map(
        ([accountId, value]) => ({ key: accountId, label: accountNameIn(items, accountId), value: round2(value) }),
      ),
    ),
    byProvider: slicesFromValues(
      [...items.reduce((map, item) => map.set(item.providerId, (map.get(item.providerId) ?? 0) + item.amountEur), new Map<string, number>()).entries()].map(
        ([providerId, value]) => ({ key: providerId, label: providerName(providerId), value: round2(value) }),
      ),
    ),
    forwardAnnualized: round2((total / monthCount) * 12),
    items,
  };
}

function incomeTypeLabel(type: string): string {
  if (type === 'DIVIDEND') return 'Dividendes';
  if (type === 'INTEREST') return 'Intérêts';
  if (type === 'RENT') return 'Loyers';
  return type;
}

function accountNameIn(items: readonly TransactionDto[], accountId: string): string {
  return items.find((item) => item.accountId === accountId)?.accountName ?? accountId;
}

export function analyticsResponse(period: PeriodKey = '1Y', now: Date = new Date()): AnalyticsResponse {
  const series = buildNetWorthSeries(now);
  const scoped = filterSeriesByPeriod(series, period, now);
  const transactions = buildTransactions(now);
  const monthKeys = [...new Set(transactions.map((item) => item.date.slice(0, 7)))].sort().slice(-24);
  const positions = buildPositions();
  return {
    period,
    performance: {
      twr: 9.1,
      xirr: 7.62,
      maxDrawdown: -14.2,
      annualized: 8.3,
      period,
      note: 'Calculs pondérés par les flux, net de frais de courtage.',
    },
    byAccount: buildAccounts(now)
      .filter((account) => account.type === 'INVESTMENT' || account.type === 'CRYPTO')
      .map((account, index) => ({
        accountId: account.id,
        accountName: account.name,
        providerId: account.providerId,
        value: accountValueEur(account) ?? 0,
        performance: {
          twr: round2(9.1 - index * 0.8),
          xirr: round2(7.62 - index * 0.7),
          maxDrawdown: round2(-14.2 + index),
          annualized: round2(8.3 - index * 0.6),
          period,
          note: null,
        },
        contribution: round2((accountValueEur(account) ?? 0) * 0.09),
      })),
    allocation: {
      byClass: byClassSlices(now),
      byInstrument: topSlices(
        slicesFromValues(positions.map((position) => ({ key: position.instrumentId, label: position.symbol ?? position.name, value: position.marketValueEur }))),
        8,
      ),
      byCurrency: byCurrencySlices(now),
      byCountry: slicesFromValues([
        { key: 'fr', label: 'France', value: round2(positions.filter((p) => p.isin?.startsWith('FR')).reduce((s, p) => s + p.marketValueEur, 0) + buildProperties().reduce((s, p) => s + p.currentValue, 0)) },
        { key: 'us', label: 'États-Unis', value: round2(positions.filter((p) => p.isin?.startsWith('US')).reduce((s, p) => s + p.marketValueEur, 0) + cryptoTotalEur()) },
        { key: 'ie', label: 'Irlande', value: round2(positions.filter((p) => p.isin?.startsWith('IE')).reduce((s, p) => s + p.marketValueEur, 0)) },
        { key: 'lu', label: 'Luxembourg', value: round2(positions.filter((p) => p.isin?.startsWith('LU')).reduce((s, p) => s + p.marketValueEur, 0)) },
      ]),
    },
    risk: {
      maxDrawdown: -14.2,
      volatility: 11.4,
      cryptoShare: round2((cryptoTotalEur() / Math.max(currentNetWorthEur(now), 1)) * 100),
      realEstateShare: round2((buildProperties().reduce((sum, property) => sum + property.currentValue, 0) / Math.max(currentNetWorthEur(now), 1)) * 100),
      leverage: round2(debtsEur() / Math.max(grossAssetsEur(now), 1)),
    },
    monthly: monthKeys.map((month) => {
      const items = transactions.filter((item) => item.date.startsWith(month));
      return {
        month,
        invested: round2(items.filter((item) => item.type === 'BUY').reduce((sum, item) => sum + Math.abs(item.amountEur), 0)),
        income: round2(items.filter((item) => item.type === 'DIVIDEND' || item.type === 'INTEREST' || item.type === 'RENT').reduce((sum, item) => sum + item.amountEur, 0)),
        expenses: round2(items.filter((item) => item.type === 'FEE' || item.type === 'EXPENSE' || item.type === 'TAX').reduce((sum, item) => sum + Math.abs(item.amountEur), 0)),
        netWorth: scoped[scoped.length - 1]?.total ?? currentNetWorthEur(now),
      };
    }),
  };
}

export function connectionsResponse(): ConnectionsResponse {
  return {
    connections: CONNECTIONS,
    providers: PROVIDER_CATALOG,
    scheduler: { enabled: true, cron: '*/30 * * * *', lastRunAt: '2026-09-21T06:00:00Z', nextRunAt: '2026-09-21T06:30:00Z' },
  };
}

export function syncRuns(connectionId: string | null): SyncRunDto[] {
  const found = connectionId === null ? SYNC_RUNS : SYNC_RUNS.filter((run) => run.connectionId === connectionId);
  return [...found];
}

export function settingsDto(): SettingsDto {
  return { ...SETTINGS };
}

export function healthResponse(): HealthResponse {
  return { ...HEALTH };
}

export function importHistory(): ImportHistoryDto[] {
  return [...IMPORT_HISTORY];
}

export function marketRefresh(): typeof MARKET_REFRESH {
  return { ...MARKET_REFRESH, providers: [...MARKET_REFRESH.providers] };
}

export function analyzeImport(filename: string, content: string): ImportAnalyzeResponse {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(/[;,\t]/).map((cell) => cell.trim());
  const columns = header.length > 0 && header[0] !== '' ? header : ['date', 'type', 'description', 'montant', 'devise'];
  const rows = lines.slice(1, 41).map((line, index) => {
    const cells = line.split(/[;,\t]/).map((cell) => cell.trim());
    const amount = Number.parseFloat((cells[3] ?? '').replace(',', '.'));
    const description = cells[2] ?? line.slice(0, 60);
    return {
      line: index + 2,
      date: cells[0] ?? null,
      type: cells[1] ?? null,
      description,
      amount: Number.isFinite(amount) ? amount : null,
      currency: cells[4] ?? 'EUR',
      quantity: null,
      unitPrice: null,
      isin: null,
      status: index % 7 === 3 ? ('DUPLICATE_FINGERPRINT' as const) : ('NEW' as const),
      reason: index % 7 === 3 ? 'Transaction déjà présente (empreinte identique).' : null,
    };
  });
  const duplicates = rows.filter((row) => row.status !== 'NEW').length;
  return {
    detectedFormatId: filename.toLowerCase().includes('degiro') ? 'degiro-transactions' : 'generic-csv',
    detectedFormatLabel: filename.toLowerCase().includes('degiro') ? 'DEGIRO Transactions.csv' : 'CSV générique',
    detectionScore: 0.87,
    availableFormats: [
      { id: 'generic-csv', label: 'CSV générique', providerId: 'autres', score: 0.62 },
      { id: 'degiro-transactions', label: 'DEGIRO Transactions.csv', providerId: 'degiro', score: 0.54 },
      { id: 'ca-csv', label: 'Export CSV Crédit Agricole', providerId: 'credit-agricole', score: 0.38 },
    ],
    columns,
    suggestedMap: { date: columns[0] ?? 'date', type: columns[1] ?? 'type', description: columns[2] ?? 'description', amount: columns[3] ?? 'montant', currency: columns[4] ?? 'devise' },
    unmappedColumns: columns.slice(5),
    rows,
    summary: {
      parsed: rows.length,
      new: rows.length - duplicates,
      duplicates,
      errors: 0,
      dateRange: { from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null },
      currencies: [...new Set(rows.map((row) => row.currency ?? 'EUR'))],
      totalAmount: round2(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)),
    },
    warnings: rows.length >= 40 ? ['Aperçu limité aux 40 premières lignes.'] : [],
  };
}

export function commitImport(filename: string, content: string, dryRun: boolean): ImportCommitResponse {
  const analysis = analyzeImport(filename, content);
  const created = dryRun ? 0 : analysis.summary.new;
  return {
    importId: `imp-${320 + (dryRun ? 0 : 1)}`,
    created,
    skipped: analysis.summary.duplicates,
    errors: analysis.summary.errors,
    message: dryRun
      ? `Simulation : ${analysis.summary.new} écritures seraient créées, ${analysis.summary.duplicates} doublons ignorés.`
      : `${created} écritures importées depuis ${filename}.`,
  };
}

export function connectionById(id: string): ConnectionDto | null {
  return CONNECTIONS.find((connection) => connection.id === id) ?? null;
}
