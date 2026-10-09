import { smootherstep } from '../field/bands';

/**
 * A lens change written along the song's clock: each piece of the drawing
 * leaves (or lands) at its own moment, in time order, rather than the whole
 * drawing at once — the cover's morphs (`pairs.ts`) unspool the circle and the
 * seal into the picture this way.
 *
 * A piece at `rank` (0..1, its place in the song) moves on its own window of
 * the change's `t`, and the windows overlap: each is `1 / (1 + SPAN)` of the
 * change long, the first starting at 0 and the last ending at 1.
 */
export const SWEEP_KNOBS = {
  /**
   * How far the windows are spread over the change, against one window's
   * length: at 1.5 a piece takes 40% of the change, so the front is always
   * a few pieces wide and never a single pop.
   */
  SPAN: 1.5,
  /**
   * How many groups a drawing's pieces are cut into along the clock, each
   * group moved as one: enough that the front reads as a sweep, few enough
   * that a frame is a few dozen draws rather than one per glyph.
   */
  BANDS: 48,
} as const;

/** How far the piece at `rank` has gone, 0..1, eased, at the change's `t`. */
export function sweepAt(t: number, rank: number): number {
  'worklet';
  const span = SWEEP_KNOBS.SPAN;
  return smootherstep(Math.min(Math.max(t * (1 + span) - rank * span, 0), 1));
}

/**
 * The rank the sweep's front stands at: the pieces before it have started to
 * move and the rest have not. 0 at the start, 1 once the last has started.
 */
export function sweepFront(t: number): number {
  'worklet';
  const span = SWEEP_KNOBS.SPAN;
  return Math.min(Math.max((t * (1 + span)) / span, 0), 1);
}

/** The band a piece at `rank` is moved with. */
export function sweepBand(rank: number): number {
  return Math.min(
    SWEEP_KNOBS.BANDS - 1,
    Math.max(0, Math.floor(rank * SWEEP_KNOBS.BANDS)),
  );
}

/** The rank a whole band moves at: its middle. */
export function sweepBandRank(band: number): number {
  'worklet';
  return (band + 0.5) / SWEEP_KNOBS.BANDS;
}
