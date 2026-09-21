import type { AccountsResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur, formatMoney, formatPercent } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonTable, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile, Badge } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { AllocationLegend, ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { BarChart } from '../components/charts/BarChart.tsx';
import type { AccountSummary } from '@suiviinvest/api-contract';
import { providerName, TYPE_LABELS } from '../lib/labels.ts';

/** Trésorerie & banques : comptes courants, épargne et devises. */
export function CashPage() {
  const state = useAsync<AccountsResponse>((signal) => request<AccountsResponse>('/api/accounts', { signal }), []);

  const columns: readonly Column<AccountSummary>[] = [
    {
      key: 'name',
      header: 'Compte',
      sort: (row) => row.name,
      render: (row) => (
        <span className="cell-main">
          <strong>{row.name}</strong>
          <small className="cell-sub">{row.externalAccountId ?? 'Saisie manuelle'}</small>
        </span>
      ),
    },
    { key: 'type', header: 'Type', sort: (row) => row.type, render: (row) => <Badge tone="neutral">{TYPE_LABELS[row.type] ?? row.type}</Badge> },
    { key: 'provider', header: 'Établissement', sort: (row) => row.providerId, render: (row) => providerName(row.providerId) },
    {
      key: 'value',
      header: 'Solde',
      align: 'right',
      sort: (row) => row.value,
      render: (row) => (
        <span className="cell-main">
          <strong>{formatEur(row.value)}</strong>
          {row.currency !== 'EUR' && <small className="cell-sub">devise d’origine {formatMoney(row.value, row.currency)}</small>}
        </span>
      ),
    },
    { key: 'cash', header: 'Liquidités', align: 'right', sort: (row) => row.cash, render: (row) => formatEur(row.cash, 0) },
    { key: 'activity', header: 'Dernière activité', align: 'right', sort: (row) => row.lastActivityDate ?? '', render: (row) => formatDate(row.lastActivityDate) },
    { key: 'status', header: 'État', align: 'right', render: (row) => (row.isActive ? 'Actif' : 'Clôturé') },
  ];

  return (
    <>
      <PageHeader
        title="Trésorerie & banques"
        subtitle="Comptes courants, épargne réglementée et comptes en devises."
        actions={<Badge tone="info">Collecte en lecture seule</Badge>}
      />
      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.accounts.length === 0}
        emptyState={<EmptyState title="Aucun compte" hint="Rattachez un établissement dans la section Connexions." />}
        skeleton={
          <>
            <SkeletonTiles count={4} />
            <SkeletonTable rows={5} />
          </>
        }
      >
        {(data) => {
          const cashAccounts = data.accounts.filter((account) => account.type === 'CASH' || account.type === 'SAVINGS');
          const totalCash = cashAccounts.reduce((sum, account) => sum + account.value, 0);
          const largest = cashAccounts.slice().sort((a, b) => b.value - a.value)[0];
          return (
            <>
              <Grid>
                <StatTile label="Trésorerie disponible" value={formatEur(totalCash, 0)} hint={`${cashAccounts.length} compte(s)`} />
                <StatTile label="Comptes courants" value={formatEur(cashAccounts.filter((a) => a.type === 'CASH').reduce((s, a) => s + a.value, 0), 0)} />
                <StatTile label="Épargne" value={formatEur(cashAccounts.filter((a) => a.type === 'SAVINGS').reduce((s, a) => s + a.value, 0), 0)} />
                <StatTile
                  label="Part du patrimoine"
                  value={formatPercent(data.totals.total === 0 ? 0 : (totalCash / data.totals.total) * 100, { sign: false, digits: 1 })}
                  hint={largest === undefined ? undefined : `Premier poste : ${largest.name}`}
                />
              </Grid>

              <Grid className="grid-2">
                <Card title="Soldes par compte" subtitle="Vue immédiate des liquidités par établissement.">
                  <BarChart
                    items={cashAccounts.map((account) => ({ label: account.name, value: account.value }))}
                    ariaLabel="Soldes par compte"
                  />
                </Card>
                <Card title="Répartition par établissement" subtitle="Toutes classes d’actifs confondues.">
                  <div className="split">
                    <DonutChart slices={data.totals.byProvider} centerLabel="Total" centerValue={formatEur(data.totals.total, 0)} />
                    <AllocationLegend slices={data.totals.byProvider} />
                  </div>
                </Card>
              </Grid>

              <Card title="Comptes" subtitle="Solde en euros, devise d’origine conservée si différente." padded={false}>
                <DataTable rows={cashAccounts} columns={columns} rowKey={(row) => row.id} initialSortKey="value" />
              </Card>

              <Card title="Toutes les classes d’actifs">
                <AllocationLegend slices={data.totals.byType} />
              </Card>

              <ReadOnlyNote text="Les connexions bancaires sont en lecture seule : aucun virement ni prélèvement ne peut être initié." />
            </>
          );
        }}
      </AsyncView>
    </>
  );
}
