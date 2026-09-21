import { useState } from 'react';
import type { ConnectionsResponse, SyncRunDto } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { formatDate } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { SkeletonLines } from '../components/ui/Skeleton.tsx';
import { StatTile, Badge } from '../components/ui/Stat.tsx';
import { DataTable, type Column } from '../components/ui/DataTable.tsx';
import { ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';
import { ConnectionCard } from '../components/connections/ConnectionCard.tsx';
import { SyncRunsTable } from '../components/connections/SyncRunsTable.tsx';
import { ImportPanel } from '../components/connections/ImportPanel.tsx';

type ProviderInfo = ConnectionsResponse['providers'][number];

/** Connexions : établissements, capacités, synchronisations et imports de relevés. */
export function ConnectionsPage() {
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const state = useAsync<ConnectionsResponse>((signal) => request<ConnectionsResponse>('/api/connections', { signal }), []);
  const runs = useAsync<readonly SyncRunDto[]>(
    (signal) =>
      runsFor === null
        ? Promise.resolve<readonly SyncRunDto[]>([])
        : request<readonly SyncRunDto[]>(`/api/connections/${runsFor}/runs`, { signal }),
    [runsFor],
  );
  const syncAll = useAction();

  const providerColumns: readonly Column<ProviderInfo>[] = [
    {
      key: 'name',
      header: 'Établissement',
      sort: (row) => row.providerName,
      render: (row) => (
        <span className="cell-main">
          <strong>{row.providerName}</strong>
          <small className="cell-sub">{row.notes}</small>
        </span>
      ),
    },
    {
      key: 'implemented',
      header: 'Connecteur',
      render: (row) => <Badge tone={row.implemented ? 'ok' : 'neutral'}>{row.implemented ? 'Disponible' : 'Manuel'}</Badge>,
    },
    {
      key: 'api',
      header: 'Collecte',
      render: (row) => <span className="muted small">{row.apiSupported ? 'API en lecture seule' : row.importFormats.length > 0 ? 'Import de relevés' : 'Saisie manuelle'}</span>,
    },
    { key: 'secrets', header: 'Secrets', render: (row) => <span className="muted small">{row.requiredSecrets.length === 0 ? '—' : row.requiredSecrets.join(', ')}</span> },
    { key: 'formats', header: 'Formats', render: (row) => <span className="muted small">{row.importFormats.length === 0 ? '—' : row.importFormats.join(', ')}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Connexions"
        subtitle="Collecte des comptes, positions et transactions — toujours en lecture seule."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={syncAll.pending}
            onClick={() =>
              void syncAll.run(async () => {
                const result = await request<readonly SyncRunDto[]>('/api/connections/sync-all', { method: 'POST' });
                state.reload();
                return `Synchronisation globale lancée : ${result.length} passage(s) journalisé(s).`;
              })
            }
          >
            {syncAll.pending ? 'Synchronisation…' : 'Tout synchroniser'}
          </button>
        }
      />
      <ActionFeedback state={syncAll} />

      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        skeleton={<SkeletonLines lines={8} />}
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Connexions" value={`${data.connections.length}`} hint={`${data.connections.filter((c) => c.status === 'OK').length} opérationnelle(s)`} />
              <StatTile
                label="À réauthentifier"
                value={`${data.connections.filter((c) => c.needsReauth).length}`}
                hint="Jeton expiré ou action requise"
              />
              <StatTile label="Planificateur" value={data.scheduler.enabled ? 'Actif' : 'Inactif'} hint={data.scheduler.cron ?? 'aucune planification'} />
              <StatTile label="Prochaine passe" value={data.scheduler.nextRunAt === null ? '—' : formatDate(data.scheduler.nextRunAt)} hint={`Dernière : ${formatDate(data.scheduler.lastRunAt)}`} />
            </Grid>

            {data.connections.map((connection) => (
              <ConnectionCard key={connection.id} connection={connection} onChanged={state.reload} onShowRuns={setRunsFor} />
            ))}

            {runsFor !== null && (
              <SyncRunsTable
                runs={runs.data ?? []}
                title={`Historique — ${data.connections.find((connection) => connection.id === runsFor)?.label ?? runsFor}`}
                onClose={() => setRunsFor(null)}
              />
            )}

            <Card title="Établissements pris en charge" subtitle="Ce que chaque connecteur sait collecter." padded={false}>
              <DataTable rows={data.providers} columns={providerColumns} rowKey={(row) => row.providerId} />
            </Card>

            <ImportPanel />

            <ReadOnlyNote text="Toutes les connexions sont en lecture seule : SuiviInvest ne peut ni ordonner, ni virer, ni signer." />
          </>
        )}
      </AsyncView>
    </>
  );
}
