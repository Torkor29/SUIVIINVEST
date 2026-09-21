import type { PeriodKey } from '@suiviinvest/api-contract';
import { PERIOD_KEYS, PERIOD_LABELS, PERIOD_SHORT_LABELS } from '../../lib/period.ts';

export interface PeriodSelectorProps {
  readonly value: PeriodKey;
  readonly onChange: (period: PeriodKey) => void;
  readonly keys?: readonly PeriodKey[];
  readonly compact?: boolean;
}

/** Sélecteur de période (1 J → MAX) : boutons segmentés, accessibles au clavier. */
export function PeriodSelector({ value, onChange, keys = PERIOD_KEYS, compact = false }: PeriodSelectorProps) {
  return (
    <div className="segmented" role="group" aria-label="Période affichée">
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          className={key === value ? 'segmented-btn is-active' : 'segmented-btn'}
          aria-pressed={key === value}
          title={PERIOD_LABELS[key]}
          onClick={() => onChange(key)}
        >
          {compact ? PERIOD_SHORT_LABELS[key] : key}
        </button>
      ))}
    </div>
  );
}
