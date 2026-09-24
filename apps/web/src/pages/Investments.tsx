import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HoldingPositionDto, HoldingsHistoryResponse, HoldingsResponse, PeriodKey } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { formatEur, formatPercent, formatRelative, formatSignedEur, toneOf } from '../lib/format.ts';
import { assetBadge, formatPrice, formatShares, HOLDING_PERIODS } from '../lib/holdings.ts';
import { PERIOD_LABELS } from '../lib/period.ts';
import { Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile } from '../components/ui/Stat.tsx';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { AllocationLegend, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { LineAreaChart } from '../components/charts/LineAreaChart.tsx';
import { Sparkline } from '../components/charts/Sparkline.tsx';
import { AddInvestmentSheet } from '../components/holdings/AddInvestmentSheet.tsx';
import { PlansList } from '../components/holdings/PlansList.tsx';

/**
 * Investissements : tout ce que vous détenez (saisi ici ou synchronisé), suivi
 * au cours du marché. Valeur, montant investi, plus-value, courbes et achats
 * programmés.
 */
export function InvestmentsPage() {
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const [adding, setAdding] = useState(false);
  const state = useAsync<HoldingsResponse>((signal) => request<HoldingsResponse>('/api/holdings', { signal }), []);
  const history = useAsync<HoldingsHistoryResponse>(
    (signal) => request<HoldingsHistoryResponse>('/api/holdings/history', { query: { period }, signal }),
    [period],
  );
  const refresh = useAction();

  const reloadAll = (): void => {
    state.reload();
    history.reload();
  };

  const runRefresh = (): void => {
    void refresh.run(async () => {
      const result = await request<{ instruments: number; quotes: number; errors: string[]; executions: number }>(
        '/api/holdings/refresh',
        { method: 'POST' },
      );
      reloadAll();
      const executions = result.executions > 0 ? `, ${result.executions} achat(s) programmé(s) ajouté(s)` : '';
      return result.errors.length > 0
        ? `Cours mis à jour en partie : ${result.errors[0] ?? ''}`
        : `Cours à jour (${result.instruments} actif(s))${executions}.`;
    });
  };

  return (
    <>
      <h1 className="page-title sr-only">Investissements</h1>
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
            <section className="hero hero-with-actions">
              <div className="hero-main">
                <span className="hero-label">Mes investissements</span>
                <span className="hero-scope">Actions, ETF, fonds et cryptos, au cours du marché : plus-values et achats programmés.</span>
                <strong className="hero-value" data-testid="holdings-total">
                  {formatEur(data.totals.value)}
                </strong>
                <span className={`hero-sub tone-${toneOf(data.totals.pnl)}`}>
                  {formatSignedEur(data.totals.pnl)} ({formatPercent(data.totals.pnlPercent)})
                  <span className="hero-sub-period">plus-value latente</span>
                </span>
              </div>
              <div className="hero-actions">
                <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-investment-open">
                  Ajouter
                </button>
                <button type="button" className="btn" disabled={refresh.pending} onClick={runRefresh} data-testid="holdings-refresh">
                  {refresh.pending ? 'Actualisation…' : 'Actualiser les cours'}
                </button>
              </div>
            </section>
            <ActionFeedback state={refresh} />

            {data.positions.length === 0 ? (
              <EmptyState
                title="Ajoutez votre premier investissement"
                hint="Action, ETF, crypto, obligation : indiquez ce que vous détenez ou programmez un achat récurrent (ex. 200 $ de Nvidia le 10 de chaque mois). Les cours se mettent à jour tout seuls."
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                    Ajouter un investissement
                  </button>
                }
              />
            ) : (
              <>
                <section className="chart-panel" aria-label="Évolution du portefeuille">
                  {history.data !== null && (
                    <>
                      <div className="chart-panel-head">
                        <span className={`tone-${toneOf(history.data.change)}`}>
                          {formatSignedEur(history.data.change)} ({formatPercent(history.data.changePercent)})
                          <span className="muted"> · {PERIOD_LABELS[period].toLowerCase()}, hors versements</span>
                        </span>
                        <span className="chart-legend">
                          <span className="chart-legend-item">Valeur</span>
                          <span className="chart-legend-item is-secondary">Investi</span>
                        </span>
                      </div>
                      <LineAreaChart
                        points={history.data.points.map((point) => ({ date: point.date, total: point.value }))}
                        secondary={history.data.points.map((point) => ({ date: point.date, total: point.invested }))}
                        primaryLabel="Valeur"
                        secondaryLabel="Investi"
                        height={240}
                        tone={toneOf(history.data.change)}
                        ariaLabel="Valeur du portefeuille et montant investi"
                      />
                    </>
                  )}
                  <div className="chart-panel-foot">
                    <PeriodSelector value={period} onChange={setPeriod} keys={HOLDING_PERIODS} compact />
                    <span className="muted small">
                      {data.lastPriceUpdate ? `Cours mis à jour ${formatRelative(data.lastPriceUpdate)}` : 'Cours pas encore chargés'}
                    </span>
                  </div>
                </section>

                <Grid>
                  <StatTile label="Montant investi" value={formatEur(data.totals.invested)} hint="Prix de revient des titres détenus" />
                  <StatTile
                    label="Aujourd’hui"
                    value={formatSignedEur(data.totals.dayChange)}
                    delta={{ absolute: data.totals.dayChange, percent: data.totals.dayChangePercent }}
                  />
                  <StatTile label="Plus-values réalisées" value={formatSignedEur(data.totals.realizedPnl)} hint="Ventes passées" />
                </Grid>

                <Grid className="grid-2">
                  <Card title="Mes lignes" subtitle="Touchez une ligne pour voir son cours et son historique." padded>
                    <ul className="list" data-testid="holdings-list">
                      {data.positions.map((position) => (
                        <PositionRow key={position.instrumentId} position={position} />
                      ))}
                    </ul>
                  </Card>
                  <Card title="Répartition" subtitle="Par type d’actif.">
                    <div className="split">
                      <DonutChart slices={data.allocation} centerLabel="Portefeuille" centerValue={formatEur(data.totals.value, 0)} />
                      <AllocationLegend slices={data.allocation} showBars={false} />
                    </div>
                  </Card>
                </Grid>
              </>
            )}

            <Card
              title="Investissements programmés"
              subtitle="Achats automatiques à date fixe (DCA), calculés au cours du jour."
              actions={
                <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
                  Programmer
                </button>
              }
            >
              {data.plans.length === 0 ? (
                <p className="muted small">
                  Aucun pour l’instant. Exemple : « 200 $ de Nvidia le 10 de chaque mois depuis janvier » — les achats passés sont
                  rattrapés, les suivants s’ajoutent tout seuls.
                </p>
              ) : (
                <PlansList plans={data.plans} onChanged={reloadAll} />
              )}
            </Card>

            <WarningsList warnings={data.warnings} />
          </>
        )}
      </AsyncView>
      {adding && <AddInvestmentSheet onClose={() => setAdding(false)} onAdded={reloadAll} />}
    </>
  );
}

function PositionRow({ position }: { readonly position: HoldingPositionDto }) {
  const tone = toneOf(position.pnl);
  const sparkTone = position.sparkline.length > 1 ? toneOf((position.sparkline.at(-1) ?? 0) - (position.sparkline[0] ?? 0)) : 'flat';
  return (
    <li>
      <Link className="list-row holding-row" to={`/investissements/${position.instrumentId}`} data-testid="holding-row">
        <span className="logo" aria-hidden="true">
          {assetBadge(position.symbol, position.name)}
        </span>
        <span className="list-row-main">
          <strong>{position.name}</strong>
          <span>
            {formatShares(position.quantity)} {position.symbol ?? ''} · {formatPrice(position.lastPrice)}
          </span>
        </span>
        <span className="holding-spark">
          <Sparkline values={position.sparkline} tone={sparkTone} width={72} height={26} />
        </span>
        <span className="list-row-end">
          <strong>{formatEur(position.value)}</strong>
          <span className={`small tone-${tone}`}>
            {formatSignedEur(position.pnl, 0)} ({formatPercent(position.pnlPercent, { digits: 1 })})
          </span>
        </span>
      </Link>
    </li>
  );
}
