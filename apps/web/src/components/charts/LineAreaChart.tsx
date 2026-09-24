import { useId, useMemo, useState, type MouseEvent } from 'react';
import type { SeriesPoint } from '@suiviinvest/api-contract';
import { buildPoints, downsample, linePath, areaPath, niceTicks, nearestIndex } from '../../lib/chartMath.ts';
import { formatCompactEur, formatEur, formatPointDate } from '../../lib/format.ts';

export interface LineAreaChartProps {
  readonly points: readonly SeriesPoint[];
  readonly height?: number;
  /** Nombre maximum de points dessinés (échantillonnage automatique). */
  readonly maxPoints?: number;
  readonly ariaLabel?: string;
  /** Couleur de la courbe : hausse (vert), baisse (rouge) ou neutre. */
  readonly tone?: 'up' | 'down' | 'flat';
  /** Sans graduations ni libellés d'axe (courbe « héros » du tableau de bord). */
  readonly minimal?: boolean;
  /**
   * Seconde courbe, en pointillés, alignée point par point sur `points`
   * (ex. montant investi sous la valeur du portefeuille).
   */
  readonly secondary?: readonly SeriesPoint[];
  readonly primaryLabel?: string;
  readonly secondaryLabel?: string;
  /** Format des valeurs (axe et infobulle) ; euros par défaut. */
  readonly format?: (value: number) => string;
  readonly axisFormat?: (value: number) => string;
}

const WIDTH = 720;

/**
 * Courbe d'évolution du patrimoine : aire + ligne, graduations et infobulle au survol.
 * Tout est dessiné à la main en SVG (aucune librairie de graphiques).
 */
export function LineAreaChart({
  points,
  height = 260,
  maxPoints = 320,
  ariaLabel = 'Évolution du patrimoine',
  tone = 'flat',
  minimal = false,
  secondary,
  primaryLabel,
  secondaryLabel,
  format = formatEur,
  axisFormat = formatCompactEur,
}: LineAreaChartProps) {
  const gradientId = useId();
  const [hover, setHover] = useState<number>(-1);
  const aligned = secondary !== undefined && secondary.length === points.length;
  const sampledIndexes = useMemo(
    () => downsample(points.map((_, index) => index), maxPoints),
    [points, maxPoints],
  );
  const sampled = useMemo(() => sampledIndexes.map((index) => points[index] as SeriesPoint), [sampledIndexes, points]);
  const sampledSecondary = useMemo(
    () => (aligned ? sampledIndexes.map((index) => (secondary as readonly SeriesPoint[])[index] as SeriesPoint) : []),
    [aligned, sampledIndexes, secondary],
  );
  const values = useMemo(() => sampled.map((point) => point.total), [sampled]);
  const secondaryValues = useMemo(() => sampledSecondary.map((point) => point.total), [sampledSecondary]);

  const geometry = useMemo(() => {
    if (values.length === 0) return null;
    const all = secondaryValues.length > 0 ? [...values, ...secondaryValues] : values;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const spread = max - min || Math.max(max * 0.02, 1);
    const low = min - spread * 0.08;
    const high = max + spread * 0.08;
    const ticks = niceTicks(low, high, 5);
    const plot = buildPoints(values, { width: WIDTH, height, paddingX: 8, paddingY: 18, min: low, max: high });
    const secondaryPlot =
      secondaryValues.length > 0
        ? buildPoints(secondaryValues, { width: WIDTH, height, paddingX: 8, paddingY: 18, min: low, max: high })
        : [];
    const tickValues = ticks.filter((tick) => tick >= low && tick <= high);
    const tickPoints = tickValues.map((tick) => ({ value: tick, y: buildPoints([tick], { width: WIDTH, height, paddingY: 18, min: low, max: high })[0]?.y ?? 0 }));
    return { plot, secondaryPlot, tickPoints, low, high };
  }, [values, secondaryValues, height]);

  if (geometry === null || sampled.length === 0) {
    return <div className="chart-empty">Aucune donnée sur la période sélectionnée.</div>;
  }

  const { plot, secondaryPlot, tickPoints } = geometry;
  const activeSecondary = hover >= 0 && hover < sampledSecondary.length ? sampledSecondary[hover] : undefined;
  const active = hover >= 0 && hover < plot.length ? plot[hover] : undefined;
  const activePoint = hover >= 0 && hover < sampled.length ? sampled[hover] : undefined;
  const baseline = height - 1;

  const handleMove = (event: MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width;
    setHover(nearestIndex(plot, ratio * WIDTH));
  };

  return (
    <div className={`chart-line is-${tone}`}>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(-1)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chart-fill-top" />
            <stop offset="100%" className="chart-fill-bottom" />
          </linearGradient>
        </defs>
        {!minimal && tickPoints.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid" x1={0} x2={WIDTH} y1={tick.y} y2={tick.y} />
            <text className="chart-axis-label" x={WIDTH - 2} y={tick.y - 4} textAnchor="end">
              {axisFormat(tick.value)}
            </text>
          </g>
        ))}
        <path className="chart-area" d={areaPath(plot, baseline)} fill={`url(#${gradientId})`} />
        <path className="chart-line-path" d={linePath(plot)} fill="none" />
        {secondaryPlot.length > 1 && (
          <path className="chart-line-secondary" d={linePath(secondaryPlot)} fill="none" />
        )}
        {active !== undefined && (
          <g>
            <line className="chart-cursor" x1={active.x} x2={active.x} y1={0} y2={baseline} />
            <circle className="chart-dot" cx={active.x} cy={active.y} r={4} />
          </g>
        )}
      </svg>
      <div className="chart-xaxis">
        {sampled.length > 1 && (
          <>
            <span>{formatPointDate(sampled[0]?.date ?? null)}</span>
            <span>{formatPointDate(sampled[Math.floor(sampled.length / 2)]?.date ?? null)}</span>
            <span>{formatPointDate(sampled[sampled.length - 1]?.date ?? null)}</span>
          </>
        )}
      </div>
      {activePoint !== undefined && (
        <div className="chart-tooltip">
          <span className="chart-tooltip-date">{formatPointDate(activePoint.date, 'long')}</span>
          {activeSecondary !== undefined ? (
            <>
              <span className="chart-tooltip-row">
                <span>{primaryLabel ?? 'Valeur'}</span>
                <strong>{format(activePoint.total)}</strong>
              </span>
              <span className="chart-tooltip-row is-secondary">
                <span>{secondaryLabel ?? 'Référence'}</span>
                <strong>{format(activeSecondary.total)}</strong>
              </span>
            </>
          ) : (
            <strong>{format(activePoint.total)}</strong>
          )}
        </div>
      )}
    </div>
  );
}
