/**
 * The intro consumes the canonical motion symbols directly. No onboarding-only
 * geometry lives here: improving a primitive improves the constellation and
 * every other place that uses AnimatedSymbol / MorphShape.
 */
import {
  SYMBOL_LIBRARY,
  type SymbolName,
  type SymbolPrimitive,
} from '../motion';

export type ConstellationSymbol = {
  key: SymbolName;
  symbol: SymbolPrimitive;
};

export const CONSTELLATION_SYMBOLS: readonly ConstellationSymbol[] = (
  Object.keys(SYMBOL_LIBRARY) as SymbolName[]
).map(key => ({ key, symbol: SYMBOL_LIBRARY[key] }));

/** The source Cantor mark has 29 independent bars before the direct morph. */
export const INTRO_CONTOUR_COUNT = 29;
