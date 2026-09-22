import { useState } from 'react';
import type { NetWorthResponse, PeriodKey } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur } from '../lib/format.ts';
import { PERIOD_LABELS } from '../lib/period.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { Badge } from '../components/ui/Stat.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { AllocationLegend, ReadOnlyNote, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { LineAreaChart } from '../components/charts/LineAreaChart.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { SummaryStrip } from '../components/dashboard/SummaryStrip.tsx';
import { describeHistorySource } from '../lib/history.ts';

/** Tableau de bord : patrimoine net, variations, historique et répartitions. */
export function DashboardPage() {
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const state = useAsync<NetWorthResponse>(
    (signal) => request<NetWorthResponse>('/api/networth', { query: { period }, signal }),
    [period],
  );
  const provenance = describeHistorySource(state.data?.historySource, state.data?.recordedSince);

  return (
    <>
      <PageHeader
        title="Tableau de bord"
        subtitle="Patrimoine net consolidé, toutes classes d’actifs, en euros."
        actions={state.data === null ? undefined : <Badge tone="neutral">Au {formatDate(state.data.asOf)}</Badge>}
      />

      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        skeleton={
          <>
            <SkeletonTiles count={5} />
            <SkeletonChart />
          </>
        }
      >
        {(data) => (
          <>
            <SummaryStrip data={data} />

            <Card
              title="Évolution du patrimoine"
              subtitle={`Période affichée : ${PERIOD_LABELS[period]}`}
              actions={<PeriodSelector value={period} onChange={setPeriod} />}
            >
              <p className="muted small" data-testid="history-provenance">
                <Badge tone={provenance.tone}>{provenance.label}</Badge> {provenance.detail}
              </p>
              <LineAreaChart points={data.series} />
              <WarningsList warnings={data.warnings} />
            </Card>

            <Grid className="grid-2">
              <Card title="Par classe d’actif" subtitle="Immobilier à valeur d’estimation, dettes déduites.">
                <div className="split">
                  <DonutChart slices={data.byClass} colorByLabel centerLabel="Actif net" centerValue={formatEur(data.total, 0)} />
                  <AllocationLegend slices={data.byClass} colorByLabel />
                </div>
              </Card>
              <Card title="Par établissement" subtitle="Crédit Agricole, DEGIRO, Trade Republic, Revolut, MetaMask.">
                <div className="split">
                  <DonutChart slices={data.byProvider} centerLabel="Total" centerValue={formatEur(data.total, 0)} />
                  <AllocationLegend slices={data.byProvider} />
                </div>
              </Card>
            </Grid>

            <Card title="Devises d’exposition" subtitle="Contre-valeur en euros au taux retenu par le backend.">
              <AllocationLegend slices={data.byCurrency} />
            </Card>

            <ReadOnlyNote />
          </>
        )}
      </AsyncView>
    </>
  );
}
