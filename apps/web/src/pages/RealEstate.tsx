import type { RealEstateResponse, PropertyDto } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur, formatPercent, formatSignedEur, toneOf } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonLines, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile, KeyValue } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';
import { BarChart } from '../components/charts/BarChart.tsx';
import { PropertyCard } from '../components/realestate/PropertyCard.tsx';
import type { PropertyCashFlowDto } from '@suiviinvest/api-contract';

/** Immobilier : biens, crédits, rendements, flux de trésorerie et amortissement. */
export function RealEstatePage() {
  const state = useAsync<RealEstateResponse>((signal) => request<RealEstateResponse>('/api/real-estate', { signal }), []);
  const properties = state.data?.properties ?? [];
  const firstProperty = properties[0];
  const amortization = firstProperty?.amortization ?? [];
  const loanEnd = firstProperty?.loan?.endDate ?? null;

  const cashFlowColumns: readonly Column<PropertyCashFlowDto>[] = [
    {
      key: 'date',
      header: 'Échéance',
      sort: (row) => row.date,
      render: (row) => (
        <span className="cell-main">
          <strong>{formatDate(row.date)}</strong>
          <small className="cell-sub">{recurrenceLabel(row.recurrence)}</small>
        </span>
      ),
    },
    { key: 'label', header: 'Flux', sort: (row) => row.label, render: (row) => row.label },
    { key: 'category', header: 'Catégorie', sort: (row) => row.category, render: (row) => <span className="muted small">{row.category}</span> },
    {
      key: 'direction',
      header: 'Sens',
      render: (row) => <span className={`tone-${row.direction === 'INCOME' ? 'up' : 'down'}`}>{row.direction === 'INCOME' ? 'Encaissement' : 'Décaissement'}</span>,
    },
    {
      key: 'amount',
      header: 'Montant',
      align: 'right',
      sort: (row) => (row.direction === 'INCOME' ? row.amount : -row.amount),
      render: (row) => (
        <span className={`tone-${row.direction === 'INCOME' ? 'up' : 'down'}`}>
          {row.direction === 'INCOME' ? '+' : '−'}
          {formatEur(row.amount, 0)}
        </span>
      ),
    },
    { key: 'received', header: 'Statut', align: 'right', render: (row) => (row.received ? 'Encaissé' : 'À venir') },
  ];

  return (
    <>
      <PageHeader title="Immobilier" subtitle="Biens locatifs, crédits en cours et cash-flow après échéance." />
      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.properties.length === 0}
        emptyState={<EmptyState title="Aucun bien" hint="Les biens déclarés apparaîtront ici avec leur crédit et leurs loyers." />}
        skeleton={
          <>
            <SkeletonTiles count={4} />
            <SkeletonLines lines={6} />
          </>
        }
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Valeur des biens" value={formatEur(data.totals.currentValue, 0)} hint={`${data.properties.length} bien(s)`} />
              <StatTile label="Capital restant dû" value={formatEur(data.totals.loanBalance, 0)} hint={`Intérêts payés ${formatEur(data.totals.interestPaid, 0)}`} />
              <StatTile label="Fonds propres" value={formatEur(data.totals.equity, 0)} hint={`Plus-value latente ${formatEur(data.totals.unrealizedGain, 0)}`} />
              <StatTile
                label="Cash-flow annuel après crédit"
                value={formatSignedEur(data.totals.annualCashFlowAfterLoan, 0)}
                delta={{ absolute: data.totals.annualCashFlowAfterLoan, percent: data.portfolio.netYield }}
                hint={`Rendement brut ${formatPercent(data.portfolio.grossYield, { sign: false, digits: 2 })}`}
              />
            </Grid>

            {data.properties.map((property) => (
              <PropertyCard key={property.accountId} property={property} />
            ))}

            <Grid className="grid-2">
              <Card title="Amortissement du premier crédit" subtitle="Intérêts et capital par échéance annuelle.">
                <BarChart items={annualAmortization(firstProperty)} months={false} ariaLabel="Amortissement annuel" />
                <p className="muted small">
                  {amortization.length} échéances modélisées
                  {loanEnd === null ? '' : ` · fin du prêt ${formatDate(loanEnd)}`}
                </p>
              </Card>
              <Card title="Flux de trésorerie déclarés" subtitle="Loyers, charges, taxes et assurances récurrents.">
                <DataTable
                  rows={properties.flatMap((property) => property.cashFlows)}
                  columns={cashFlowColumns}
                  rowKey={(row) => row.id}
                  initialSortKey="date"
                  initialSortDesc={false}
                />
              </Card>
            </Grid>

            <Card title="Synthèse du portefeuille">
              <div className="kv-grid">
                <KeyValue label="Rendement brut global" value={formatPercent(data.portfolio.grossYield, { sign: false })} />
                <KeyValue label="Rendement net global" value={formatPercent(data.portfolio.netYield, { sign: false })} />
                <KeyValue
                  label="Cash-flow mensuel après crédit"
                  value={formatSignedEur(data.portfolio.monthlyCashFlow, 0)}
                  tone={toneOf(data.portfolio.monthlyCashFlow)}
                />
                <KeyValue label="Loyers annuels" value={formatEur(data.totals.annualIncome, 0)} />
                <KeyValue label="Charges annuelles" value={formatEur(data.totals.annualExpenses, 0)} />
              </div>
            </Card>

            <ReadOnlyNote text="Les biens et crédits sont saisis manuellement : aucune opération bancaire n’est déclenchée." />
          </>
        )}
      </AsyncView>
    </>
  );
}

function recurrenceLabel(recurrence: PropertyCashFlowDto['recurrence']): string {
  if (recurrence === 'MONTHLY') return 'Mensuel';
  if (recurrence === 'QUARTERLY') return 'Trimestriel';
  if (recurrence === 'YEARLY') return 'Annuel';
  return 'Ponctuel';
}

/** Agrège l'amortissement par année civile (intérêts négatifs, capital positifs). */
export function annualAmortization(property: PropertyDto | undefined): readonly { readonly label: string; readonly value: number }[] {
  if (property === undefined) return [];
  const buckets = new Map<string, { interest: number; principal: number }>();
  for (const row of property.amortization) {
    const year = row.date.slice(0, 4);
    const current = buckets.get(year) ?? { interest: 0, principal: 0 };
    buckets.set(year, { interest: current.interest + row.interest, principal: current.principal + row.principal });
  }
  return [...buckets.entries()].map(([year, bucket]) => ({ label: year, value: Math.round((bucket.principal - bucket.interest) * 100) / 100 }));
}
