import { cantorWaveLens } from './cantorWaveLens';
import { nameLens } from './nameLens';
import type { Lens } from './types';

/**
 * Every lens, in picker order.
 *
 * This array is the only list of lenses: the picker's labels and their order
 * come from here, so adding a lens is one import and one entry rather than a
 * change in three places.
 */
export const LENSES: readonly Lens[] = [nameLens, cantorWaveLens];

export const DEFAULT_LENS_KEY = nameLens.key;

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
