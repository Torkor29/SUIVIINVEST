import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AllocationSlice, NetWorthResponse, PeriodKey } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useLivePrices } from '../lib/useLivePrices.ts';
import { formatDate, formatEur, formatPercent, toneOf } from '../lib/format.ts';
import { seriesVariation } from '../lib/period.ts';
import { Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { Badge } from '../components/ui/Stat.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { AllocationLegend, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { LineAreaChart } from '../components/charts/LineAreaChart.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { classColor } from '../components/charts/palette.ts';
import { SummaryStrip, VariationChips } from '../components/dashboard/SummaryStrip.tsx';
import { describeHistorySource } from '../lib/history.ts';

/** Section de l'application correspondant à chaque classe d'actif. */
const CLASS_LINKS: Readonly<Record<string, string>> = {
  EQUITIES: '/investissements',
  CRYPTO: '/crypto',
  REAL_ESTATE: '/immobilier',
  CASH: '/tresorerie',
  LIABILITIES: '/immobilier',
};

/** Accueil : patrimoine net, courbe, variations et répartition. */
export function DashboardPage() {
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const state = useAsync<NetWorthResponse>(
    (signal) => request<NetWorthResponse>('/api/networth', { query: { period }, signal }),
    [period],
  );
  useLivePrices(state.reload);
  const provenance = describeHistorySource(state.data?.historySource, state.data?.recordedSince);

  return (
    <>
      <h1 className="page-title sr-only">Accueil</h1>
      <AsyncView
        loading={state.loading && state.data === null}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        skeleton={
          <>
            <SkeletonTiles count={3} />
            <SkeletonChart />
          </>
        }
      >
        {(data) => (
          <>
            <SummaryStrip data={data} period={period} />

            <section className="chart-panel" aria-label="Évolution du patrimoine">
              <LineAreaChart
                points={data.series}
                height={240}
                minimal
                tone={toneOf(seriesVariation(data.series).absolute)}
              />
              <div className="chart-panel-foot">
                <PeriodSelector value={period} onChange={setPeriod} compact />
                <span className="muted small" data-testid="history-provenance" title={provenance.detail}>
                  <Badge tone={provenance.tone}>{provenance.label}</Badge> au {formatDate(data.asOf)}
                </span>
              </div>
              <WarningsList warnings={data.warnings} />
            </section>

            <VariationChips data={data} />

            {data.total === 0 && data.byClass.length === 0 ? (
              <EmptyState
                title="Votre patrimoine s’affichera ici"
                hint="Déclarez vos investissements (actions, ETF, cryptos, obligations) : les cours se mettent à jour tout seuls. Vous pouvez aussi relier une banque ou un wallet."
                action={
                  <span className="card-actions-row">
                    <Link className="btn btn-primary" to="/investissements">
                      Ajouter un investissement
                    </Link>
                    <Link className="btn" to="/connexions">
                      Relier une source
                    </Link>
                  </span>
                }
              />
            ) : (
              <>
                <Card title="Mes actifs">
                  <AssetClassList slices={data.byClass} />
                </Card>

                <Grid className="grid-2">
                  <Card title="Répartition" subtitle="Par classe d’actif, dettes déduites.">
                    <div className="split">
                      <DonutChart slices={data.byClass} colorByLabel centerLabel="Net" centerValue={formatEur(data.total, 0)} />
                      <AllocationLegend slices={data.byClass} colorByLabel showBars={false} />
                    </div>
                  </Card>
                  <Card title="Par établissement" subtitle="Où se trouve votre argent.">
                    <div className="split">
                      <DonutChart slices={data.byProvider} centerLabel="Total" centerValue={formatEur(data.total, 0)} />
                      <AllocationLegend slices={data.byProvider} showBars={false} />
                    </div>
                  </Card>
                </Grid>

                {data.byCurrency.length > 1 && (
                  <Card title="Devises" subtitle="Contre-valeur en euros au dernier taux connu.">
                    <AllocationLegend slices={data.byCurrency} />
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </AsyncView>
    </>
  );
}

/** Liste des classes d'actifs, chacune menant à sa section. */
function AssetClassList({ slices }: { readonly slices: readonly AllocationSlice[] }) {
  if (slices.length === 0) return <p className="muted">Aucun actif pour l’instant.</p>;
  return (
    <ul className="list">
      {slices.map((slice) => {
        const to = CLASS_LINKS[slice.key];
        const content = (
          <>
            <span className="logo" style={{ background: classColor(slice.label), color: '#fff' }} aria-hidden="true">
              {slice.label.slice(0, 2).toUpperCase()}
            </span>
            <span className="list-row-main">
              <strong>{slice.label}</strong>
              <span>{formatPercent(slice.percent, { sign: false, digits: 1 })} du total</span>
            </span>
            <span className="list-row-end">
              <strong className={`num ${slice.value < 0 ? 'tone-down' : ''}`}>{formatEur(slice.value)}</strong>
            </span>
          </>
        );
        return (
          <li key={slice.key}>
            {to === undefined ? (
              <div className="list-row">{content}</div>
            ) : (
              <Link className="list-row" to={to}>
                {content}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
