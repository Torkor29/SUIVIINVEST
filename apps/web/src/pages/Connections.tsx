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
import { EnableBankingPanel } from '../components/connections/EnableBankingPanel.tsx';
import {
  SOURCE_CATALOG,
  SOURCE_GROUPS,
  SOURCE_ORDER,
  summarizeAccounts,
  type SourceDefinition,
} from '../lib/connections.ts';

type ProviderInfo = ConnectionsResponse['providers'][number];

/** Connexions : une carte par source, synchronisation globale et imports de relevés. */
export function ConnectionsPage() {
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [syncAllResult, setSyncAllResult] = useState<SyncAllResponse | null>(null);
  /** Sources à connexions multiples pour lesquelles un formulaire d'ajout est ouvert. */
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
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

  // Toutes les sources connues (catalogue + historiques) : noms lisibles pour les résumés.
  const sources: readonly SourceDefinition[] = [
    ...SOURCE_CATALOG,
    ...SOURCE_ORDER.filter((source) => !SOURCE_CATALOG.some((item) => item.providerId === source.providerId)),
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
        subtitle="Reliez vos banques, courtiers et wallets. Accès en lecture seule : rien ne peut être acheté, vendu ou viré."
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
                hint="Sources qui répondent"
              />
              <StatTile
                label="Action requise"
                value={`${data.connections.filter((connection) => connection.needsReauth || connection.requiresUserAction).length}`}
                hint="Validation ou reconnexion attendue"
              />
              <StatTile label="Synchro automatique" value={data.scheduler.enabled ? 'Actif' : 'Inactif'} hint={data.scheduler.enabled ? 'Vos sources se mettent à jour seules' : 'Désactivée'} />
              <StatTile label="Prochaine synchro" value={data.scheduler.nextRunAt === null ? '—' : formatDate(data.scheduler.nextRunAt)} hint={`Dernière : ${formatDate(data.scheduler.lastRunAt)}`} />
            </Grid>

            {SOURCE_GROUPS.map((group) => {
              // Sources proposées par ce serveur (une build de test peut en avoir moins).
              const groupSources = SOURCE_CATALOG.filter(
                (source) =>
                  source.group === group.id && data.providers.some((provider) => provider.providerId === source.providerId),
              );
              if (groupSources.length === 0) return null;
              const reload = (): void => {
                state.reload();
                accounts.reload();
              };
              return (
                <section key={group.id} className="conn-group" data-testid={`connections-group-${group.id}`}>
                  <header className="conn-group-head">
                    <h2 className="section-title">{group.title}</h2>
                    <p className="muted">{group.subtitle}</p>
                  </header>
                  <div className="conn-grid">
                    {groupSources.flatMap((source) => {
                      const provider = data.providers.find((item) => item.providerId === source.providerId);
                      const requiredConfig = provider?.requiredConfig ?? [];
                      const existing = data.connections.filter((item) => item.providerId === source.providerId);
                      const card = (connection: (typeof existing)[number] | null, testId: string, extra?: { startOpen?: boolean; onCancelNew?: () => void }) => (
                        <ConnectionCard
                          key={connection?.id ?? `${source.providerId}-new`}
                          source={source}
                          connection={connection}
                          accounts={summarizeAccounts(accounts.data?.accounts ?? [], source.providerId, connection?.id ?? null)}
                          requiredConfig={requiredConfig}
                          onChanged={() => {
                            setAdding((current) => {
                              const next = new Set(current);
                              next.delete(source.providerId);
                              return next;
                            });
                            reload();
                          }}
                          onShowRuns={setRunsFor}
                          testId={testId}
                          {...(extra?.startOpen ? { startOpen: true } : {})}
                          {...(extra?.onCancelNew ? { onCancelNew: extra.onCancelNew } : {})}
                        />
                      );

                      if (source.providerId === 'enable_banking') {
                        return [
                          ...existing.map((connection, index) =>
                            card(connection, index === 0 ? 'connection-card-enable_banking' : `connection-card-enable_banking-${index}`),
                          ),
                          <EnableBankingPanel key="enable-banking-panel" onChanged={reload} />,
                        ];
                      }
                      if (!source.multiple) {
                        return [card(existing[0] ?? null, `connection-card-${source.providerId}`)];
                      }
                      if (existing.length === 0) return [card(null, `connection-card-${source.providerId}`)];
                      const cards = existing.map((connection, index) =>
                        card(connection, index === 0 ? `connection-card-${source.providerId}` : `connection-card-${source.providerId}-${index}`),
                      );
                      if (adding.has(source.providerId)) {
                        cards.push(
                          card(null, `connection-add-card-${source.providerId}`, {
                            startOpen: true,
                            onCancelNew: () =>
                              setAdding((current) => {
                                const next = new Set(current);
                                next.delete(source.providerId);
                                return next;
                              }),
                          }),
                        );
                      } else {
                        cards.push(
                          <button
                            key={`${source.providerId}-add`}
                            type="button"
                            className="conn-add-tile"
                            data-testid={`connection-add-${source.providerId}`}
                            onClick={() => setAdding((current) => new Set(current).add(source.providerId))}
                          >
                            <span className="conn-add-plus" aria-hidden="true">
                              +
                            </span>
                            <span>
                              <strong>Ajouter : {source.providerName}</strong>
                              <small>{source.description}</small>
                            </span>
                          </button>,
                        );
                      }
                      return cards;
                    })}
                  </div>
                </section>
              );
            })}

            {runsFor !== null && (
              <SyncRunsTable
                runs={runs.data ?? []}
                title={`Historique — ${data.connections.find((connection) => connection.id === runsFor)?.label ?? runsFor}`}
                onClose={() => setRunsFor(null)}
              />
            )}

            <WalletsPanel />

            <Card title="Établissements pris en charge" subtitle="Ce que chaque source permet de récupérer." padded={false}>
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
