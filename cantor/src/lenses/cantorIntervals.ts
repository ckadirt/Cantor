/**
 * The middle-thirds construction, as data.
 *
 * Depth `d` removes the middle third `d` times, leaving `2^d` intervals each of
 * length `3^-d`. Depth five is the lens depth: 32 bars is enough structure to
 * read a song's shape at a glance and few enough to draw at every mark in a
 * five-hundred-placement field.
 *
 * This is generated rather than authored. The origin mark keeps its own
 * hand-drawn icon geometry in `src/onboarding/cantorBars.ts` — that artwork is
 * the launcher icon and is tuned optically, so it is not the same thing as the
 * exact set even though it draws the same idea.
 */

/** KNOBS */
export const CANTOR_LENS_DEPTH = 5; // 2^5 = 32 bars

/** A closed interval inside [0, 1]. `start < end` always. */
export type Interval = Readonly<{ start: number; end: number }>;

/**
 * The intervals surviving `depth` removals, in ascending order.
 *
 * Depth 0 is the whole segment, which is the honest base case rather than a
 * special one: it is what the set looks like before anything is removed.
 */
export function cantorIntervals(depth: number): readonly Interval[] {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error('Cantor depth must be a non-negative integer.');
  }
  let intervals: Interval[] = [{ start: 0, end: 1 }];
  for (let step = 0; step < depth; step += 1) {
    const next: Interval[] = [];
    for (const { start, end } of intervals) {
      const third = (end - start) / 3;
      next.push({ start, end: start + third });
      next.push({ start: end - third, end });
    }
    intervals = next;
  }
  return intervals;
}

/**
 * The lens's 32 intervals, built once.
 *
 * Every mark in the field draws these, so they are computed at module load and
 * shared. Allocating an interval array per placement per frame is the thing
 * that kills the field at a few hundred marks.
 */
export const LENS_INTERVALS: readonly Interval[] =
  cantorIntervals(CANTOR_LENS_DEPTH);

/** Total length of the set at `depth` — `(2/3)^depth`, and the reason it vanishes. */
export function cantorMeasure(depth: number): number {
  return (2 / 3) ** depth;
}
