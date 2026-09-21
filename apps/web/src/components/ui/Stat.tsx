import type { ReactNode } from 'react';
import { formatPercent, formatSignedEur, toneOf, type Tone } from '../../lib/format.ts';
import type { VariationDto } from '@suiviinvest/api-contract';

export interface StatTileProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly delta?: VariationDto;
  readonly deltaLabel?: string;
  readonly tone?: Tone;
  readonly children?: ReactNode;
}

/** Tuile de chiffre clé : valeur, variation colorée et légende. */
export function StatTile({ label, value, hint, delta, deltaLabel, tone, children }: StatTileProps) {
  const effectiveTone = tone ?? (delta === undefined ? 'flat' : toneOf(delta.absolute));
  return (
    <div className="card tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {delta !== undefined && (
        <span className={`tile-delta tone-${effectiveTone}`}>
          <strong>{formatSignedEur(delta.absolute, 0)}</strong>
          <span className="tile-delta-pct">{formatPercent(delta.percent)}</span>
          {deltaLabel !== undefined && <span className="tile-delta-label">{deltaLabel}</span>}
        </span>
      )}
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
      {children}
    </div>
  );
}

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
  readonly title?: string;
}

export function Badge({ children, tone = 'neutral', title }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Badge de statut pour les connexions et les synchronisations. */
export function StatusBadge({ status }: { readonly status: string }) {
  const mapping: Readonly<Record<string, { tone: BadgeProps['tone']; label: string }>> = {
    OK: { tone: 'ok', label: 'Synchronisé' },
    SUCCESS: { tone: 'ok', label: 'Réussi' },
    RUNNING: { tone: 'info', label: 'En cours' },
    PARTIAL: { tone: 'warn', label: 'Partiel' },
    AUTH_REQUIRED: { tone: 'danger', label: 'Réauthentification' },
    FAILED: { tone: 'danger', label: 'Échec' },
    IMPORT_ONLY: { tone: 'neutral', label: 'Import uniquement' },
  };
  const found = mapping[status] ?? { tone: 'neutral' as const, label: status };
  return <Badge tone={found.tone}>{found.label}</Badge>;
}

/** Ligne clé/valeur compacte (fiches immobilier, paramètres, santé). */
export function KeyValue({ label, value, tone }: { readonly label: string; readonly value: ReactNode; readonly tone?: Tone }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={`kv-value ${tone === undefined ? '' : `tone-${tone}`}`.trim()}>{value}</span>
    </div>
  );
}

/** Barre de progression utilisée par les légendes d'allocation. */
export function AllocationBar({ percent, color }: { readonly percent: number; readonly color: string }) {
  return (
    <span className="alloc-bar" aria-hidden="true">
      <span className="alloc-bar-fill" style={{ width: `${Math.max(Math.min(percent, 100), 0)}%`, background: color }} />
    </span>
  );
}
