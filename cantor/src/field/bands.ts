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

/**
 * The cluster's own name on the canvas. Not a representation: a label is what
 * the field calls a group, not what a song looks like from here.
 *
 * It leaves on the dot band's exit, because it is the same hand-over said
 * twice. Crossing `LEVEL_BOUNDARIES.field` the dot becomes a row and the
 * *header* becomes the group's name — it reads the seat the camera is nearest
 * from that point on — so a label that outlived the boundary was the shelf's
 * title written twice on one screen, once in mono over the list and once in
 * the header directly above it. Below the boundary nothing has taken the name
 * yet, which is why the fade starts there and not before.
 */
export const SHELF_LABEL_WINDOW = [0, 0, 2, 3.8] as const;

/**
 * Whether the native renderer knows everything the field shows here.
 *
 * The handover between the two renderers has to be invisible, and it can only
 * be invisible where they draw the same thing. `NativeFieldContent` knows two
 * representations — a face at mark size and a row — which is L0 and L1, so it
 * may own the field right up to the point where the *player* opens. That is
 * `song`'s own entry rather than a level boundary: at `song[0]` the player is
 * still drawing nothing, and one step further it is a fifth of the screen.
 *
 * Why the native path has to reach this far rather than stopping at the row
 * band: a recorded picture moves by being *scaled*, and everything a row is
 * measured in — a 240×30 box, a 15 px title, a 9 px meta line — is measured in
 * screen pixels. Scaling the recording inflates all of it. That is invisible
 * under a pan, where the scale factor is exactly 1, and it is the whole of what
 * a zoom looks like: the recording can only be remade once per React commit,
 * the camera covers a lot of scale in between, and every row on screen swells
 * and snaps back. Only the UI thread can redraw a row at the size it is
 * supposed to be on the frame it is supposed to be that size.
 *
 * One predicate, used by the renderer to choose a path and by the camera to
 * decide whether a re-cut may skip React. If those two ever disagree, a re-cut
 * animates on the UI thread while the picture is recorded from React state that
 * is no longer being updated — so they share this rather than each testing a
 * level of their own.
 */
export function isNativeDrawnDistance(scale: number, fitScale: number): boolean {
  'worklet';
  if (!(fitScale > 0) || !(scale > 0)) return false;
  return scale / fitScale < REPRESENTATION_WINDOWS.song[0];
}

export type RepresentationAlphas = Readonly<{
  dot: number;
  row: number;
  song: number;
  grain: number;
}>;

export type ScaleWindow = readonly [number, number, number, number];

/*
 * Everything below is a worklet, and the order it is written in is load-bearing.
 *
 * The native renderer draws L0 and L1 from the UI thread, so it needs the bands
 * on the UI thread — and it has to be *these* bands rather than a copy, or the
 * two renderers would disagree about where a row begins the moment either knob
 * moved. The worklets plugin captures a `'worklet'` helper into its caller's
 * closure where the *caller* is defined, so a helper written below its caller
 * arrives as `undefined` at run time. Hence `clamp` before `smootherstep`, and
 * `bandAlphaAt` before the three functions that call it.
 */

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

export function smootherstep(value: number): number {
  'worklet';
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Fade in, hold, then fade out across a scale window. */
export function windowAlpha(scale: number, window: ScaleWindow): number {
  'worklet';
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

/**
 * One band's alpha at a camera scale, given the fit it is measured against.
 *
 * Exported so the native renderer can ask for a single band on the UI thread.
 * `representationAlphas` answers for all four and allocates an object to do
 * it, which is the wrong shape for a worklet that runs once per placement per
 * frame.
 */
export function bandAlphaAt(
  scale: number,
  fitScale: number,
  window: ScaleWindow,
): number {
  'worklet';
  const [enterStart, enterEnd, exitStart, exitEnd] = window;
  return windowAlpha(scale, [
    enterStart * fitScale,
    enterEnd * fitScale,
    exitStart * fitScale,
    exitEnd * fitScale,
  ]);
}

export function representationAlphas(
  scale: number,
  fitScale: number,
): RepresentationAlphas {
  'worklet';
  return {
    dot: bandAlphaAt(scale, fitScale, REPRESENTATION_WINDOWS.dot),
    row: bandAlphaAt(scale, fitScale, REPRESENTATION_WINDOWS.row),
    song: bandAlphaAt(scale, fitScale, REPRESENTATION_WINDOWS.song),
    grain: bandAlphaAt(scale, fitScale, REPRESENTATION_WINDOWS.grain),
  };
}

export function shelfLabelAlpha(scale: number, fitScale: number): number {
  'worklet';
  return bandAlphaAt(scale, fitScale, SHELF_LABEL_WINDOW);
}
