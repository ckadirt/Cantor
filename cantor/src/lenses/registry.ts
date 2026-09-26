import { nameLens } from './nameLens';
import { sealLens } from './sealLens';
import type { LensUi } from './contract';
import type { Lens } from './types';

/**
 * Every lens, in picker order.
 *
 * This array is the only list of lenses: the picker's labels and their order
 * come from here, so adding a lens is one import and one entry rather than a
 * change in three places.
 */
export const LENSES: readonly Lens[] = [nameLens, sealLens];

export const DEFAULT_LENS_KEY = nameLens.key;

/**
 * Every lens's UI-thread half, in `LENSES` order — the only part of a lens a
 * worklet may capture (see `contract.ts`). A lens's index here is its index
 * in a face's `identities`.
 */
export const LENS_UI: readonly LensUi[] = LENSES.map(lens => lens.ui);

/** Where a lens stands in `LENSES`, or -1. */
export function lensIndex(key: string): number {
  return LENSES.findIndex(lens => lens.key === key);
}

// Keys address a lens in the picker and in saved state, so a duplicate would
// make one of them unreachable. Caught at module load rather than at the call
// site that silently got the wrong one.
const seen = new Set<string>();
for (const lens of LENSES) {
  if (seen.has(lens.key)) {
    throw new Error(`Duplicate lens key: ${lens.key}`);
  }
  seen.add(lens.key);
}

export function lensByKey(key: string): Lens | null {
  return LENSES.find(lens => lens.key === key) ?? null;
}
