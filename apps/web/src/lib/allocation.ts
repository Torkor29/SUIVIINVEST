/**
 * Calculs d'allocation (par classe d'actif, établissement, devise…).
 * Module pur, sans dépendance DOM.
 */
import type { AllocationSlice } from '@suiviinvest/api-contract';

export interface SliceInput {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** Pourcentage d'une part dans un total (0 si le total est nul). */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) return 0;
  return (part / total) * 100;
}

export function sliceTotal(slices: readonly AllocationSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.value, 0);
}

/** Construit des parts triées (décroissant) avec pourcentages recalculés. */
export function slicesFromValues(entries: readonly SliceInput[], total?: number): AllocationSlice[] {
  const computedTotal = total ?? entries.reduce((sum, entry) => sum + entry.value, 0);
  return entries
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: entry.value,
      percent: percentOf(entry.value, computedTotal),
    }))
    .sort((a, b) => b.value - a.value);
}

/** Fusionne les parts les plus petites dans un poste « Autres ». */
export function groupSmallSlices(
  slices: readonly AllocationSlice[],
  minPercent = 2,
  label = 'Autres',
): AllocationSlice[] {
  const kept: AllocationSlice[] = [];
  let restValue = 0;
  for (const slice of slices) {
    if (slice.percent < minPercent) restValue += slice.value;
    else kept.push(slice);
  }
  if (restValue <= 0) return [...kept].sort((a, b) => b.value - a.value);
  return slicesFromValues([
    ...kept.map((slice) => ({ key: slice.key, label: slice.label, value: slice.value })),
    { key: 'autres', label, value: restValue },
  ]);
}

/** N premières parts (le reste est ignoré — utilisé pour les légendes compactes). */
export function topSlices(slices: readonly AllocationSlice[], count: number): AllocationSlice[] {
  return [...slices].sort((a, b) => b.value - a.value).slice(0, Math.max(count, 0));
}

export function dominantSlice(slices: readonly AllocationSlice[]): AllocationSlice | null {
  return topSlices(slices, 1)[0] ?? null;
}

/** Concentration : part cumulée des trois premiers postes. */
export function concentration(slices: readonly AllocationSlice[]): number {
  return topSlices(slices, 3).reduce((sum, slice) => sum + slice.percent, 0);
}

/** Clé de couleur stable pour un poste d'allocation. */
export function sliceKeyOf(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
