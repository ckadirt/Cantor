/**
 * The intro consumes its original ten canonical motion symbols directly.
 * SYMBOL_LIBRARY may keep growing without silently changing this constellation
 * or its exact 29-contour Cantor-bar morph contract.
 */
import {
  SYMBOL_LIBRARY,
  type SymbolName,
  type SymbolPrimitive,
} from '../motion';

export const CONSTELLATION_SYMBOL_NAMES = [
  'alephNull',
  'infinity',
  'cantorSet',
  'contourIntegral',
  'trebleClef',
  'segno',
  'fermata',
  'partial',
  'nabla',
  'continuum',
] as const satisfies readonly SymbolName[];

export type ConstellationSymbolName =
  (typeof CONSTELLATION_SYMBOL_NAMES)[number];

export type ConstellationSymbol = {
  key: ConstellationSymbolName;
  symbol: SymbolPrimitive;
};

export const CONSTELLATION_SYMBOLS: readonly ConstellationSymbol[] =
  CONSTELLATION_SYMBOL_NAMES.map(key => ({
    key,
    symbol: SYMBOL_LIBRARY[key],
  }));

/** The source Cantor mark has 29 independent bars before the direct morph. */
export const INTRO_CONTOUR_COUNT = 29;
