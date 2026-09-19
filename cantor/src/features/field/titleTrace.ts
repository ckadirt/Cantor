import { Skia, type SkFont, type SkPath } from '@shopify/react-native-skia';
import { layoutText, writePhase, writeSubAlpha } from '../../motion/text';

/** Batch a title's strokes without changing the per-glyph Write gesture. */
export function traceTitlePath(paths: readonly SkPath[], written: number): SkPath {
  'worklet';
  const result = Skia.Path.Make();
  for (let index = 0; index < paths.length; index++) {
    const end = writePhase(writeSubAlpha(written, index, paths.length)).borderEnd;
    if (end <= 0) continue;
    if (end >= 1) {
      result.addPath(paths[index]);
    } else {
      // trim mutates its receiver; the canonical outlines must survive reverse
      // playback and the next regrouping unchanged.
      const partial = paths[index].copy();
      partial.trim(0, end, false);
      result.addPath(partial);
      partial.dispose();
    }
  }
  return result;
}

const TRACE_CACHE_LIMIT = 512;
const traceCache = new Map<string, readonly SkPath[] | null>();

/**
 * A line of text as one exact outline per glyph, at the baseline it is drawn on.
 *
 * One path per letter and not one per line, because the pen is per letter:
 * `Write` is `DrawBorderThenFill` *with a lag ratio*, and a lag needs something
 * to lag between. It is also what makes the trace affordable — see the pen in
 * `NativePlacementFlight`.
 *
 * `layoutText` walks the string with the same advances `SkFont.measureText`
 * accumulates, which is what the `Text` node draws with, so the letter traced
 * at `x` and the letter that replaces it are the same ink in the same place —
 * the whole reason DrawBorderThenFill can hand over without a seam. Spaces
 * carry no box and so no pen stroke; Manim counts the same family.
 *
 * The answer is *checked* rather than trusted. Only native Skia implements
 * `Path.MakeFromText`; CanvasKit — which is what Jest runs — neither implements
 * it nor refuses, it answers with a stub that is not a path at all. Handing
 * that to a `Path` node is a blank title rather than an error, so anything
 * without a path's own method is treated as no outline, and the row falls back
 * to fading its glyphs in the way it did before it could write.
 *
 * An outline is a function of the recipe below and nothing else, so it is built
 * once and kept — the same bargain `fitText` and `nameLensFacePath` already
 * strike, and for the same reason. Without it every regrouping paid one
 * `MakeFromText` per letter per song, for titles that a re-cut at L0 does not
 * even bring into the row band. The refusals are cached too: on CanvasKit the
 * answer is null for every title, and re-deriving that would be the one case
 * where the cache bought nothing.
 */
export function titleTracePaths(
  text: string,
  typeface: SkFont,
  x: number,
  baselineY: number,
): readonly SkPath[] | null {
  if (text.length === 0) return null;
  // Keyed by size rather than by the font object: `useMorphFont` builds a fresh
  // `SkFont` per hook instance, so identity would miss on every mount, and the
  // row title has one face. This is `fitText`'s key with the pen's geometry
  // added, so a second call site drawing at another baseline cannot collide.
  const key = `${typeface.getSize()}:${x}:${baselineY}:${text}`;
  const cached = traceCache.get(key);
  if (cached !== undefined) return cached;
  const built = buildTitleTracePaths(text, typeface, x, baselineY);
  if (traceCache.size >= TRACE_CACHE_LIMIT) {
    const oldest = traceCache.keys().next().value;
    if (oldest !== undefined) traceCache.delete(oldest);
  }
  // Evicted without disposing, as `nameLensFacePath` evicts its faces: a path
  // that leaves this map may still be mounted in a `TracedTitle` that has not
  // been torn down, and disposing one out from under a live mapper is a crash
  // rather than a saving.
  traceCache.set(key, built);
  return built;
}

function buildTitleTracePaths(
  text: string,
  typeface: SkFont,
  x: number,
  baselineY: number,
): readonly SkPath[] | null {
  const paths: SkPath[] = [];
  // One line, always: the title is already cut to its column by `fitText`, so
  // there is nothing left for a wrap to do.
  for (const box of layoutText(text, typeface, 0, Infinity, 0)) {
    let path: SkPath | null;
    try {
      path = Skia.Path.MakeFromText(box.ch, x + box.x, baselineY, typeface);
    } catch {
      return null;
    }
    if (path == null || typeof path.toSVGString !== 'function') return null;
    paths.push(path);
  }
  return paths.length === 0 ? null : paths;
}
