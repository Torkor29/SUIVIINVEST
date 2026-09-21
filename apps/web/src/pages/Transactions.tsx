import { useMemo, useState } from 'react';
import type { AccountsResponse, TransactionsResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur, formatNumber } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonTable } from '../components/ui/Skeleton.tsx';
import { StatTile } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { AllocationLegend } from '../components/ui/AllocationLegend.tsx';
import { TransactionFilters, type TransactionFilterValues } from '../components/transactions/TransactionFilters.tsx';
import type { TransactionDto } from '@suiviinvest/api-contract';

const PAGE_SIZE = 40;

const EMPTY_FILTERS: TransactionFilterValues = { search: '', accountId: '', type: '', from: '', to: '', minAmount: '', maxAmount: '' };

/** Transactions : filtres combinables, pagination par curseur, tri par colonne. */
export function TransactionsPage() {
  const [filters, setFilters] = useState<TransactionFilterValues>(EMPTY_FILTERS);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.length === 0 ? '' : cursors[cursors.length - 1] ?? '';
  const accounts = useAsync<AccountsResponse>((signal) => request<AccountsResponse>('/api/accounts', { signal }), []);

  const query = useMemo(
    () => ({
      search: filters.search === '' ? undefined : filters.search,
      accountId: filters.accountId === '' ? undefined : filters.accountId,
      type: filters.type === '' ? undefined : filters.type,
      from: filters.from === '' ? undefined : filters.from,
      to: filters.to === '' ? undefined : filters.to,
      minAmount: filters.minAmount === '' ? undefined : Number.parseFloat(filters.minAmount),
      maxAmount: filters.maxAmount === '' ? undefined : Number.parseFloat(filters.maxAmount),
      cursor: cursor === '' ? undefined : cursor,
      limit: PAGE_SIZE,
    }),
    [filters, cursor],
  );

  const state = useAsync<TransactionsResponse>(
    (signal) => request<TransactionsResponse>('/api/transactions', { query, signal }),
    [JSON.stringify(query)],
  );

  const columns: readonly Column<TransactionDto>[] = [
    { key: 'date', header: 'Date', sort: (row) => row.date, render: (row) => formatDate(row.date) },
    {
      key: 'description',
      header: 'Libellé',
      sort: (row) => row.description ?? '',
      render: (row) => (
        <span className="cell-main">
          <strong>{row.description ?? row.instrumentName ?? row.type}</strong>
          {row.instrumentName !== null && row.description !== null && <small className="cell-sub">{row.instrumentName}</small>}
        </span>
      ),
    },
    { key: 'type', header: 'Type', sort: (row) => row.type, render: (row) => <span className="pill">{row.type}</span> },
    { key: 'account', header: 'Compte', sort: (row) => row.accountName, render: (row) => row.accountName },
    { key: 'quantity', header: 'Quantité', align: 'right', sort: (row) => row.quantity ?? 0, render: (row) => (row.quantity === null ? '—' : formatNumber(row.quantity, 4)) },
    { key: 'unitPrice', header: 'Cours', align: 'right', sort: (row) => row.unitPrice ?? 0, render: (row) => (row.unitPrice === null ? '—' : formatNumber(row.unitPrice)) },
    {
      key: 'amount',
      header: 'Montant',
      align: 'right',
      sort: (row) => row.amountEur,
      render: (row) => (
        <span className="cell-main">
          <strong className={row.amountEur < 0 ? 'tone-down' : 'tone-up'}>{formatEur(row.amountEur)}</strong>
          {row.currency !== 'EUR' && <small className="cell-sub">{formatNumber(row.amount)} {row.currency}</small>}
        </span>
      ),
    },
    { key: 'fees', header: 'Frais', align: 'right', sort: (row) => row.fees, render: (row) => (row.fees === 0 ? '—' : formatEur(row.fees)) },
    { key: 'source', header: 'Source', align: 'right', render: (row) => <span className="muted small">{row.source}</span> },
  ];

  return (
    <>
      <PageHeader title="Transactions" subtitle="Historique consolidé, importé des établissements ou de vos relevés CSV." />

      <Card title="Filtres" subtitle="Les filtres se cumulent ; les montants sont exprimés en euros.">
        <TransactionFilters
          values={filters}
          accounts={accounts.data?.accounts ?? []}
          onChange={(next) => {
            setCursors([]);
            setFilters(next);
          }}
          onReset={() => {
            setCursors([]);
            setFilters(EMPTY_FILTERS);
          }}
        />
      </Card>

      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.items.length === 0}
        emptyState={<EmptyState title="Aucune transaction" hint="Élargissez la période ou retirez un filtre." />}
        skeleton={<SkeletonTable rows={8} />}
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Transactions correspondantes" value={`${data.total}`} hint={`Page de ${PAGE_SIZE} lignes`} />
              <StatTile
                label="Total des montants"
                value={formatEur(data.items.reduce((sum, item) => sum + item.amountEur, 0), 0)}
                hint="Sur la page affichée"
              />
              <StatTile
                label="Frais de la page"
                value={formatEur(data.items.reduce((sum, item) => sum + item.fees, 0))}
                hint="Courtage, gestion"
              />
            </Grid>

            <Card title="Répartition par type" subtitle="Montants absolus des transactions filtrées.">
              <AllocationLegend slices={data.totalsByType} />
            </Card>

            <Card title="Historique" padded={false}>
              <DataTable
                rows={data.items}
                columns={columns}
                rowKey={(row) => row.id}
                initialSortKey="date"
                maxRows={PAGE_SIZE}
                emptyTitle="Aucune transaction"
              />
              <div className="pager">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((current) => current.slice(0, Math.max(current.length - 1, 0)))}
                >
                  Page précédente
                </button>
                <span className="muted small">Page {cursors.length + 1}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={data.nextCursor === null}
                  onClick={() => setCursors((current) => [...current, data.nextCursor ?? ''])}
                >
                  Page suivante
                </button>
              </div>
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}
