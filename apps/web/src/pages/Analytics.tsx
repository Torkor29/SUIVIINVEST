import { useState } from 'react';
import type { AnalyticsResponse, PeriodKey } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatEur, formatMonthLabel, formatNumber, formatPercent, formatSignedEur } from '../lib/format.ts';
import { PERIOD_LABELS } from '../lib/period.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTable, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile, KeyValue } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { AllocationLegend } from '../components/ui/AllocationLegend.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { BarChart } from '../components/charts/BarChart.tsx';
import type { AnalyticsResponse as Analytics } from '@suiviinvest/api-contract';

type AccountAnalytics = Analytics['byAccount'][number];

/** Analyses : performance, flux mensuels, allocation détaillée et risque. */
export function AnalyticsPage() {
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const state = useAsync<AnalyticsResponse>((signal) => request<AnalyticsResponse>('/api/analytics', { query: { period }, signal }), [period]);

  const accountColumns: readonly Column<AccountAnalytics>[] = [
    { key: 'name', header: 'Compte', sort: (row) => row.accountName, render: (row) => row.accountName },
    { key: 'value', header: 'Valeur', align: 'right', sort: (row) => row.value, render: (row) => formatEur(row.value, 0) },
    {
      key: 'twr',
      header: 'TWR',
      align: 'right',
      sort: (row) => row.performance.twr ?? 0,
      render: (row) => formatPercent(row.performance.twr ?? 0),
    },
    {
      key: 'xirr',
      header: 'XIRR',
      align: 'right',
      sort: (row) => row.performance.xirr ?? 0,
      render: (row) => formatPercent(row.performance.xirr ?? 0),
    },
    {
      key: 'drawdown',
      header: 'Baisse max.',
      align: 'right',
      sort: (row) => row.performance.maxDrawdown ?? 0,
      render: (row) => <span className="tone-down">{formatPercent(row.performance.maxDrawdown ?? 0)}</span>,
    },
    {
      key: 'contribution',
      header: 'Contribution',
      align: 'right',
      sort: (row) => row.contribution,
      render: (row) => <span className={row.contribution < 0 ? 'tone-down' : 'tone-up'}>{formatSignedEur(row.contribution, 0)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Analyses"
        subtitle="Votre performance réelle, vos flux mensuels et votre exposition au risque."
        actions={<PeriodSelector value={period} onChange={setPeriod} compact />}
      />
      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.monthly.length === 0}
        emptyState={<EmptyState title="Pas encore d’historique" hint="Les analyses se remplissent à mesure que vos comptes se synchronisent." />}
        skeleton={
          <>
            <SkeletonTiles count={4} />
            <SkeletonChart />
            <SkeletonTable rows={4} />
          </>
        }
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Performance (TWR)" value={formatPercent(data.performance.twr ?? 0)} hint={`Période ${PERIOD_LABELS[period]}`} />
              <StatTile label="Rendement annuel (XIRR)" value={formatPercent(data.performance.xirr ?? 0)} hint="Rendement tenant compte de vos versements" />
              <StatTile label="Annualisé" value={formatPercent(data.performance.annualized ?? 0)} hint="Ramené sur 12 mois" />
              <StatTile
                label="Baisse maximale"
                value={formatPercent(data.performance.maxDrawdown ?? 0)}
                hint={data.performance.note ?? undefined}
                tone="down"
              />
            </Grid>

            <Grid className="grid-2">
              <Card title="Flux nets par mois" subtitle="Ce qui est entré moins ce qui est sorti, mois par mois.">
                <BarChart
                  items={data.monthly.map((month) => ({
                    label: month.month,
                    value: Math.round((month.income - month.expenses) * 100) / 100,
                    tone: month.income - month.expenses < 0 ? ('negative' as const) : ('positive' as const),
                  }))}
                  months
                  height={200}
                  ariaLabel="Flux nets mensuels"
                />
              </Card>
              <Card title="Investissements mensuels" subtitle="Ce que vous avez investi chaque mois.">
                <BarChart
                  items={data.monthly.map((month) => ({ label: month.month, value: month.invested, tone: 'neutral' as const }))}
                  months
                  height={200}
                  ariaLabel="Investissements mensuels"
                />
              </Card>
            </Grid>

            <Grid className="grid-2">
              <Card title="Par classe d’actif" subtitle="Immobilier compris, dettes déduites.">
                <div className="split">
                  <DonutChart slices={data.allocation.byClass} colorByLabel centerLabel="Allocation" />
                  <AllocationLegend slices={data.allocation.byClass} colorByLabel />
                </div>
              </Card>
              <Card title="Par devise et par pays" subtitle="Où votre argent est exposé.">
                <AllocationLegend slices={data.allocation.byCurrency} />
                <h3 className="sub-title">Par pays</h3>
                <AllocationLegend slices={data.allocation.byCountry} />
              </Card>
            </Grid>

            <Card title="Principales lignes" subtitle="Vos huit plus grosses positions.">
              <AllocationLegend slices={data.allocation.byInstrument} />
            </Card>

            <Grid className="grid-2">
              <Card title="Risque" subtitle="Concentration, volatilité et endettement.">
                <div className="kv-grid">
                  <KeyValue label="Baisse maximale" value={formatPercent(data.risk.maxDrawdown ?? 0)} tone="down" />
                  <KeyValue label="Volatilité annualisée" value={formatPercent(data.risk.volatility ?? 0, { sign: false })} />
                  <KeyValue label="Part crypto" value={formatPercent(data.risk.cryptoShare, { sign: false, digits: 1 })} />
                  <KeyValue label="Part immobilier" value={formatPercent(data.risk.realEstateShare, { sign: false, digits: 1 })} />
                  <KeyValue label="Levier (dette / actifs)" value={`${formatNumber(data.risk.leverage, 2)}×`} />
                </div>
              </Card>
              <Card title="Patrimoine de fin de période" subtitle="Dernière valeur connue.">
                <p className="big-number">{formatEur(data.monthly[data.monthly.length - 1]?.netWorth ?? 0, 0)}</p>
                <p className="muted small">Mois analysé : {formatMonthLabel(data.monthly[data.monthly.length - 1]?.month ?? '')}</p>
              </Card>
            </Grid>

            <Card title="Performance par compte" padded={false}>
              <DataTable rows={data.byAccount} columns={accountColumns} rowKey={(row) => row.accountId} initialSortKey="value" />
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}
