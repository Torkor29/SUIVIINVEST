/** Tests des mathématiques de graphiques (échelles, tracés, donuts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcPath,
  buildPoints,
  donutSegments,
  downsample,
  linearScale,
  linePath,
  areaPath,
  nearestIndex,
  niceCeil,
  niceTicks,
  polarToCartesian,
} from '../src/lib/chartMath.ts';

test('niceCeil arrondit sur un pas rond', () => {
  assert.equal(niceCeil(1.2), 2);
  assert.equal(niceCeil(7), 10);
  assert.equal(niceCeil(0.3), 0.5);
  assert.equal(niceCeil(0), 0);
});

test('niceTicks retourne des graduations croissantes', () => {
  const ticks = niceTicks(0, 100, 5);
  assert.ok(ticks.length >= 4);
  assert.equal(ticks[0], 0);
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok((ticks[index] ?? 0) > (ticks[index - 1] ?? 0));
  }
  assert.deepEqual(niceTicks(5, 5, 4), [5]);
});

test('linearScale projette le domaine sur la plage', () => {
  const scale = linearScale([0, 10], [0, 100]);
  assert.equal(scale(0), 0);
  assert.equal(scale(5), 50);
  assert.equal(scale(10), 100);
  assert.equal(linearScale([3, 3], [0, 100])(3), 50);
});

test('linePath et areaPath produisent des chemins SVG valides', () => {
  const points = buildPoints([1, 3, 2], { width: 100, height: 50 });
  assert.equal(points.length, 3);
  assert.ok(linePath(points).startsWith('M'));
  assert.ok(linePath([]) === '');
  assert.ok(areaPath(points, 50).endsWith('Z'));
});

test('polarToCartesian et arcPath dessinent les segments du donut', () => {
  // Angle 0° = midi : dans le repère SVG, le haut correspond à y négatif.
  const top = polarToCartesian(0, 0, 10, 0);
  assert.ok(Math.abs(top.x) < 1e-9);
  assert.ok(Math.abs(top.y + 10) < 1e-9);
  const right = polarToCartesian(0, 0, 10, 90);
  assert.ok(Math.abs(right.x - 10) < 1e-9);
  assert.ok(arcPath(50, 50, 40, 20, 0, 120).includes('A 40 40'));
});

test('donutSegments répartit les angles proportionnellement', () => {
  const segments = donutSegments([50, 30, 20], { cx: 100, cy: 100, radius: 90, innerRadius: 60 });
  assert.equal(segments.length, 3);
  const total = segments.reduce((sum, segment) => sum + segment.percent, 0);
  assert.ok(Math.abs(total - 100) < 0.001);
  assert.ok((segments[0]?.endAngle ?? 0) > (segments[0]?.startAngle ?? 0));
  assert.equal(donutSegments([0, 0], { cx: 0, cy: 0, radius: 10, innerRadius: 5 }).length, 0);
});

test('nearestIndex et downsample gardent la cohérence des séries', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 2 }];
  assert.equal(nearestIndex(points, 9), 1);
  assert.equal(nearestIndex([], 9), -1);

  const items = Array.from({ length: 1000 }, (_, index) => index);
  const sampled = downsample(items, 120);
  assert.ok(sampled.length <= 121);
  assert.equal(sampled[sampled.length - 1], 999);
  assert.equal(downsample([1, 2, 3], 10).length, 3);
});
