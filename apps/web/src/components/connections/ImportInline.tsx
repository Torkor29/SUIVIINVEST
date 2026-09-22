import { useState } from 'react';
import type { ImportAnalyzeResponse, ImportCommitResponse } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { formatEur } from '../../lib/format.ts';
import { Badge } from '../ui/Stat.tsx';

export interface ImportInlineProps {
  readonly providerId: string;
  readonly connectionId: string | null;
  readonly onDone: () => void;
}

/**
 * Import d'un relevé depuis la fiche d'une source.
 *
 * Le fichier est analysé avant toute écriture : les doublons sont détectés par
 * empreinte et rien n'est enregistré tant que l'utilisateur n'a pas validé.
 */
export function ImportInline({ providerId, connectionId, onDone }: ImportInlineProps) {
  const [filename, setFilename] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalyzeResponse | null>(null);
  const analyze = useAction();
  const commit = useAction();

  const onFile = async (file: File): Promise<void> => {
    const text = await file.text();
    setFilename(file.name);
    setContent(text);
    setAnalysis(null);
    await analyze.run(async () => {
      const response = await request<ImportAnalyzeResponse>('/api/imports/analyze', {
        method: 'POST',
        json: {
          filename: file.name,
          content: text,
          ...(connectionId === null ? {} : { connectionId }),
        },
      });
      setAnalysis(response);
      return `${response.summary.parsed} lignes analysées — ${response.summary.new} nouvelles, ${response.summary.duplicates} doublons.`;
    });
  };

  const submit = (): void => {
    if (filename === null || content === null) return;
    void commit.run(async () => {
      const response = await request<ImportCommitResponse>('/api/imports/commit', {
        method: 'POST',
        json: {
          filename,
          content,
          ...(connectionId === null ? {} : { connectionId }),
        },
      });
      onDone();
      return response.message;
    });
  };

  return (
    <div className="conn-form" data-testid={`import-form-${providerId}`}>
      <label className="field">
        <span className="field-label">Fichier de relevé</span>
        <input
          className="input"
          type="file"
          accept=".csv,.txt,.json,.pdf"
          data-testid={`import-input-${providerId}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void onFile(file);
          }}
        />
      </label>
      <div className="card-actions-row">
        <button
          type="button"
          className="btn btn-primary"
          data-testid={`import-submit-${providerId}`}
          disabled={analysis === null || commit.pending}
          onClick={submit}
        >
          {commit.pending ? 'Import…' : 'Valider l’import'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Fermer
        </button>
      </div>
      <ActionFeedback state={analyze} />
      <ActionFeedback state={commit} />
      {analysis !== null && (
        <p className="muted small" data-testid={`import-summary-${providerId}`}>
          <Badge tone="info">{analysis.detectedFormatLabel ?? 'format non détecté'}</Badge>{' '}
          {analysis.summary.parsed} ligne(s) — {analysis.summary.new} nouvelle(s), {analysis.summary.duplicates}{' '}
          doublon(s), {analysis.summary.errors} erreur(s), total {formatEur(analysis.summary.totalAmount, 0)}
        </p>
      )}
    </div>
  );
}
