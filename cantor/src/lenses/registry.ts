import { nameLens } from './nameLens';
import type { Lens } from './types';

/** The registry is deliberately small in M2; M5 proves it with a second lens. */
export const LENSES: readonly Lens[] = [nameLens];

export function lensByKey(key: string): Lens | null {
  return LENSES.find(lens => lens.key === key) ?? null;
}
