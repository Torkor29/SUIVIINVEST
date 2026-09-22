import type { SyncAllResponse } from '@suiviinvest/api-contract';
import { Badge, KeyValue } from '../ui/Stat.tsx';
import { Card } from '../ui/Card.tsx';
import {
  aggregateSyncAll,
  describeSyncOutcome,
  syncAllHeadline,
  syncErrorHeadline,
  syncOutcomeLabel,
  syncOutcomeTone,
} from '../../lib/connections.ts';

export interface SyncAllSummaryProps {
  readonly response: SyncAllResponse;
  /** Nom d'affichage par identifiant de fournisseur (repli : identifiant brut). */
  readonly providerNames: Readonly<Record<string, string>>;
  readonly onClose?: () => void;
}

/**
 * Résumé d'une synchronisation globale.
 *
 * Chaque source est listée indépendamment : une panne d'un fournisseur
 * n'empêche jamais les autres de répondre, et le résumé le montre tel quel.
 */
export function SyncAllSummary({ response, providerNames, onClose }: SyncAllSummaryProps) {
  const summary = aggregateSyncAll(response);
  const name = (providerId: string): string => providerNames[providerId] ?? providerId;

  return (
    <Card
      title="Synchronisation globale"
      subtitle={syncAllHeadline(summary)}
      actions={
        onClose === undefined ? undefined : (
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Masquer
          </button>
        )
      }
    >
      <div data-testid="sync-all-summary">
        <ul className="sync-all-list">
          {response.results.map((result) => (
            <li key={result.syncRunId} className="sync-all-row" data-testid={`sync-all-row-${result.providerId}`}>
              <span className="sync-all-source">
                <strong>{name(result.providerId)}</strong>
                <small className="cell-sub">{describeSyncOutcome(result)}</small>
              </span>
              <Badge tone={syncOutcomeTone(result.status)}>{syncOutcomeLabel(result.status)}</Badge>
              {result.status !== 'SUCCESS' && (
                <span className="muted small">{syncErrorHeadline(result.errorCode, result.message)}</span>
              )}
              {result.warnings.length > 0 && (
                <details className="tech-details">
                  <summary>{result.warnings.length} avertissement(s) non bloquant(s)</summary>
                  <ul className="warnings">
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>

        <div className="kv-grid" data-testid="sync-all-totals">
          <KeyValue label="Sources traitées" value={`${summary.total}`} />
          <KeyValue label="Réussies" value={`${summary.succeeded}`} />
          <KeyValue label="Partielles" value={`${summary.partial}`} />
          <KeyValue label="Validation requise" value={`${summary.authRequired}`} />
          <KeyValue label="Échecs" value={`${summary.failed}`} />
          <KeyValue label="Transactions récupérées" value={`${summary.created}`} />
          <KeyValue label="Positions mises à jour" value={`${summary.updated}`} />
        </div>

        {summary.hasFailure && (
          <p className="feedback feedback-warn" data-testid="sync-all-isolation">
            Une source en échec n’interrompt pas les autres : chaque fournisseur est sollicité indépendamment.
          </p>
        )}
      </div>
    </Card>
  );
}
