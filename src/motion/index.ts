/**
 * The motion engine — Cantor's morphing identity as a module.
 *
 *   Shapes + Verbs + one Clock (manim's architecture, on Skia):
 *   - LIBRARY: drawn primitives (music/math/figures) under one authoring contract
 *   - MorphShape: shape→shape morphs, retargetable mid-flight
 *   - MorphText: letter-matching text morphs drawn as glyphs on a canvas
 *   - geometry/transition: the math, for anything bespoke (the intro uses it raw)
 *
 * House grammar: linear master clock, smootherstep windows, staggered starts,
 * arcs over straight lines, nothing bouncy.
 */
export * from './geometry';
export * from './shapes';
export * from './transition';
export * from './text';
export { LIBRARY, CENTERLINES, type LibraryName } from './library';
export { useMorphFont } from './fonts';
export { MorphShape } from './MorphShape';
export { MorphText } from './MorphText';
