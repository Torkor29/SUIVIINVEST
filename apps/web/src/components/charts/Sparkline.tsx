import { buildPoints, linePath, areaPath } from '../../lib/chartMath.ts';

export interface SparklineProps {
  readonly values: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly tone?: 'up' | 'down' | 'flat';
}

/** Mini-courbe sans axes, pour les tuiles et les lignes de tableau. */
export function Sparkline({ values, width = 96, height = 28, tone = 'up' }: SparklineProps) {
  if (values.length < 2) return null;
  const points = buildPoints(values, { width, height, paddingY: 4 });
  const stroke = tone === 'down' ? 'var(--neg)' : tone === 'flat' ? 'var(--muted)' : 'var(--pos)';
  return (
    <svg className="chart-svg sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" preserveAspectRatio="none">
      <path d={areaPath(points, height)} fill={stroke} opacity={0.12} />
      <path d={linePath(points)} fill="none" stroke={stroke} strokeWidth={1.6} />
    </svg>
  );
}
