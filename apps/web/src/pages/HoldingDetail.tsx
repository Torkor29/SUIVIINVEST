import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DcaPlanDto, HoldingDetailResponse, HoldingOperationDto, PeriodKey } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { formatDate, formatEur, formatPercent, formatSignedEur, toneOf } from '../lib/format.ts';
import { formatPrice, formatShares, HOLDING_PERIODS } from '../lib/holdings.ts';
import { PERIOD_LABELS } from '../lib/period.ts';
import { Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { SkeletonChart, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { Badge, KeyValue } from '../components/ui/Stat.tsx';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { PeriodSelector } from '../components/ui/PeriodSelector.tsx';
import { Sheet } from '../components/ui/Sheet.tsx';
import { IconArrowLeft } from '../components/ui/Icons.tsx';
import { LineAreaChart } from '../components/charts/LineAreaChart.tsx';
import { ManualPriceForm, OperationForm, PlanForm } from '../components/holdings/HoldingForms.tsx';
import { PlansList } from '../components/holdings/PlansList.tsx';

type Panel = { readonly kind: 'BUY' | 'SELL' } | { readonly kind: 'PLAN'; readonly plan?: DcaPlanDto } | null;

/** Un actif : son cours, ma ligne (valeur vs investi), mes achats et ventes, mes achats programmés. */
export function HoldingDetailPage() {
  const { id = '' } = useParams();
  const [period, setPeriod] = useState<PeriodKey>('1Y');
  const [panel, setPanel] = useState<Panel>(null);
  const [showAll, setShowAll] = useState(false);
  const state = useAsync<HoldingDetailResponse>(
    (signal) => request<HoldingDetailResponse>(`/api/holdings/assets/${id}`, { query: { period }, signal }),
    [id, period],
  );
  const refresh = useAction();

  return (
    <>
      <Link to="/investissements" className="back-link" aria-label="Retour aux investissements">
        <IconArrowLeft size={16} /> Investissements
      </Link>
      <AsyncView
        loading={state.loading && state.data === null}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        skeleton={
          <>
            <SkeletonTiles count={2} />
            <SkeletonChart />
          </>
        }
      >
        {(data) => {
          const { asset, position } = data;
          const last = data.prices.at(-1)?.total ?? position?.lastPrice ?? null;
          const priceTone = toneOf(data.priceChangePercent ?? 0);
          const manual = asset.priceSource === 'manual' || asset.priceSource === null;
          return (
            <>
              <section className="hero hero-with-actions">
                <div className="hero-main">
                  <span className="hero-label">
                    {[asset.symbol, asset.kindLabel, asset.exchange].filter(Boolean).join(' · ')}
                  </span>
                  <h1 className="asset-title" data-testid="asset-name">
                    {asset.name}
                  </h1>
                  <strong className="hero-value" data-testid="asset-price">
                    {formatPrice(last)}
                  </strong>
                  {data.priceChangePercent !== null && (
                    <span className={`hero-sub tone-${priceTone}`}>
                      {formatPercent(data.priceChangePercent)}
                      <span className="hero-sub-period">{PERIOD_LABELS[period].toLowerCase()}</span>
                    </span>
                  )}
                </div>
                <div className="hero-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setPanel({ kind: 'BUY' })} data-testid="asset-buy">
                    Acheter
                  </button>
                  {position !== null && (
                    <button type="button" className="btn" onClick={() => setPanel({ kind: 'SELL' })} data-testid="asset-sell">
                      Vendre
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => setPanel({ kind: 'PLAN' })} data-testid="asset-plan">
                    Programmer
                  </button>
                </div>
              </section>

              <section className="chart-panel" aria-label="Cours">
                {data.prices.length > 1 ? (
                  <LineAreaChart
                    points={data.prices}
                    height={240}
                    tone={priceTone}
                    format={(value) => formatPrice(value)}
                    axisFormat={(value) => formatPrice(value)}
                    ariaLabel={`Cours de ${asset.name}`}
                  />
                ) : (
                  <div className="chart-empty">
                    {manual ? 'Cours saisi à la main : ajoutez des cours pour tracer la courbe.' : 'Historique des cours pas encore disponible.'}
                  </div>
                )}
                <div className="chart-panel-foot">
                  <PeriodSelector value={period} onChange={setPeriod} keys={HOLDING_PERIODS} compact />
                  {!manual && (
                    <button
                      type="button"
                      className="btn btn-link small"
                      disabled={refresh.pending}
                      onClick={() =>
                        void refresh.run(async () => {
                          await request('/api/holdings/refresh', { method: 'POST' });
                          state.reload();
                          return 'Cours actualisé.';
                        })
                      }
                    >
                      {refresh.pending ? 'Actualisation…' : 'Actualiser le cours'}
                    </button>
                  )}
                </div>
                <ActionFeedback state={refresh} />
              </section>

              {manual && (
                <Card title="Cours" subtitle="Aucune cotation publique : indiquez le cours quand il change.">
                  <ManualPriceForm asset={asset} onDone={state.reload} />
                </Card>
              )}

              {position !== null ? (
                <>
                  <Grid className="grid-2">
                    <Card title="Ma ligne">
                      <div className="kv-grid">
                        <KeyValue label="Valeur" value={<strong data-testid="position-value">{formatEur(position.value)}</strong>} />
                        <KeyValue label="Quantité" value={formatShares(position.quantity)} />
                        <KeyValue label="Investi" value={formatEur(position.invested)} />
                        <KeyValue label="Prix de revient" value={formatPrice(position.quantity > 0 ? position.invested / position.quantity : null)} />
                        <KeyValue
                          label="Plus-value latente"
                          value={`${formatSignedEur(position.pnl)} (${formatPercent(position.pnlPercent)})`}
                          tone={toneOf(position.pnl)}
                        />
                        <KeyValue label="Plus-values réalisées" value={formatSignedEur(position.realizedPnl)} tone={toneOf(position.realizedPnl)} />
                      </div>
                      {position.accounts.length > 0 && <p className="muted small">Détenu dans : {position.accounts.join(', ')}</p>}
                    </Card>
                    <Card title="Valeur de ma ligne" subtitle="Comparée au montant investi.">
                      <LineAreaChart
                        points={data.history.map((point) => ({ date: point.date, total: point.value }))}
                        secondary={data.history.map((point) => ({ date: point.date, total: point.invested }))}
                        primaryLabel="Valeur"
                        secondaryLabel="Investi"
                        height={180}
                        tone={toneOf(position.pnl)}
                        ariaLabel="Valeur de la ligne et montant investi"
                      />
                    </Card>
                  </Grid>
                </>
              ) : (
                <Card title="Ma ligne">
                  <p className="muted">Vous ne détenez pas cet actif pour l’instant. Ajoutez un achat ou programmez-en.</p>
                </Card>
              )}

              <Card
                title="Investissements programmés"
                actions={
                  <button type="button" className="btn btn-ghost" onClick={() => setPanel({ kind: 'PLAN' })}>
                    Programmer
                  </button>
                }
              >
                {data.plans.length === 0 ? (
                  <p className="muted small">Aucun achat programmé sur cet actif.</p>
                ) : (
                  <PlansList plans={data.plans} showAsset={false} onChanged={state.reload} onEdit={(plan) => setPanel({ kind: 'PLAN', plan })} />
                )}
              </Card>

              <Card title="Opérations" subtitle={`${data.operations.length} opération(s)`}>
                {data.operations.length === 0 ? (
                  <p className="muted small">Aucune opération.</p>
                ) : (
                  <>
                    <ul className="list" data-testid="operations-list">
                      {(showAll ? data.operations : data.operations.slice(0, 8)).map((operation) => (
                        <OperationRow key={operation.id} operation={operation} onChanged={state.reload} />
                      ))}
                    </ul>
                    {data.operations.length > 8 && (
                      <button type="button" className="btn btn-link" onClick={() => setShowAll((open) => !open)} data-testid="operations-toggle">
                        {showAll ? 'Afficher moins' : `Voir tout (${data.operations.length})`}
                      </button>
                    )}
                  </>
                )}
              </Card>

              {(data.plans.length > 0 || data.operations.some((operation) => operation.deletable)) && (
                <RemoveAsset instrumentId={asset.instrumentId} name={asset.name} />
              )}

              {panel !== null && (
                <Sheet
                  title={
                    panel.kind === 'BUY'
                      ? `Acheter · ${asset.name}`
                      : panel.kind === 'SELL'
                        ? `Vendre · ${asset.name}`
                        : panel.kind === 'PLAN' && panel.plan
                          ? 'Modifier l’investissement programmé'
                          : `Programmer · ${asset.name}`
                  }
                  onClose={() => setPanel(null)}
                >
                  {panel.kind === 'PLAN' ? (
                    <PlanForm
                      asset={asset}
                      {...(panel.plan ? { plan: panel.plan } : {})}
                      onDone={() => {
                        setPanel(null);
                        state.reload();
                      }}
                    />
                  ) : (
                    <OperationForm
                      asset={asset}
                      type={panel.kind}
                      {...(panel.kind === 'SELL' && position ? { maxQuantity: position.quantity } : {})}
                      onDone={() => {
                        setPanel(null);
                        state.reload();
                      }}
                    />
                  )}
                </Sheet>
              )}
            </>
          );
        }}
      </AsyncView>
    </>
  );
}

/** Retirer l'actif : ses opérations saisies et ses achats programmés (erreur d'actif, ligne soldée…). */
function RemoveAsset({ instrumentId, name }: { readonly instrumentId: string; readonly name: string }) {
  const remove = useAction();
  const navigate = useNavigate();
  return (
    <div className="danger-zone">
      <button
        type="button"
        className="btn btn-link small tone-down"
        disabled={remove.pending}
        data-testid="asset-remove"
        onClick={() => {
          if (!window.confirm(`Retirer « ${name} » ? Ses opérations saisies et ses achats programmés seront supprimés.`)) return;
          void remove.run(async () => {
            await request(`/api/holdings/assets/${instrumentId}`, { method: 'DELETE' });
            navigate('/investissements');
            return null;
          });
        }}
      >
        Retirer cet investissement
      </button>
      <ActionFeedback state={remove} />
    </div>
  );
}

function OperationRow({ operation, onChanged }: { readonly operation: HoldingOperationDto; readonly onChanged: () => void }) {
  const remove = useAction();
  const incoming = operation.type === 'BUY' || operation.type === 'TRANSFER_IN' || operation.type === 'STAKING_REWARD';
  return (
    <li className="list-row" data-testid="operation-row">
      <div className="list-row-main">
        <strong>
          {operation.typeLabel}{' '}
          {operation.planId !== null && <Badge tone="info">DCA</Badge>}
        </strong>
        <span>
          {formatDate(operation.date, 'long')} · {formatShares(operation.quantity)} × {formatPrice(operation.unitPrice)}
          {operation.fees > 0 ? ` · frais ${formatEur(operation.fees)}` : ''}
        </span>
        <span>{operation.accountName}</span>
        <ActionFeedback state={remove} />
      </div>
      <div className="list-row-end">
        <strong className={incoming ? '' : 'tone-up'}>{formatSignedEur(operation.amount)}</strong>
        {operation.deletable && (
          <button
            type="button"
            className="btn btn-link small tone-down"
            disabled={remove.pending}
            onClick={() =>
              void remove.run(async () => {
                await request(`/api/holdings/operations/${operation.id}`, { method: 'DELETE' });
                onChanged();
                return null;
              })
            }
          >
            Supprimer
          </button>
        )}
      </div>
    </li>
  );
}
