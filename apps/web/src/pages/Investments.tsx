import { useState } from 'react';
import type { AccountsResponse, InvestmentsResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatEur, formatNumber, formatPercent, formatQuantity, formatSignedEur, toneOf } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonTable, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { AllocationLegend, ReadOnlyNote, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import type { PositionDto } from '@suiviinvest/api-contract';

/** Investissements : positions, plus/moins-values, performance et allocation. */
export function InvestmentsPage() {
  const [accountId, setAccountId] = useState<string>('');
  const accounts = useAsync<AccountsResponse>((signal) => request<AccountsResponse>('/api/accounts', { signal }), []);
  const state = useAsync<InvestmentsResponse>(
    (signal) => request<InvestmentsResponse>('/api/investments', { query: { accountId }, signal }),
    [accountId],
  );

  const investmentAccounts = (accounts.data?.accounts ?? []).filter((account) => account.type === 'INVESTMENT');

  const columns: readonly Column<PositionDto>[] = [
    {
      key: 'name',
      header: 'Instrument',
      sort: (row) => row.name,
      render: (row) => (
        <span className="cell-main">
          <strong>{row.symbol ?? row.name}</strong>
          <small className="cell-sub">
            {row.name}
            {row.isin !== null ? ` · ${row.isin}` : ''}
          </small>
        </span>
      ),
    },
    { key: 'account', header: 'Compte', sort: (row) => row.accountName, render: (row) => row.accountName },
    { key: 'quantity', header: 'Quantité', align: 'right', sort: (row) => row.quantity, render: (row) => formatQuantity(row.quantity) },
    { key: 'cost', header: 'PRU', align: 'right', sort: (row) => row.averageCost, render: (row) => formatNumber(row.averageCost) },
    {
      key: 'price',
      header: 'Dernier prix',
      align: 'right',
      sort: (row) => row.lastPrice ?? 0,
      render: (row) => (row.lastPrice === null ? '—' : `${formatNumber(row.lastPrice)} ${row.currency}`),
    },
    {
      key: 'value',
      header: 'Valeur',
      align: 'right',
      sort: (row) => row.marketValueEur,
      render: (row) =>
        row.currency === 'EUR' ? (
          formatEur(row.marketValue)
        ) : (
          <span className="cell-main">
            <strong>{formatEur(row.marketValueEur)}</strong>
            <small className="cell-sub">
              {formatNumber(row.marketValue)} {row.currency}
            </small>
          </span>
        ),
    },
    {
      key: 'pnl',
      header: '+/- value',
      align: 'right',
      sort: (row) => row.unrealizedPnl,
      render: (row) => (
        <span className={`tone-${toneOf(row.unrealizedPnl)}`}>
          {formatSignedEur(row.unrealizedPnl)}
          <small className="cell-sub">{formatPercent(row.unrealizedPnlPercent)}</small>
        </span>
      ),
    },
    { key: 'weight', header: 'Poids', align: 'right', sort: (row) => row.weightPercent, render: (row) => formatPercent(row.weightPercent, { sign: false, digits: 1 }) },
    { key: 'dividends', header: 'Dividendes', align: 'right', sort: (row) => row.dividends, render: (row) => formatEur(row.dividends, 0) },
  ];

  return (
    <>
      <PageHeader
        title="Investissements"
        subtitle="Actions, ETF et fonds, valorisés en euros."
        actions={
          <label className="field">
            <span className="field-label">Compte</span>
            <select className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Tous les comptes</option>
              {investmentAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.positions.length === 0}
        emptyState={<EmptyState title="Aucune position" hint="Synchronisez un courtier ou importez un relevé pour voir vos positions." />}
        skeleton={
          <>
            <SkeletonTiles count={4} />
            <SkeletonTable rows={6} />
          </>
        }
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Valeur de marché" value={formatEur(data.totals.marketValue)} hint={`${data.positions.length} lignes`} />
              <StatTile
                label="+/- value latente"
                value={formatSignedEur(data.totals.unrealizedPnl)}
                delta={{ absolute: data.totals.unrealizedPnl, percent: data.totals.unrealizedPnlPercent }}
                hint={`Prix de revient ${formatEur(data.totals.costBasis, 0)}`}
              />
              <StatTile label="Dividendes encaissés" value={formatEur(data.totals.dividends, 0)} hint="Depuis l’origine" />
              <StatTile label="Plus-values encaissées" value={formatSignedEur(data.totals.realizedPnl, 0)} hint={`Frais ${formatEur(data.totals.fees, 0)}`} />
            </Grid>

            <Grid className="grid-2">
              <Card title="Performance" subtitle={`Période ${data.performance.period}`}>
                <div className="kv-grid">
                  <div className="kv">
                    <span className="kv-label">TRI pondéré (TWR)</span>
                    <span className="kv-value">{formatPercent(data.performance.twr ?? 0)}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-label">TRI (XIRR)</span>
                    <span className="kv-value">{formatPercent(data.performance.xirr ?? 0)}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-label">Annualisé</span>
                    <span className="kv-value">{formatPercent(data.performance.annualized ?? 0)}</span>
                  </div>
                  <div className="kv">
                    <span className="kv-label">Baisse maximale</span>
                    <span className="kv-value tone-down">{formatPercent(data.performance.maxDrawdown ?? 0)}</span>
                  </div>
                </div>
                {data.performance.note !== null && <p className="muted small">{data.performance.note}</p>}
              </Card>
              <Card title="Allocation par ligne" subtitle="Vos huit plus grosses positions.">
                <div className="split">
                  <DonutChart slices={data.allocation} centerLabel="Portefeuille" centerValue={formatEur(data.totals.marketValue, 0)} />
                  <AllocationLegend slices={data.allocation} />
                </div>
              </Card>
            </Grid>

            <Card title="Positions" subtitle="Cliquez sur une colonne pour trier." padded={false}>
              <DataTable rows={data.positions} columns={columns} rowKey={(row) => row.instrumentId + row.accountId} initialSortKey="value" />
            </Card>

            <WarningsList warnings={data.warnings} />
            <ReadOnlyNote text="Aucun ordre d’achat ou de vente n’est possible depuis SuiviInvest : l’outil ne fait que lire vos positions." />
          </>
        )}
      </AsyncView>
    </>
  );
}
