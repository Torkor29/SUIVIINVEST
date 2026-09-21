import type { ConnectionDto } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { formatDate } from '../../lib/format.ts';
import { Badge, StatusBadge } from '../ui/Stat.tsx';
import { Card } from '../ui/Card.tsx';

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  accounts: 'Comptes',
  balances: 'Soldes',
  positions: 'Positions',
  transactions: 'Transactions',
  income: 'Revenus',
  api: 'API temps réel',
};

export interface ConnectionCardProps {
  readonly connection: ConnectionDto;
  readonly onChanged: () => void;
  readonly onShowRuns: (connectionId: string) => void;
}

/** Fiche d'une connexion : capacités, état, et actions de maintenance. */
export function ConnectionCard({ connection, onChanged, onShowRuns }: ConnectionCardProps) {
  const test = useAction();
  const sync = useAction();
  const remove = useAction();
  const readOnly = !connection.capabilities.api;

  const runTest = (): void => {
    void test.run(async () => {
      await request<unknown>(`/api/connections/${connection.id}/test`, { method: 'POST' });
      onChanged();
      return 'Connexion testée avec succès.';
    });
  };

  const runSync = (): void => {
    void sync.run(async () => {
      const run = await request<{ readonly status: string; readonly created: number } | null>(`/api/connections/${connection.id}/sync`, { method: 'POST' });
      onChanged();
      return run === null ? 'Synchronisation terminée.' : `Synchronisation ${run.status.toLowerCase()} — ${run.created} élément(s) créé(s).`;
    });
  };

  const runDelete = (): void => {
    void remove.run(async () => {
      await request<unknown>(`/api/connections/${connection.id}`, { method: 'DELETE' });
      onChanged();
      return 'Connexion supprimée.';
    });
  };

  return (
    <Card
      title={connection.label}
      subtitle={`${connection.providerName} · ${Object.entries(connection.config)
        .map(([key, value]) => `${key}=${value}`)
        .join(' · ') || 'aucun réglage particulier'}`}
      actions={<StatusBadge status={connection.status} />}
    >
      <div className="conn-meta">
        <span>
          Dernière synchro&nbsp;: <strong>{connection.lastSyncedAt === null ? '—' : formatDate(connection.lastSyncedAt)}</strong>
        </span>
        <span>
          Secrets attendus&nbsp;: <strong>{connection.secretNames.length === 0 ? 'aucun' : connection.secretNames.join(', ')}</strong>
        </span>
      </div>

      <div className="chips">
        {Object.entries(connection.capabilities).map(([key, enabled]) => (
          <Badge key={key} tone={enabled ? 'ok' : 'neutral'} title={enabled ? 'Pris en charge' : 'Non pris en charge'}>
            {CAPABILITY_LABELS[key] ?? key}
          </Badge>
        ))}
      </div>

      {connection.importFormats.length > 0 && (
        <p className="muted small">
          Import disponible&nbsp;: {connection.importFormats.map((format) => format.label).join(', ')}
        </p>
      )}
      {readOnly && <p className="readonly-note"><span className="readonly-dot" aria-hidden="true" />Connexion en lecture seule : aucun ordre ni virement possible.</p>}
      {connection.lastError !== null && <p className="feedback feedback-error">{connection.lastError}</p>}

      <div className="card-actions-row">
        <button type="button" className="btn btn-ghost" onClick={runTest} disabled={test.pending}>
          {test.pending ? 'Test en cours…' : 'Tester'}
        </button>
        <button type="button" className="btn btn-primary" onClick={runSync} disabled={sync.pending}>
          {sync.pending ? 'Synchronisation…' : 'Synchroniser'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onShowRuns(connection.id)}>
          Historique
        </button>
        <button type="button" className="btn btn-danger" onClick={runDelete} disabled={remove.pending}>
          Supprimer
        </button>
      </div>
      <ActionFeedback state={test} />
      <ActionFeedback state={sync} />
      <ActionFeedback state={remove} />
    </Card>
  );
}
