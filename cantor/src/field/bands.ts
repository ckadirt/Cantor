/**
 * KNOBS — scale windows are multiples of FIT. They match the behavioural
 * prototype so all representations crossfade instead of switching abruptly.
 */
export const REPRESENTATION_WINDOWS = {
  dot: [0, 0, 2, 3.8],
  row: [1.2, 3.6, 12, 29],
  song: [12, 27, 178, 378],
  grain: [178, 467, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
} as const;

/** Shelf labels stay visible longer than marks; this is not a representation. */
export const SHELF_LABEL_WINDOW = [0, 0, 5.5, 11] as const;

/**
 * Whether the field is nothing but marks at this distance.
 *
 * The handover between the two renderers has to be invisible, and it can only
 * be invisible where they draw the same thing. `NativeFieldContent` knows one
 * representation — a face at mark size — so the picture may only stand aside
 * for it once the row band has faded to nothing, which is `row`'s own entry
 * point rather than the `field`/`shelf` boundary at 2·FIT. At 2 a row is still
 * a quarter visible, and handing over there pops that quarter out.
 *
 * One predicate, used by the renderer to choose a path and by the camera to
 * decide whether a re-cut may skip React. If those two ever disagree, a re-cut
 * animates on the UI thread while the picture is recorded from React state that
 * is no longer being updated — so they share this rather than each testing a
 * level of their own.
 */
export function isMarksOnlyDistance(scale: number, fitScale: number): boolean {
  if (!(fitScale > 0) || !(scale > 0)) return false;
  return scale / fitScale < REPRESENTATION_WINDOWS.row[0];
}

export type RepresentationAlphas = Readonly<{
  dot: number;
  row: number;
  song: number;
  grain: number;
}>;

type ScaleWindow = readonly [number, number, number, number];

export function smootherstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Fade in, hold, then fade out across a scale window. */
export function windowAlpha(scale: number, window: ScaleWindow): number {
  const [enterStart, enterEnd, exitStart, exitEnd] = window;
  if (scale <= enterStart || scale >= exitEnd) return 0;
  if (scale < enterEnd) {
    return enterEnd === enterStart
      ? 1
      : smootherstep((scale - enterStart) / (enterEnd - enterStart));
  }
  if (scale <= exitStart) return 1;
  return exitEnd === exitStart
    ? 0
    : 1 - smootherstep((scale - exitStart) / (exitEnd - exitStart));
}

export function representationAlphas(
  scale: number,
  fitScale: number,
): RepresentationAlphas {
  return {
    dot: alphaAtFit(scale, fitScale, REPRESENTATION_WINDOWS.dot),
    row: alphaAtFit(scale, fitScale, REPRESENTATION_WINDOWS.row),
    song: alphaAtFit(scale, fitScale, REPRESENTATION_WINDOWS.song),
    grain: alphaAtFit(scale, fitScale, REPRESENTATION_WINDOWS.grain),
  };
}

export function shelfLabelAlpha(scale: number, fitScale: number): number {
  return alphaAtFit(scale, fitScale, SHELF_LABEL_WINDOW);
}

function alphaAtFit(
  scale: number,
  fitScale: number,
  window: ScaleWindow,
): number {
  const [enterStart, enterEnd, exitStart, exitEnd] = window;
  return windowAlpha(scale, [
    enterStart * fitScale,
    enterEnd * fitScale,
    exitStart * fitScale,
    exitEnd * fitScale,
  ]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
