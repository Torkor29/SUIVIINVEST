import type { AllocationSlice } from '@suiviinvest/api-contract';
import { formatEur, formatPercent } from '../../lib/format.ts';
import { classColor, sliceColor } from '../charts/palette.ts';

export interface AllocationLegendProps {
  readonly slices: readonly AllocationSlice[];
  readonly colorByLabel?: boolean;
  readonly maxItems?: number;
  readonly showBars?: boolean;
}

/** Légende d'allocation : pastille, libellé, barre et valeur (EUR + %). */
export function AllocationLegend({ slices, colorByLabel = false, maxItems = 8, showBars = true }: AllocationLegendProps) {
  const visible = slices.slice(0, maxItems);
  if (slices.length === 0) return <p className="muted">Aucune répartition disponible.</p>;
  return (
    <ul className="alloc-list">
      {visible.map((slice, index) => {
        const color = colorByLabel ? classColor(slice.label) : sliceColor(index);
        return (
          <li key={slice.key} className={showBars ? 'alloc-item' : 'alloc-item no-bar'}>
            <span className="alloc-dot" style={{ background: color }} aria-hidden="true" />
            <span className="alloc-label">{slice.label}</span>
            {showBars && (
              <span className="alloc-bar" aria-hidden="true">
                <span className="alloc-bar-fill" style={{ width: `${Math.max(Math.min(slice.percent, 100), 0)}%`, background: color }} />
              </span>
            )}
            <span className="alloc-value">{formatEur(slice.value, 0)}</span>
            <span className="alloc-percent">{formatPercent(slice.percent, { sign: false, digits: 1 })}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Bandeau d'avertissement (devises non converties, cotations manquantes…). */
export function WarningsList({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="warnings">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

/** Rappel produit : cette application ne passe aucun ordre. */
export function ReadOnlyNote({ text = 'Application en lecture seule : aucun ordre, virement ni signature n’est possible.' }: { readonly text?: string }) {
  return (
    <p className="readonly-note">
      <span className="readonly-dot" aria-hidden="true" />
      {text}
    </p>
  );
}
