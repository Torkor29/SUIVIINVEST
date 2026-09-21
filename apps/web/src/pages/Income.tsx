import { useState } from 'react';
import type { IncomeResponse, PeriodKey, TransactionDto } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur } from '../lib/format.ts';
import { PERIOD_LABELS } from '../lib/period.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { AllocationLegend, ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { BarChart } from '../components/charts/BarChart.tsx';

/** Revenus : dividendes, intérêts et loyers, avec projection annuelle. */
export function IncomePage() {
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const state = useAsync<IncomeResponse>((signal) => request<IncomeResponse>('/api/income', { query: { period }, signal }), [period]);

  const columns: readonly Column<TransactionDto>[] = [
    { key: 'date', header: 'Date', sort: (row) => row.date, render: (row) => formatDate(row.date) },
    {
      key: 'source',
      header: 'Source',
      sort: (row) => row.instrumentName ?? row.description ?? '',
      render: (row) => (
        <span className="cell-main">
          <strong>{row.instrumentName ?? row.description ?? row.type}</strong>
          <small className="cell-sub">{row.accountName}</small>
        </span>
      ),
    },
    { key: 'type', header: 'Nature', sort: (row) => row.type, render: (row) => <span className="pill">{row.type}</span> },
    {
      key: 'amount',
      header: 'Montant net',
      align: 'right',
      sort: (row) => row.amountEur,
      render: (row) => (
        <span className="cell-main">
          <strong className="tone-up">{formatEur(row.amountEur)}</strong>
          {row.taxes > 0 && <small className="cell-sub">prélèvements {formatEur(row.taxes)}</small>}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Revenus"
        subtitle="Dividendes, coupons, intérêts d’épargne et loyers encaissés."
        actions={<PeriodSelector value={period} onChange={setPeriod} compact />}
      />
      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.items.length === 0}
        emptyState={<EmptyState title="Aucun revenu sur la période" hint={`Rien n’a été encaissé sur « ${PERIOD_LABELS[period]} ».`} />}
        skeleton={
          <>
            <SkeletonTiles count={4} />
            <SkeletonChart />
          </>
        }
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label={`Revenus — ${PERIOD_LABELS[period]}`} value={formatEur(data.total, 0)} hint={`${data.items.length} encaissements`} />
              <StatTile label="Projection annuelle" value={formatEur(data.forwardAnnualized, 0)} hint="Sur la base du rythme observé" />
              <StatTile
                label="Moyenne mensuelle"
                value={formatEur(data.byMonth.length === 0 ? 0 : data.total / data.byMonth.length, 0)}
                hint={`${data.byMonth.length} mois couverts`}
              />
              <StatTile label="Sources distinctes" value={`${data.byAccount.length}`} hint={`${data.byProvider.length} établissement(s)`} />
            </Grid>

            <Card title="Revenus mensuels" subtitle={`Détail mois par mois (${PERIOD_LABELS[period]}).`}>
              <BarChart
                items={data.byMonth.map((month) => ({ label: month.month, value: month.value, tone: 'positive' as const }))}
                months
                height={220}
                ariaLabel="Revenus par mois"
              />
            </Card>

            <Grid className="grid-2">
              <Card title="Par nature" subtitle="Dividendes, intérêts et loyers.">
                <div className="split">
                  <DonutChart slices={data.byType} centerLabel="Revenus" centerValue={formatEur(data.total, 0)} />
                  <AllocationLegend slices={data.byType} />
                </div>
              </Card>
              <Card title="Par établissement" subtitle="Répartition des encaissements.">
                <AllocationLegend slices={data.byProvider} />
                <h3 className="sub-title">Par compte</h3>
                <AllocationLegend slices={data.byAccount} />
              </Card>
            </Grid>

            <Card title="Détail des encaissements" padded={false}>
              <DataTable rows={data.items} columns={columns} rowKey={(row) => row.id} initialSortKey="date" maxRows={120} />
            </Card>

            <ReadOnlyNote text="Les revenus sont constatés depuis les transactions importées : aucune saisie d’ordre n’est nécessaire." />
          </>
        )}
      </AsyncView>
    </>
  );
}
