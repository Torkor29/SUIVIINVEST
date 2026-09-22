/**
 * Provenance de l'historique du patrimoine.
 *
 * Une reconstitution calculée depuis les opérations n'est PAS une observation :
 * l'interface doit toujours dire d'où vient la courbe. Module pur (testable).
 */
import type { HistorySource } from '@suiviinvest/api-contract';
import { readableDate } from './connections.ts';

export interface HistoryProvenance {
  readonly label: string;
  readonly detail: string;
  readonly tone: 'neutral' | 'info' | 'warn' | 'ok';
  /** Faux quand la série est purement reconstruite : jamais présentée comme observée. */
  readonly observed: boolean;
}

const SOURCE_LABELS: Readonly<Record<HistorySource, string>> = {
  RECONSTRUCTED: 'Historique reconstruit',
  RECORDED: 'Relevés enregistrés',
  MIXED: 'Historique mixte',
};

/** Phrase explicite sur l'origine de la série affichée. */
export function describeHistorySource(
  source: HistorySource | null | undefined,
  recordedSince: string | null | undefined,
): HistoryProvenance {
  const since = recordedSince === null || recordedSince === undefined ? null : readableDate(recordedSince);
  switch (source) {
    case 'RECORDED':
      return {
        label: SOURCE_LABELS.RECORDED,
        detail:
          since === null
            ? 'Série issue des relevés quotidiens enregistrés par l’application.'
            : `Série issue des relevés quotidiens enregistrés par l’application depuis le ${since}.`,
        tone: 'ok',
        observed: true,
      };
    case 'MIXED':
      return {
        label: SOURCE_LABELS.MIXED,
        detail:
          since === null
            ? 'Partie ancienne reconstruite depuis vos opérations, partie récente issue des relevés enregistrés.'
            : `Relevés enregistrés depuis le ${since} ; avant cette date, historique reconstruit depuis vos opérations.`,
        tone: 'info',
        observed: true,
      };
    case 'RECONSTRUCTED':
      return {
        label: SOURCE_LABELS.RECONSTRUCTED,
        detail: 'Historique reconstruit depuis vos opérations et les cours : ce n’est pas un relevé observé.',
        tone: 'warn',
        observed: false,
      };
    default:
      return {
        label: 'Origine inconnue',
        detail: 'La provenance de cette série n’est pas indiquée par le serveur.',
        tone: 'neutral',
        observed: false,
      };
  }
}
