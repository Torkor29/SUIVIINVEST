import { useState } from 'react';
import { formatCompactEur, formatMonthLabel } from '../../lib/format.ts';
import { NEGATIVE_COLOR, POSITIVE_COLOR } from './palette.ts';

export interface BarChartItem {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'positive' | 'negative' | 'neutral';
}

export interface BarChartProps {
  /** Libellés passés à `formatMonthLabel` si `months` est vrai. */
  readonly items: readonly BarChartItem[];
  readonly height?: number;
  readonly months?: boolean;
  readonly ariaLabel?: string;
  readonly valueFormatter?: (value: number) => string;
}

/** Barres verticales (flux mensuels) dessinées en SVG, positives et négatives. */
export function BarChart({ items, height = 200, months = false, ariaLabel = 'Flux mensuels', valueFormatter = formatCompactEur }: BarChartProps) {
  const [hover, setHover] = useState<number>(-1);
  if (items.length === 0) return <div className="chart-empty">Aucun flux à afficher.</div>;

  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  const slot = 100 / items.length;
  const barWidth = Math.min(slot * 0.62, 9);
  const zeroY = height / 2;
  const scale = (height / 2 - 14) / max;

  return (
    <div className="chart-bar-wrap">
      {hover >= 0 && items[hover] !== undefined && (
        <div className="chart-tooltip chart-tooltip-bar">
          <span className="chart-tooltip-date">{months ? formatMonthLabel(items[hover]?.label ?? '') : items[hover]?.label}</span>
          <strong>{valueFormatter(items[hover]?.value ?? 0)}</strong>
        </div>
      )}
      <svg className="chart-svg" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <line className="chart-grid" x1={0} x2={100} y1={zeroY} y2={zeroY} />
        {items.map((item, index) => {
          const barHeight = Math.max(Math.abs(item.value) * scale, 1);
          const y = item.value < 0 ? zeroY : zeroY - barHeight;
          const color = item.tone === 'negative' ? NEGATIVE_COLOR : item.tone === 'positive' ? POSITIVE_COLOR : item.value < 0 ? NEGATIVE_COLOR : POSITIVE_COLOR;
          return (
            <rect
              key={`${item.label}-${index}`}
              x={index * slot + (slot - barWidth) / 2}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={1}
              fill={color}
              className={hover === index ? 'bar is-active' : 'bar'}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(-1)}
            />
          );
        })}
      </svg>
      {months && (
        <div className="chart-xaxis chart-xaxis-bar">
          <span>{formatMonthLabel(items[0]?.label ?? '')}</span>
          <span>{formatMonthLabel(items[Math.floor(items.length / 2)]?.label ?? '')}</span>
          <span>{formatMonthLabel(items[items.length - 1]?.label ?? '')}</span>
        </div>
      )}
    </div>
  );
}
