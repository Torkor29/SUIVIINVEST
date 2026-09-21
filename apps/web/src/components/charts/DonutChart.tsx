import { useState } from 'react';
import type { AllocationSlice } from '@suiviinvest/api-contract';
import { donutSegments } from '../../lib/chartMath.ts';
import { formatEur, formatPercent } from '../../lib/format.ts';
import { classColor, sliceColor } from './palette.ts';

export interface DonutChartProps {
  readonly slices: readonly AllocationSlice[];
  readonly size?: number;
  readonly thickness?: number;
  readonly centerLabel?: string;
  readonly centerValue?: string;
  /** Couleur fixe par libellé (grandes classes d'actif). */
  readonly colorByLabel?: boolean;
}

/**
 * Donut d'allocation dessiné en SVG : segments proportionnels, infobulle
 * au survol et valeur centrale. Les valeurs négatives (dettes) sont exclues.
 */
export function DonutChart({ slices, size = 200, thickness = 26, centerLabel = 'Total', centerValue, colorByLabel = false }: DonutChartProps) {
  const [hover, setHover] = useState<number>(-1);
  const positives = slices.filter((slice) => slice.value > 0);
  const total = positives.reduce((sum, slice) => sum + slice.value, 0);
  const radius = size / 2 - 2;
  const innerRadius = Math.max(radius - thickness, 4);
  const segments = donutSegments(positives.map((slice) => slice.value), { cx: size / 2, cy: size / 2, radius, innerRadius, gapDeg: 1.6 });
  const hovered = hover >= 0 ? positives[hover] : undefined;

  if (positives.length === 0 || total === 0) {
    return <div className="chart-empty">Aucune répartition disponible.</div>;
  }

  return (
    <div className="chart-donut">
      <svg className="chart-svg" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Répartition de l’allocation" width={size} height={size}>
        {segments.map((segment) => {
          const slice = positives[segment.index];
          const color = slice === undefined ? '#94a3b8' : colorByLabel ? classColor(slice.label) : sliceColor(segment.index);
          return (
            <path
              key={segment.index}
              d={segment.path}
              fill={color}
              className={hover === segment.index ? 'donut-segment is-active' : 'donut-segment'}
              onMouseEnter={() => setHover(segment.index)}
              onMouseLeave={() => setHover(-1)}
            />
          );
        })}
        <text className="donut-center-label" x={size / 2} y={size / 2 - 6} textAnchor="middle">
          {hovered === undefined ? centerLabel : hovered.label}
        </text>
        <text className="donut-center-value" x={size / 2} y={size / 2 + 16} textAnchor="middle">
          {hovered === undefined ? centerValue ?? formatEur(total, 0) : formatPercent(hovered.percent, { sign: false, digits: 1 })}
        </text>
      </svg>
    </div>
  );
}
