/**
 * The motion engine — Cantor's morphing identity as a module.
 *
 *   Shapes + Verbs + one Clock (manim's architecture, on Skia):
 *   - LIBRARY: drawn primitives (music/math/figures) under one authoring contract
 *   - MorphShape: shape→shape morphs, retargetable mid-flight
 *   - MorphText: shared text-motion engine with transform/matching/crossfade
 *   - WriteText/TransformText/MatchingText: explicit reusable text primitives
 *   - geometry/transition: the math, for anything bespoke (the intro uses it raw)
 *
 * House grammar: linear master clock, smootherstep windows, staggered starts,
 * arcs over straight lines, nothing bouncy.
 */
export * from './geometry';
export * from './shapes';
export * from './silhouette';
export * from './transition';
export * from './text';
export { LIBRARY, CENTERLINES, type LibraryName } from './library';
export {
  SYMBOL_LIBRARY,
  type SymbolName,
  type SymbolPrimitive,
} from './symbolLibrary';
export { useMorphFont } from './fonts';
export {
  MorphShape,
  type MorphShapeProps,
  type ShapeAppearance,
} from './MorphShape';
export {
  AnimatedSymbol,
  WriteSymbol,
  type AnimatedSymbolProps,
  type WriteSymbolProps,
} from './AnimatedSymbol';
export {
  CanonicalSymbol,
  SymbolArtworkPath,
  type CanonicalSymbolProps,
  type SymbolArtworkPathProps,
} from './CanonicalSymbol';
export {
  CrossfadeText,
  MatchingText,
  MorphText,
  MorphTextSequence,
  TransformText,
  WriteText,
  type MorphTextProps,
  type MorphTextSequenceItem,
  type MorphTextSequenceProps,
} from './MorphText';
