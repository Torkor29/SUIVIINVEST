import { useState } from 'react';
import { plural } from '@suiviinvest/core/text';
import type { AccountsResponse, ImportAnalyzeResponse, ImportCommitResponse, ImportHistoryDto } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { formatDate, formatEur } from '../../lib/format.ts';
import { Card } from '../ui/Card.tsx';
import { Badge, StatTile } from '../ui/Stat.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SkeletonTable } from '../ui/Skeleton.tsx';

/** Import de relevés CSV : analyse, aperçu, détection des doublons puis validation. */
export function ImportPanel() {
  const [filename, setFilename] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalyzeResponse | null>(null);
  const [result, setResult] = useState<ImportCommitResponse | null>(null);
  // Le compte cible est OBLIGATOIRE côté serveur : un relevé sans compte de
  // destination serait refusé, donc l'interface le demande explicitement.
  const [accountId, setAccountId] = useState<string>('');
  const analyze = useAction();
  const commit = useAction();
  const history = useAsync<readonly ImportHistoryDto[]>((signal) => request<readonly ImportHistoryDto[]>('/api/imports', { signal }), []);
  const accounts = useAsync<AccountsResponse>((signal) => request<AccountsResponse>('/api/accounts', { signal }), []);

  const onFile = async (file: File): Promise<void> => {
    const text = await file.text();
    setFilename(file.name);
    setContent(text);
    setAnalysis(null);
    setResult(null);
    await analyze.run(async () => {
      const response = await request<ImportAnalyzeResponse>('/api/imports/analyze', {
        method: 'POST',
        json: {
          filename: file.name,
          content: text,
          ...(accountId === '' ? {} : { accountId }),
        },
      });
      setAnalysis(response);
      return (
        `${plural(response.summary.parsed, 'ligne analysée', 'lignes analysées')} — ` +
        `${plural(response.summary.new, 'nouvelle', 'nouvelles')}, ` +
        `${plural(response.summary.duplicates, 'doublon', 'doublons')}.`
      );
    });
  };

  const submit = (dryRun: boolean): void => {
    if (filename === null || content === null) return;
    void commit.run(async () => {
      const response = await request<ImportCommitResponse>('/api/imports/commit', {
        method: 'POST',
        json: { filename, content, dryRun, ...(accountId === '' ? {} : { accountId }) },
      });
      setResult(response);
      history.reload();
      // Le retour DURABLE est rendu plus bas (`import-outcome`) : renvoyer le
      // message ici l'afficherait une seconde fois, juste au-dessus.
      return null;
    });
  };

  const previewColumns: readonly Column<ImportAnalyzeResponse['rows'][number]>[] = [
    { key: 'line', header: 'Ligne', align: 'right', sort: (row) => row.line, render: (row) => `${row.line}` },
    { key: 'date', header: 'Date', sort: (row) => row.date ?? '', render: (row) => formatDate(row.date) },
    { key: 'type', header: 'Type', render: (row) => <span className="pill">{row.type ?? '—'}</span> },
    { key: 'description', header: 'Libellé', render: (row) => row.description },
    { key: 'amount', header: 'Montant', align: 'right', sort: (row) => row.amount ?? 0, render: (row) => (row.amount === null ? '—' : formatEur(row.amount)) },
    { key: 'currency', header: 'Devise', align: 'right', render: (row) => row.currency ?? '—' },
    {
      key: 'status',
      header: 'Contrôle',
      render: (row) => (
        <Badge tone={row.status === 'NEW' ? 'ok' : row.status === 'ERROR' ? 'danger' : 'warn'}>
          {row.status === 'NEW' ? 'Nouvelle' : row.status === 'ERROR' ? 'Erreur' : 'Doublon'}
        </Badge>
      ),
    },
  ];

  const historyColumns: readonly Column<ImportHistoryDto>[] = [
    { key: 'date', header: 'Importé le', sort: (row) => row.importedAt, render: (row) => formatDate(row.importedAt) },
    { key: 'filename', header: 'Fichier', sort: (row) => row.filename, render: (row) => row.filename },
    { key: 'format', header: 'Format', render: (row) => <span className="muted small">{row.formatId ?? 'détection manuelle'}</span> },
    { key: 'created', header: 'Créés', align: 'right', sort: (row) => row.created, render: (row) => `${row.created}` },
    { key: 'skipped', header: 'Ignorés', align: 'right', sort: (row) => row.skipped, render: (row) => `${row.skipped}` },
    { key: 'errors', header: 'Erreurs', align: 'right', sort: (row) => row.errors, render: (row) => (row.errors === 0 ? '—' : <span className="tone-down">{row.errors}</span>) },
  ];

  return (
    <>
      <Card
        title="Importer un relevé"
        subtitle="CSV ou export d’agrégateur : le fichier est analysé avant toute écriture (doublons détectés par empreinte)."
      >
        <div className="filters">
          <label className="field">
            <span className="field-label">Compte cible</span>
            <select
              className="input"
              data-testid="import-account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">— choisir un compte —</option>
              {(accounts.data?.accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.providerId})
                </option>
              ))}
            </select>
          </label>
          <label className="field field-grow">
            <span className="field-label">Fichier de relevé</span>
            <input
              className="input"
              type="file"
              accept=".csv,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void onFile(file);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="import-dry-run"
            disabled={analysis === null || commit.pending || accountId === ''}
            onClick={() => submit(true)}
          >
            Simuler l’import
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="import-commit"
            disabled={analysis === null || commit.pending || accountId === ''}
            onClick={() => submit(false)}
          >
            Valider l’import
          </button>
        </div>
        <ActionFeedback state={analyze} />
        <ActionFeedback state={commit} />
        {accounts.data !== null && accounts.data.accounts.length === 0 && (
          <p className="muted small">
            Aucun compte disponible&nbsp;: créez une connexion puis synchronisez-la avant d’importer un relevé.
          </p>
        )}
        {filename !== null && <p className="muted small">Fichier sélectionné&nbsp;: {filename}</p>}

        {analysis !== null && (
          <>
            <div className="grid">
              <StatTile label="Lignes analysées" value={`${analysis.summary.parsed}`} hint={`Format détecté : ${analysis.detectedFormatLabel ?? 'inconnu'}`} />
              <StatTile label="Nouvelles écritures" value={`${analysis.summary.new}`} hint={`Score de détection ${analysis.detectionScore.toFixed(2)}`} />
              <StatTile label="Doublons ignorés" value={`${analysis.summary.duplicates}`} hint="Empreinte identique" />
              <StatTile label="Total des montants" value={formatEur(analysis.summary.totalAmount, 0)} hint={analysis.summary.currencies.join(' · ')} />
            </div>
            <p className="muted small">
              Colonnes détectées&nbsp;: {analysis.columns.join(', ')}
              {analysis.unmappedColumns.length > 0 ? ` — non associées : ${analysis.unmappedColumns.join(', ')}` : ''}
            </p>
            <DataTable rows={analysis.rows} columns={previewColumns} rowKey={(row) => `line-${row.line}`} maxRows={40} emptyTitle="Aucune ligne analysée" />
          </>
        )}
        {result !== null && (
          <p className="feedback feedback-ok" data-testid="import-outcome" role="status">
            {result.message}
          </p>
        )}
      </Card>

      <Card title="Historique des imports" subtitle="Traçabilité des fichiers déjà chargés." padded={false}>
        {history.loading && history.data === null ? (
          <div className="card-padded">
            <SkeletonTable rows={3} />
          </div>
        ) : (
          <DataTable
            rows={history.data ?? []}
            columns={historyColumns}
            rowKey={(row) => row.importId}
            initialSortKey="date"
            emptyTitle="Aucun import"
            emptyHint="Les fichiers importés apparaissent ici."
          />
        )}
      </Card>
    </>
  );
}
