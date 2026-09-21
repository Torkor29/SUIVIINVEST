import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, toRecords, autoMap, pickAmount, pickDate, pick, findColumn } from '@suiviinvest/connectors';
import type { ImportFormat } from '@suiviinvest/connectors';
import { buildSummary, classifyFlows, twr } from '@suiviinvest/core';
import { MarketDataService, StaticPriceProvider } from '../src/services/marketdata.ts';
import { PortfolioService } from '../src/services/portfolio.ts';
import { createTestApp, createTestConnector, login, seedAccount, seedActivity, seedFx, seedInstrument, seedQuote } from './helpers.ts';

/**
 * Tests des calculs de patrimoine, d'investissement, d'immobilier et d'import.
 * Ils s'appuient sur une vraie base migrée : les calculs sont vérifiés de bout
 * en bout, depuis les lignes SQL jusqu'aux totaux exposés par l'API.
 */

test('patrimoine net : cash + titres + immobilier - dette', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());

  const cash = seedAccount(ctx.db, { name: 'Livret', type: 'CASH', providerId: 'credit_agricole', initialBalance: 1000 });
  seedActivity(ctx.db, { accountId: cash, type: 'DEPOSIT', date: '2024-01-05', amount: 5000 });
  seedActivity(ctx.db, { accountId: cash, type: 'BANK_EXPENSE', date: '2024-02-05', amount: -200 });

  const securities = seedAccount(ctx.db, { name: 'PEA', type: 'SECURITIES', providerId: 'credit_agricole' });
  const instrument = seedInstrument(ctx.db, { name: 'ETF Monde', isin: 'FR0000000001', symbol: 'CW8' });
  seedActivity(ctx.db, {
    accountId: securities,
    instrumentId: instrument,
    type: 'BUY',
    date: '2024-01-10',
    quantity: 10,
    unitPrice: 400,
    amount: -4000,
  });
  // Cours connu à la date d'aujourd'hui : l'instrument vaut 450 € par part.
  seedQuote(ctx.db, instrument, new Date().toISOString().slice(0, 10), 450);

  // Bien immobilier avec crédit.
  const propertyAccount = seedAccount(ctx.db, { name: 'Appartement', type: 'REAL_ESTATE' });
  ctx.db.run(
    `INSERT INTO properties (account_id, name, kind, purchase_price, notary_fees, agency_fees,
       initial_works, current_value, updated_at)
     VALUES (?, 'Appartement Lyon', 'APPARTEMENT', 200000, 15000, 0, 10000, 260000, ?)`,
    propertyAccount,
    new Date().toISOString(),
  );
  ctx.db.run(
    `INSERT INTO property_loans (account_id, loan_type, principal, remaining_principal, annual_rate,
       months, start_date, monthly_payment, insurance_monthly)
     VALUES (?, 'AMORTIZABLE', 160000, 128000, 3.5, 240, '2020-01-01', 0, 30)`,
    propertyAccount,
  );

  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });
  const netWorth = portfolio.netWorth('MAX');

  const byClass = Object.fromEntries(netWorth.byClass.map((slice) => [slice.key, slice.value]));
  assert.equal(byClass.CASH, 5800, '1000 + 5000 - 200');
  assert.equal(byClass.EQUITIES, 4500, '10 parts × 450 €');
  assert.equal(byClass.REAL_ESTATE, 260000);
  assert.equal(byClass.LIABILITIES, -128000, 'la dette est comptée en négatif');
  assert.equal(netWorth.total, 5800 + 4500 + 260000 - 128000);

  // La répartition par établissement est calculée en valeur convertie.
  const byProvider = Object.fromEntries(netWorth.byProvider.map((slice) => [slice.key, slice.value]));
  assert.equal(byProvider.credit_agricole, 5800 + 4500);
  assert.equal(byProvider.manual, 260000 - 128000);
  assert.deepEqual(netWorth.warnings, []);
});

test('un virement interne ne change pas le patrimoine', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const a = seedAccount(ctx.db, { name: 'Compte courant', type: 'CASH', initialBalance: 10000 });
  const b = seedAccount(ctx.db, { name: 'Livret A', type: 'CASH', initialBalance: 0 });
  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });

  const before = portfolio.netWorth('MAX').total;
  seedActivity(ctx.db, { accountId: a, type: 'TRANSFER_OUT', date: '2024-03-01', amount: -2500 });
  seedActivity(ctx.db, { accountId: b, type: 'TRANSFER_IN', date: '2024-03-01', amount: 2500 });
  const after = portfolio.netWorth('MAX').total;

  assert.equal(after, before, 'un transfert entre comptes n\'est ni un revenu ni une performance');

  const activities = ctx.db.all<Record<string, unknown>>('SELECT * FROM activities');
  const classification = classifyFlows(
    activities.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      type: String(row.type) as 'TRANSFER_IN' | 'TRANSFER_OUT',
      date: String(row.date),
      instrumentId: null,
      quantity: null,
      unitPrice: null,
      amount: Number(row.amount),
      currency: 'EUR',
      fees: 0,
      taxes: 0,
      fxRateToBase: null,
      description: null,
      provenance: {
        providerId: 'manual',
        externalAccountId: null,
        externalTransactionId: null,
        externalAssetId: null,
        rawSourceType: null,
        lastSyncedAt: '',
        dedupHash: '',
        syncRunId: null,
      },
    })),
  );
  assert.equal(classification.internal.length, 1);
  assert.equal(classification.external.length, 0);
});

test('un compte dans une devise sans taux est exclu et signalé', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const eur = seedAccount(ctx.db, { name: 'Compte EUR', type: 'CASH', initialBalance: 1000 });
  const usd = seedAccount(ctx.db, { name: 'Compte USD', type: 'CASH', currency: 'USD', initialBalance: 5000 });
  seedActivity(ctx.db, { accountId: eur, type: 'DEPOSIT', date: '2024-01-01', amount: 500 });
  seedActivity(ctx.db, { accountId: usd, type: 'DEPOSIT', date: '2024-01-01', amount: 500 });

  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });
  const withoutRate = portfolio.netWorth('MAX');
  assert.equal(withoutRate.total, 1500, 'seul le compte EUR est compté');
  assert.ok(
    withoutRate.warnings.some((warning) => warning.includes('USD')),
    'l\'exclusion doit être explicitement signalée',
  );

  // Avec le taux, le compte est intégré.
  seedFx(ctx.db, 'USD', 'EUR', '2024-01-01', 0.9);
  const withRate = new PortfolioService(ctx.db, { baseCurrency: 'EUR' }).netWorth('MAX');
  assert.equal(withRate.total, 1000 + 500 + (5000 + 500) * 0.9);
  assert.deepEqual(withRate.warnings, []);
});

test('positions : PRU, plus-value latente et poids', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const account = seedAccount(ctx.db, { name: 'Compte-titres DEGIRO', type: 'SECURITIES', providerId: 'degiro' });
  const instrument = seedInstrument(ctx.db, { name: 'TotalEnergies', isin: 'FR0000120271', symbol: 'TTE' });
  seedActivity(ctx.db, { accountId: account, instrumentId: instrument, type: 'BUY', date: '2024-01-10', quantity: 10, unitPrice: 50, amount: -505, fees: 5 });
  seedActivity(ctx.db, { accountId: account, instrumentId: instrument, type: 'BUY', date: '2024-02-10', quantity: 10, unitPrice: 60, amount: -605, fees: 5 });
  seedActivity(ctx.db, { accountId: account, instrumentId: instrument, type: 'DIVIDEND', date: '2024-03-10', amount: 30 });
  seedQuote(ctx.db, instrument, new Date().toISOString().slice(0, 10), 70);

  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });
  const investments = portfolio.investments();
  const position = investments.positions[0];
  assert.ok(position);
  assert.equal(position.quantity, 20);
  assert.equal(position.costBasis, 1110, 'frais inclus dans le prix de revient');
  assert.equal(position.averageCost, 55.5);
  assert.equal(position.marketValue, 1400);
  assert.equal(position.unrealizedPnl, 290);
  assert.equal(position.unrealizedPnlPercent, 26.13);
  assert.equal(position.dividends, 30);
  assert.equal(position.isin, 'FR0000120271');
  assert.equal(position.weightPercent, 100);
  assert.equal(investments.totals.realizedPnl, 0);
});

test('les revenus sont agrégés par type, par mois et par établissement', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const account = seedAccount(ctx.db, { name: 'PEA', type: 'SECURITIES', providerId: 'credit_agricole' });
  const cash = seedAccount(ctx.db, { name: 'Livret', type: 'CASH', providerId: 'revolut' });
  seedActivity(ctx.db, { accountId: account, type: 'DIVIDEND', date: '2024-06-15', amount: 120, providerId: 'credit_agricole' });
  seedActivity(ctx.db, { accountId: account, type: 'DIVIDEND', date: '2024-09-15', amount: 80, providerId: 'credit_agricole' });
  seedActivity(ctx.db, { accountId: cash, type: 'INTEREST', date: '2024-07-01', amount: 25, providerId: 'revolut' });
  seedActivity(ctx.db, { accountId: cash, type: 'FEE', date: '2024-07-02', amount: -10, providerId: 'revolut' });

  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });
  const income = portfolio.income('MAX');
  assert.equal(income.total, 225, 'les frais ne sont pas un revenu');
  const types = Object.fromEntries(income.byType.map((slice) => [slice.key, slice.value]));
  assert.equal(types.DIVIDEND, 200);
  assert.equal(types.INTEREST, 25);
  assert.equal(income.byMonth.length, 3);
  assert.equal(income.byProvider.length, 2);
});

test('la timeline est filtrable et paginée', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const account = seedAccount(ctx.db, { name: 'Compte', type: 'CASH' });
  for (let index = 0; index < 5; index++) {
    seedActivity(ctx.db, {
      accountId: account,
      type: 'BANK_EXPENSE',
      date: `2024-03-0${index + 1}`,
      amount: -10 - index,
      providerId: 'revolut',
    });
  }
  seedActivity(ctx.db, { accountId: account, type: 'DEPOSIT', date: '2024-04-01', amount: 1000 });

  const portfolio = new PortfolioService(ctx.db, { baseCurrency: 'EUR' });
  const firstPage = portfolio.transactions({ limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.total, 6);
  assert.ok(firstPage.nextCursor);

  const secondPage = portfolio.transactions({ limit: 2, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 2);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);

  const filtered = portfolio.transactions({ providerId: 'revolut', limit: 100 });
  assert.equal(filtered.items.length, 5);
  const deposits = portfolio.transactions({ type: 'DEPOSIT' });
  assert.equal(deposits.items.length, 1);
  assert.equal(deposits.items[0]?.amount, 1000);
});

test('market data : les cours sont récupérés puis servis depuis le cache', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const account = seedAccount(ctx.db, { name: 'Compte-titres', type: 'SECURITIES' });
  const instrument = seedInstrument(ctx.db, { name: 'Action test', isin: 'FR0000000002', symbol: 'TEST' });
  seedActivity(ctx.db, { accountId: account, instrumentId: instrument, type: 'BUY', date: '2024-01-10', quantity: 1, unitPrice: 100, amount: -100 });

  const today = new Date().toISOString().slice(0, 10);
  const service = new MarketDataService({
    db: ctx.db,
    providers: [
      new StaticPriceProvider({ quotes: { [instrument]: [{ date: today, close: 123.45 }] } }),
    ],
  });

  const first = await service.refresh();
  assert.equal(first.refreshed, 1);
  assert.equal(first.failed, 0);
  assert.equal(service.priceOf(instrument, today), 123.45);

  // Deuxième passage sans `force` : le cours du jour est déjà en cache.
  const second = await service.refresh();
  assert.equal(second.refreshed, 0, 'un prix déjà connu le même jour n\'est pas redemandé');

  const forced = await service.refresh({ force: true });
  assert.equal(forced.refreshed, 1);
});

test('un fournisseur de prix en échec n\'empêche pas les autres', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const instrument = seedInstrument(ctx.db, { name: 'Action', symbol: 'X' });
  const today = new Date().toISOString().slice(0, 10);
  const failing = {
    name: 'cassé',
    async fetchQuotes() {
      throw new Error('fournisseur indisponible');
    },
  };
  const working = new StaticPriceProvider({ quotes: { [instrument]: [{ date: today, close: 50 }] } });
  const service = new MarketDataService({ db: ctx.db, providers: [failing, working] });
  const result = await service.refresh();
  assert.equal(result.refreshed, 1);
  assert.equal(service.priceOf(instrument, today), 50);
});

test('immobilier : création via l\'API puis indicateurs de rendement', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  const created = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/real-estate',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: {
      name: 'Appartement Lyon 3e',
      kind: 'APPARTEMENT',
      purchaseDate: '2020-01-01',
      purchasePrice: 200000,
      notaryFees: 15000,
      initialWorks: 10000,
      surfaceM2: 45,
      currentValue: 260000,
      loan: {
        loanType: 'AMORTIZABLE',
        principal: 160000,
        annualRate: 3.5,
        months: 240,
        startDate: '2020-01-01',
        insuranceMonthly: 30,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  const property = created.json() as {
    accountId: string;
    metrics: { totalCost: number; equity: number; loanBalance: number; downPayment: number };
    amortization: unknown[];
  };
  assert.equal(property.metrics.totalCost, 225000);
  assert.ok(property.metrics.loanBalance > 0 && property.metrics.loanBalance < 160000);
  assert.equal(property.metrics.equity, 260000 - property.metrics.loanBalance);
  assert.equal(property.metrics.downPayment, 65000);
  assert.ok(property.amortization.length > 100);

  // Ajout d'un loyer mensuel puis vérification du cash-flow.
  const cashFlow = await ctx.app.app.inject({
    method: 'POST',
    url: `/api/real-estate/${property.accountId}/cashflows`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: {
      direction: 'INCOME',
      category: 'RENT',
      label: 'Loyer',
      amount: 900,
      currency: 'EUR',
      date: '2020-01-01',
      recurrence: 'MONTHLY',
      received: true,
    },
  });
  assert.equal(cashFlow.statusCode, 201);

  const listed = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/real-estate',
    headers: { cookie: session.cookie },
  });
  const body = listed.json() as {
    properties: { metrics: { annualIncome: number; grossYield: number; annualCashFlowAfterLoan: number } }[];
    totals: { equity: number };
  };
  const metrics = body.properties[0]?.metrics;
  assert.ok(metrics);
  assert.equal(metrics.annualIncome, 10800, '12 loyers de 900 € sur 12 mois glissants');
  assert.ok(Math.abs(metrics.grossYield - 4.1538) < 0.001);
  assert.ok(metrics.annualCashFlowAfterLoan < metrics.annualIncome);
  assert.equal(body.totals.equity, property.metrics.equity);

  // L'immobilier entre bien dans le patrimoine net (actif - dette).
  const netWorth = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/networth?period=MAX',
    headers: { cookie: session.cookie },
  });
  const netWorthBody = netWorth.json() as { byClass: { key: string; value: number }[]; total: number };
  const byClass = Object.fromEntries(netWorthBody.byClass.map((slice) => [slice.key, slice.value]));
  assert.equal(byClass.REAL_ESTATE, 260000);
  assert.ok((byClass.LIABILITIES as number) < 0);
  assert.equal(netWorthBody.total, 260000 + (byClass.LIABILITIES as number));
});

test('import : le même fichier importé deux fois ne crée aucun doublon', async (t) => {
  // Format CSV de test : deux colonnes simples, suffisant pour exercer le moteur
  // d'import (détection, aperçu, déduplication, écriture) de bout en bout.
  const genericCsv: ImportFormat = {
    id: 'test-generic-csv',
    label: 'CSV de test',
    kind: 'CSV',
    detect(content) {
      return /date/i.test(content) && /montant|amount/i.test(content) ? 0.9 : 0;
    },
    parse(content) {
      const parsed = parseCsv(content);
      const map = autoMap(parsed.header, {
        date: { candidates: ['date'] },
        amount: { candidates: ['montant', 'amount'] },
        description: { candidates: ['libelle', 'description'] },
        id: { candidates: ['reference', 'id'] },
      });
      const records = toRecords(parsed);
      const transactions = [];
      const errors = [];
      for (const record of records) {
        const date = pickDate(record, map, 'date');
        const amount = pickAmount(record, map, 'amount');
        if (!date || amount === null) {
          errors.push({ line: record.line, reason: 'date ou montant illisible' });
          continue;
        }
        transactions.push({
          externalAccountId: 'REVOLUT-TEST',
          externalTransactionId: pick(record, map, 'id'),
          externalAssetId: null,
          date,
          type: amount < 0 ? ('BANK_EXPENSE' as const) : ('DEPOSIT' as const),
          description: pick(record, map, 'description') ?? '',
          quantity: null,
          unitPrice: null,
          amount,
          currency: 'EUR',
          fees: 0,
          taxes: 0,
          rawSourceType: 'CSV',
        });
      }
      return {
        transactions,
        income: [],
        positions: [],
        detectedColumns: parsed.header,
        unmappedColumns: parsed.header.filter(
          (column) => !Object.values(map).includes(column),
        ),
        warnings: [],
        errors,
      };
    },
  };

  const connector = createTestConnector({ id: 'revolut', displayName: 'Revolut' });
  const withFormat = { ...connector, importFormats: [genericCsv] };
  // Le connecteur de test est mutable ici : réassignation explicite pour rester lisible.
  (withFormat as { importFormats: ImportFormat[] }).importFormats = [genericCsv];

  const ctx = await createTestApp({ connectors: [withFormat] });
  t.after(() => ctx.cleanup());
  const session = await login(ctx);

  const accountResponse = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { name: 'Revolut', type: 'CASH', providerId: 'revolut', currency: 'EUR' },
  });
  const accountId = (accountResponse.json() as { id: string }).id;

  const content = [
    'date;montant;libelle;reference',
    '01/03/2024;-12,50;Carte BOULANGERIE;TX-001',
    '02/03/2024;-45,00;Paiement SUPERMARCHE;TX-002',
    '05/03/2024;1500,00;Virement recu;TX-003',
    'ligne;invalide;ici;TX-004',
  ].join('\n');

  const analyze = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/imports/analyze',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { filename: 'revolut-mars.csv', content, accountId },
  });
  assert.equal(analyze.statusCode, 200);
  const analysis = analyze.json() as {
    detectedFormatId: string | null;
    summary: { new: number; duplicates: number; errors: number; currencies: string[] };
    rows: { status: string; type: string | null }[];
  };
  assert.equal(analysis.detectedFormatId, 'test-generic-csv');
  assert.equal(analysis.summary.new, 3);
  assert.equal(analysis.summary.errors, 1, 'la ligne illisible est comptée à part');
  assert.deepEqual(analysis.summary.currencies, ['EUR']);

  const commit = async (): Promise<{ created: number; skipped: number }> => {
    const response = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { filename: 'revolut-mars.csv', content, accountId, forceFormatId: 'test-generic-csv' },
    });
    assert.equal(response.statusCode, 200);
    return response.json() as { created: number; skipped: number };
  };

  const first = await commit();
  assert.equal(first.created, 3);
  const second = await commit();
  assert.equal(second.created, 0, 'le second import du même fichier ne crée rien');
  assert.equal(second.skipped, 3);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 3);

  const history = await ctx.app.app.inject({
    method: 'GET',
    url: '/api/imports',
    headers: { cookie: session.cookie },
  });
  assert.equal((history.json() as unknown[]).length, 2);
});

test('import : un format inconnu donne un message clair, sans écriture', async (t) => {
  const ctx = await createTestApp();
  t.after(() => ctx.cleanup());
  const session = await login(ctx);
  const response = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/imports/commit',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    payload: { filename: 'inconnu.xyz', content: 'ceci n\'est pas un export reconnu' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { created: number; message: string };
  assert.equal(body.created, 0);
  assert.match(body.message, /Format non reconnu/);
  assert.equal(ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 0);
});

test('les métriques de performance séparent marché et apports', () => {
  // Série : 1000 € au départ, apport de 1000 € au jour 2, marché +10 % ce jour-là.
  const points = [
    { date: '2024-01-01', total: 1000, byClass: {}, byProvider: {} },
    { date: '2024-01-02', total: 2200, byClass: {}, byProvider: {} },
  ];
  const flows = [{ date: '2024-01-02', amount: 1000 }];
  const summary = buildSummary(
    points.map((point) => ({
      date: point.date,
      total: point.total,
      byClass: {
        EQUITIES: 0,
        CRYPTO: 0,
        REAL_ESTATE: 0,
        CASH: point.total,
        OTHER_ASSETS: 0,
        LIABILITIES: 0,
      },
      byProvider: {},
    })),
  );
  assert.equal(summary.total, 2200);
  assert.equal(summary.variationAll.absolute, 1200, 'la variation brute inclut l\'apport');
  assert.equal(twr(points.map((point) => ({ date: point.date, value: point.total })), flows), 10);
});

test('détection de colonnes et lecture CSV', () => {
  const parsed = parseCsv('Date;Montant;Libellé\n01/03/2024;"-1 234,56";Café');
  assert.equal(parsed.delimiter, ';');
  assert.deepEqual(parsed.header, ['Date', 'Montant', 'Libellé']);
  const records = toRecords(parsed);
  const map = autoMap(parsed.header, { amount: { candidates: ['montant'] } });
  assert.equal(findColumn(parsed.header, ['montant']), 1);
  assert.equal(pickAmount(records[0] as never, map, 'amount'), -1234.56, 'le format français est compris');
});