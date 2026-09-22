import { useState } from 'react';
import type {
  AccountsResponse,
  ConnectionsResponse,
  SyncAllResponse,
  SyncRunDto,
} from '@suiviinvest/api-contract';
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
import { SyncAllSummary } from '../components/connections/SyncAllSummary.tsx';
import { WalletsPanel } from '../components/connections/WalletsPanel.tsx';
import { SOURCE_ORDER, summarizeAccounts, type SourceDefinition } from '../lib/connections.ts';

type ProviderInfo = ConnectionsResponse['providers'][number];

/** Connexions : une carte par source, synchronisation globale et imports de relevés. */
export function ConnectionsPage() {
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [syncAllResult, setSyncAllResult] = useState<SyncAllResponse | null>(null);
  const state = useAsync<ConnectionsResponse>((signal) => request<ConnectionsResponse>('/api/connections', { signal }), []);
  const accounts = useAsync<AccountsResponse>((signal) => request<AccountsResponse>('/api/accounts', { signal }), []);
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
      render: (row) => (
        <span className="muted small">
          {row.apiSupported ? 'API en lecture seule' : row.importFormats.length > 0 ? 'Import de relevés' : 'Saisie manuelle'}
        </span>
      ),
    },
    { key: 'secrets', header: 'Secrets', render: (row) => <span className="muted small">{row.requiredSecrets.length === 0 ? '—' : row.requiredSecrets.join(', ')}</span> },
    { key: 'formats', header: 'Formats', render: (row) => <span className="muted small">{row.importFormats.length === 0 ? '—' : row.importFormats.join(', ')}</span> },
  ];

  const sources: readonly SourceDefinition[] = state.data === null
    ? SOURCE_ORDER
    : [
        ...SOURCE_ORDER,
        ...state.data.connections
          .filter((connection) => !SOURCE_ORDER.some((source) => source.providerId === connection.providerId))
          .map((connection) => ({ providerId: connection.providerId, providerName: connection.providerName })),
      ];

  const runSyncAll = (): void => {
    setSyncAllResult(null);
    void syncAll.run(async () => {
      const response = await request<SyncAllResponse>('/api/connections/sync-all', { method: 'POST' });
      setSyncAllResult(response);
      state.reload();
      accounts.reload();
      return `Synchronisation globale terminée : ${response.summary.succeeded} source(s) sur ${response.summary.total} ont répondu.`;
    });
  };

  return (
    <>
      <PageHeader
        title="Connexions"
        subtitle="Collecte des comptes, positions et transactions — toujours en lecture seule."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            data-testid="sync-all"
            disabled={syncAll.pending}
            onClick={runSyncAll}
          >
            {syncAll.pending ? 'Synchronisation…' : 'Synchroniser tout'}
          </button>
        }
      />
      <ActionFeedback state={syncAll} />

      {syncAllResult !== null && (
        <SyncAllSummary
          response={syncAllResult}
          providerNames={Object.fromEntries(sources.map((source) => [source.providerId, source.providerName]))}
          onClose={() => setSyncAllResult(null)}
        />
      )}

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
              <StatTile label="Sources" value={`${sources.length}`} hint={`${data.connections.length} connexion(s) enregistrée(s)`} />
              <StatTile
                label="Opérationnelles"
                value={`${data.connections.filter((connection) => connection.status === 'OK' || connection.status === 'CONNECTED' || connection.status === 'SYNCED').length}`}
                hint="Statut renvoyé par le serveur"
              />
              <StatTile
                label="Action requise"
                value={`${data.connections.filter((connection) => connection.needsReauth || connection.requiresUserAction).length}`}
                hint="Validation ou jeton expiré"
              />
              <StatTile label="Planificateur" value={data.scheduler.enabled ? 'Actif' : 'Inactif'} hint={data.scheduler.cron ?? 'aucune planification'} />
              <StatTile label="Prochaine passe" value={data.scheduler.nextRunAt === null ? '—' : formatDate(data.scheduler.nextRunAt)} hint={`Dernière : ${formatDate(data.scheduler.lastRunAt)}`} />
            </Grid>

            <div className="conn-grid">
              {sources.map((source) => {
                const connection = data.connections.find((item) => item.providerId === source.providerId) ?? null;
                const provider = data.providers.find((item) => item.providerId === source.providerId);
                const summary = summarizeAccounts(accounts.data?.accounts ?? [], source.providerId);
                return (
                  <ConnectionCard
                    key={source.providerId}
                    source={source}
                    connection={connection}
                    accounts={summary}
                    requiredConfig={provider?.requiredConfig ?? []}
                    onChanged={() => {
                      state.reload();
                      accounts.reload();
                    }}
                    onShowRuns={setRunsFor}
                  />
                );
              })}
            </div>

            {runsFor !== null && (
              <SyncRunsTable
                runs={runs.data ?? []}
                title={`Historique — ${data.connections.find((connection) => connection.id === runsFor)?.label ?? runsFor}`}
                onClose={() => setRunsFor(null)}
              />
            )}

            <WalletsPanel />

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
