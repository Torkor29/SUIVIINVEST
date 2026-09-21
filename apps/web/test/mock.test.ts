/** Tests de la maquette : routeur simulé et sélecteurs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AccountsResponse,
  AnalyticsResponse,
  ConnectionDto,
  CryptoResponse,
  ImportAnalyzeResponse,
  IncomeResponse,
  InvestmentsResponse,
  NetWorthResponse,
  PropertyDto,
  RealEstateResponse,
  SessionResponse,
  SettingsDto,
  SyncRunDto,
  TransactionsResponse,
} from '@suiviinvest/api-contract';
import { mockRequest } from '../src/mock/index.ts';
import { incomeResponse } from '../src/mock/reporting.ts';
import { filterTransactions, transactionsResponse } from '../src/mock/selectors.ts';
import { buildTransactions } from '../src/mock/transactions.ts';
import { buildAmortization } from '../src/lib/property.ts';
import { ACCOUNT_META } from '../src/mock/accountsMeta.ts';

test('la session simulée fournit un jeton CSRF', () => {
  const session = mockRequest('/api/auth/session', 'GET', null) as SessionResponse;
  assert.equal(session.authenticated, true);
  assert.equal(session.needsSetup, false);
  assert.ok(typeof session.csrfToken === 'string' && session.csrfToken.length > 0);
});

test('/api/networth renvoie un total, une série et les répartitions attendues', () => {
  const networth = mockRequest('/api/networth?period=1M', 'GET', null) as NetWorthResponse;
  assert.ok(networth.total > 100_000, `patrimoine inattendu ${networth.total}`);
  assert.ok(networth.series.length > 0);
  assert.equal(networth.currency, 'EUR');
  const classes = networth.byClass.map((slice) => slice.label);
  for (const label of ['Actions-ETF', 'Crypto', 'Immobilier', 'Cash', 'Dettes']) {
    assert.ok(classes.includes(label), `classe manquante : ${label}`);
  }
  assert.ok(networth.byProvider.length >= 5);
  assert.ok(networth.warnings.length > 0);
  assert.ok(Number.isFinite(networth.variation1Y.percent));
});

test('/api/accounts expose tous les comptes de la maquette', () => {
  const response = mockRequest('/api/accounts', 'GET', null) as AccountsResponse;
  assert.equal(response.accounts.length, ACCOUNT_META.length);
  assert.ok(response.totals.total > 0);
  assert.ok(response.accounts.some((account) => account.valueCurrency === 'USD'));
});

test('/api/investments filtre par compte et calcule les totaux', () => {
  const all = mockRequest('/api/investments', 'GET', null) as InvestmentsResponse;
  assert.ok(all.positions.length >= 8);
  const pea = mockRequest('/api/investments?accountId=acc-tr-pea', 'GET', null) as InvestmentsResponse;
  assert.ok(pea.positions.length > 0);
  assert.ok(pea.positions.every((position) => position.accountId === 'acc-tr-pea'));
  assert.ok(pea.totals.marketValue < all.totals.marketValue);
  assert.ok(pea.allocation.length > 0);
});

test('/api/crypto et /api/real-estate décrivent les portefeuilles et les biens', () => {
  const crypto = mockRequest('/api/crypto', 'GET', null) as CryptoResponse;
  assert.ok(crypto.totalEur > 0);
  assert.ok(crypto.wallets.length >= 2);
  assert.ok(crypto.byChain.length >= 3);

  const realEstate = mockRequest('/api/real-estate', 'GET', null) as RealEstateResponse;
  assert.equal(realEstate.properties.length, 2);
  assert.ok(realEstate.totals.equity > 0);
  assert.ok(realEstate.portfolio.grossYield > 0);

  const property = mockRequest('/api/real-estate/acc-re-lyon', 'GET', null) as PropertyDto;
  assert.equal(property.accountId, 'acc-re-lyon');
  assert.ok(property.amortization.length > 0);
  assert.ok(Math.abs(property.amortization[property.amortization.length - 1]?.remaining ?? 1) < 1);
});

test('/api/transactions pagine par curseur et filtre par type', () => {
  const page = mockRequest('/api/transactions?limit=5', 'GET', null) as TransactionsResponse;
  assert.equal(page.items.length, 5);
  assert.ok(page.total > 100);
  assert.ok(page.nextCursor !== null);
  assert.ok(page.totalsByType.length > 0);

  const buys = mockRequest('/api/transactions?type=BUY&limit=10', 'GET', null) as TransactionsResponse;
  assert.ok(buys.items.every((item) => item.type === 'BUY'));
});

test('filterTransactions combine compte, recherche et montants', () => {
  const items = buildTransactions(new Date('2026-09-21T00:00:00Z'));
  const filtered = filterTransactions(items, { providerId: 'degiro', minAmount: 0, search: 'world' });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((item) => item.providerId === 'degiro'));
  assert.equal(filterTransactions(items, { type: 'INEXISTANT' }).length, 0);
});

test('/api/income agrège dividendes, intérêts et loyers', () => {
  const income = mockRequest('/api/income?period=1Y', 'GET', null) as IncomeResponse;
  assert.ok(income.total > 0);
  assert.ok(income.byMonth.length > 0);
  assert.ok(income.byType.some((slice) => slice.label === 'Loyers'));
  assert.ok(income.forwardAnnualized > 0);
  const short = incomeResponse('1M');
  assert.ok(short.total <= income.total);
});

test('/api/analytics expose performance, allocation et risque', () => {
  const analytics = mockRequest('/api/analytics?period=1Y', 'GET', null) as AnalyticsResponse;
  assert.ok(analytics.performance.twr !== null);
  assert.ok(analytics.byAccount.length >= 4);
  assert.ok(analytics.monthly.length > 0);
  assert.ok(analytics.allocation.byCountry.length >= 3);
  assert.ok(analytics.risk.cryptoShare > 0);
});

test('connexions, synchronisations et paramètres répondent en mode maquette', () => {
  const connections = mockRequest('/api/connections', 'GET', null) as {
    readonly connections: readonly ConnectionDto[];
    readonly scheduler: { readonly enabled: boolean };
  };
  assert.equal(connections.connections.length, 5);
  assert.equal(connections.scheduler.enabled, true);

  const runs = mockRequest('/api/connections/conn-degiro/runs', 'GET', null) as readonly SyncRunDto[];
  assert.ok(runs.every((run) => run.connectionId === 'conn-degiro'));

  const settings = mockRequest('/api/settings', 'GET', null) as SettingsDto;
  assert.equal(settings.baseCurrency, 'EUR');
  const patched = mockRequest('/api/settings', 'PATCH', { theme: 'dark' }) as SettingsDto;
  assert.equal(patched.theme, 'dark');
});

test('/api/imports/analyze détecte les colonnes et les doublons', () => {
  const csv = 'date;type;description;montant;devise\n2026-01-04;BUY;ETF World;250;EUR\n2026-01-05;DIVIDEND;TotalEnergies;100,7;EUR\n';
  const analysis = mockRequest('/api/imports/analyze', 'POST', { filename: 'releve.csv', content: csv }) as ImportAnalyzeResponse;
  assert.equal(analysis.summary.parsed, 2);
  assert.deepEqual(analysis.columns.slice(0, 3), ['date', 'type', 'description']);
  assert.equal(analysis.detectedFormatId, 'generic-csv');
});

test('une route inconnue ne renvoie rien (404 côté client)', () => {
  assert.equal(mockRequest('/api/inconnu', 'GET', null), null);
});

test('transactionsResponse respecte la limite demandée', () => {
  const response = transactionsResponse({ limit: 7 });
  assert.equal(response.items.length, 7);
});

test('le tableau d’amortissement de la maquette s’éteint à zéro', () => {
  const rows = buildAmortization({ principal: 100_000, annualRate: 0.02, months: 120, startDate: '2024-01-01', insuranceMonthly: 20 });
  assert.equal(rows.length, 120);
  assert.ok(Math.abs(rows[rows.length - 1]?.remaining ?? 1) < 1);
  const repaid = rows.reduce((sum, row) => sum + row.principal, 0);
  assert.ok(Math.abs(repaid - 100_000) < 5, `capital remboursé ${repaid}`);
});
