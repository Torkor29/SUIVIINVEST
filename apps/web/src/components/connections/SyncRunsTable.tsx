import type { SyncRunDto } from '@suiviinvest/api-contract';
import { formatDate, formatDuration } from '../../lib/format.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatusBadge } from '../ui/Stat.tsx';
import { Card } from '../ui/Card.tsx';

/** Historique des synchronisations (toutes connexions ou une seule). */
export function SyncRunsTable({ runs, title, onClose }: { readonly runs: readonly SyncRunDto[]; readonly title: string; readonly onClose?: () => void }) {
  const columns: readonly Column<SyncRunDto>[] = [
    { key: 'started', header: 'Début', sort: (row) => row.startedAt, render: (row) => formatDate(row.startedAt) },
    { key: 'provider', header: 'Établissement', sort: (row) => row.providerId, render: (row) => row.providerId },
    { key: 'trigger', header: 'Déclencheur', sort: (row) => row.trigger, render: (row) => <span className="pill">{row.trigger}</span> },
    { key: 'status', header: 'État', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: 'Créés', align: 'right', sort: (row) => row.created, render: (row) => `${row.created}` },
    { key: 'updated', header: 'Mis à jour', align: 'right', sort: (row) => row.updated, render: (row) => `${row.updated}` },
    { key: 'skipped', header: 'Ignorés', align: 'right', sort: (row) => row.skipped, render: (row) => `${row.skipped}` },
    { key: 'errors', header: 'Erreurs', align: 'right', sort: (row) => row.errors, render: (row) => (row.errors === 0 ? '—' : <span className="tone-down">{row.errors}</span>) },
    { key: 'duration', header: 'Durée', align: 'right', sort: (row) => row.durationMs ?? 0, render: (row) => formatDuration(row.durationMs) },
    { key: 'message', header: 'Message', render: (row) => <span className="muted small">{row.message ?? '—'}</span> },
  ];

  return (
    <Card
      title={title}
      subtitle="Chaque passage de synchronisation est journalisé côté serveur."
      actions={onClose === undefined ? undefined : <button type="button" className="btn btn-ghost" onClick={onClose}>Fermer</button>}
      padded={false}
    >
      <DataTable rows={runs} columns={columns} rowKey={(row) => row.syncRunId} initialSortKey="started" emptyTitle="Aucune synchronisation" />
    </Card>
  );
}
