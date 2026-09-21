/**
 * Mathématiques des graphiques SVG faits main (échelles, tracés, arcs).
 * Module pur, sans dépendance DOM — testé directement.
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Arrondit vers le haut sur un pas « rond » (1, 2, 5 × 10^n). */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const exponent = Math.floor(Math.log10(abs));
  const magnitude = Math.pow(10, exponent);
  const normalized = abs / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return sign * step * magnitude;
}

/** Graduations régulières couvrant [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (count < 2) count = 2;
  if (min === max) return [min];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const rawStep = (hi - lo) / (count - 1);
  const step = niceCeil(rawStep);
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= hi + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)).valueOf() === 0 ? 0 : Number(value.toFixed(10)));
  }
  return ticks;
}

/** Échelle linéaire domain -> range (retourne le centre du range si le domain est plat). */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) {
    const middle = (r0 + r1) / 2;
    return () => middle;
  }
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Chemin SVG d'une polyligne. */
export function linePath(points: readonly Pt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const only = points[0];
    return only === undefined ? '' : `M ${round(only.x)} ${round(only.y)}`;
  }
  let path = '';
  let previous: Pt | undefined;
  for (const point of points) {
    if (previous === undefined) {
      path += `M ${round(point.x)} ${round(point.y)}`;
    } else {
      const cx = (previous.x + point.x) / 2;
      path += ` C ${round(cx)} ${round(previous.y)} ${round(cx)} ${round(point.y)} ${round(point.x)} ${round(point.y)}`;
    }
    previous = point;
  }
  return path;
}

/** Chemin SVG fermé (aire sous la courbe jusqu'à `baseY`). */
export function areaPath(points: readonly Pt[], baseY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return '';
  return `${linePath(points)} L ${round(last.x)} ${round(baseY)} L ${round(first.x)} ${round(baseY)} Z`;
}

/** Coordonnées cartésiennes d'un angle (0° = 12 h, sens horaire). */
export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): Pt {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/** Arc SVG entre deux angles (portion d'anneau pour camembert / donut). */
export function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const safeEnd = Math.min(endAngle, startAngle + 359.999);
  const largeArc = safeEnd - startAngle > 180 ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, safeEnd);
  if (innerRadius <= 0) {
    return `M ${round(cx)} ${round(cy)} L ${round(outerStart.x)} ${round(outerStart.y)} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${round(outerEnd.x)} ${round(outerEnd.y)} Z`;
  }
  const innerEnd = polarToCartesian(cx, cy, innerRadius, safeEnd);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  return [
    `M ${round(outerStart.x)} ${round(outerStart.y)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${round(outerEnd.x)} ${round(outerEnd.y)}`,
    `L ${round(innerEnd.x)} ${round(innerEnd.y)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${round(innerStart.x)} ${round(innerStart.y)}`,
    'Z',
  ].join(' ');
}

export interface DonutSegment {
  readonly index: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly percent: number;
  readonly path: string;
}

/** Découpe un donut en segments proportionnels (angles en degrés). */
export function donutSegments(
  values: readonly number[],
  options: { cx: number; cy: number; radius: number; innerRadius: number; gapDeg?: number },
): DonutSegment[] {
  const { cx, cy, radius, innerRadius } = options;
  const gap = options.gapDeg ?? 1.2;
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (total <= 0) return [];
  const segments: DonutSegment[] = [];
  let cursor = 0;
  values.forEach((value, index) => {
    const percent = (Math.max(value, 0) / total) * 100;
    const sweep = (percent / 100) * 360;
    const start = cursor + gap / 2;
    const end = cursor + sweep - gap / 2;
    segments.push({
      index,
      startAngle: start,
      endAngle: Math.max(end, start + 0.01),
      percent,
      path: arcPath(cx, cy, radius, innerRadius, start, Math.max(end, start + 0.01)),
    });
    cursor += sweep;
  });
  return segments;
}

/** Index du point le plus proche d'une abscisse (survol des courbes). */
export function nearestIndex(points: readonly Pt[], x: number): number {
  if (points.length === 0) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const distance = Math.abs(point.x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Réduit une série à `maxPoints` points (échantillonnage régulier, dernier conservé). */
export function downsample<T>(items: readonly T[], maxPoints: number): readonly T[] {
  if (maxPoints <= 0 || items.length <= maxPoints) return items;
  const stride = items.length / maxPoints;
  const sampled: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const source = items[Math.min(Math.floor(index * stride), items.length - 1)];
    if (source !== undefined) sampled.push(source);
  }
  const last = items[items.length - 1];
  if (last !== undefined && sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

/** Projette une série de valeurs dans une zone de dessin. */
export function buildPoints(
  values: readonly number[],
  options: { width: number; height: number; paddingX?: number; paddingY?: number; min?: number; max?: number },
): Pt[] {
  const paddingX = options.paddingX ?? 0;
  const paddingY = options.paddingY ?? 0;
  if (values.length === 0) return [];
  const min = options.min ?? Math.min(...values);
  const max = options.max ?? Math.max(...values);
  const innerWidth = Math.max(options.width - paddingX * 2, 1);
  const innerHeight = Math.max(options.height - paddingY * 2, 1);
  const scaleX = linearScale([0, Math.max(values.length - 1, 1)], [paddingX, paddingX + innerWidth]);
  const scaleY = linearScale([min, max === min ? min + 1 : max], [paddingY + innerHeight, paddingY]);
  return values.map((value, index) => ({ x: scaleX(index), y: scaleY(value) }));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
