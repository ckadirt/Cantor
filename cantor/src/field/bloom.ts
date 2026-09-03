import { REPRESENTATION_WINDOWS, smootherstep } from './bands';
import type { Placement, Point } from './types';

/**
 * Bloom and gather: where a song sits *inside* its cluster.
 *
 * A cluster has two poses and the camera chooses between them.
 *
 * - **Bloomed** — a phyllotaxis packing around the cluster centre. This is what
 *   L0 shows: a shelf reads as a body of work rather than as a bulleted list.
 * - **Gathered** — the shared-x column `layoutField` computes, one song per
 *   `SONG_GAP_WORLD`.
 *
 * The gather is not decoration, it is a requirement of the row representation.
 * `FieldCanvas` draws a row as a fixed 240×30 *screen* box at the mark's own
 * point, and the dot and row bands overlap, so two marks Δx world units apart
 * put their rows Δx·scale pixels apart and anything under 240 collides. A
 * static 2-D packing that never gathered would read beautifully as dots and
 * turn into titles stacked on titles the moment you zoomed.
 *
 * Offsets are in **world** units so `fit` can frame the bloomed cluster; the
 * blend between the poses is a function of *screen* scale and is computed at
 * draw time in `recordFieldPicture`, never in React state. Putting it in
 * `useFieldCamera` would rebuild every placement on every pinch frame.
 */

/** KNOBS — the packing, and the scale window the cluster closes over. */
export const BLOOM_KNOBS = {
  /**
   * The golden angle, π(3−√5). Successive indices land at irrational fractions
   * of a turn, so no index ever repeats a spoke and the packing has no seams.
   */
  GOLDEN_ANGLE_RAD: Math.PI * (3 - Math.sqrt(5)),
  /**
   * Radius per √index, in world units. A phyllotaxis packing puts one point in
   * every πc² of area, so neighbours land about c·√π apart — 26.6 at 15, which
   * is `LAYOUT_KNOBS.SONG_GAP_WORLD`. The bloom therefore reads at the spacing
   * the column already proved legible, without importing it and closing a
   * layout → bloom → layout cycle.
   */
  SPACING_WORLD: 15,
  /**
   * No cluster blooms wider than this. Shelves sit `SHELF_GAP_WORLD` (300)
   * apart in both axes, so two neighbours touch at 150; 120 keeps a margin.
   * Past roughly 65 songs a cluster packs tighter rather than into its
   * neighbour.
   */
  MAX_RADIUS_WORLD: 120,
  /**
   * The gather runs between these multiples of FIT. It starts where the dot
   * band stops holding full alpha and finishes where the row band reaches it,
   * which is the last moment before rows could overlap.
   */
  GATHER_START_FIT: REPRESENTATION_WINDOWS.dot[2],
  GATHER_END_FIT: REPRESENTATION_WINDOWS.row[1],
} as const;

/**
 * The offset from the cluster's column to this member's bloomed seat.
 *
 * `index` is the member's index within its group, which is also its order in
 * the column — the spiral and the column are indexed by the same number, so a
 * re-sort moves both poses together.
 */
export function bloomOffset(index: number, count: number): Point {
  if (!Number.isFinite(index) || index <= 0 || count <= 1) {
    return { x: 0, y: 0 };
  }
  const radius = BLOOM_KNOBS.SPACING_WORLD * Math.sqrt(index);
  const angle = index * BLOOM_KNOBS.GOLDEN_ANGLE_RAD;
  const compression = clusterCompression(count);
  return {
    x: Math.cos(angle) * radius * compression,
    y: Math.sin(angle) * radius * compression,
  };
}

/**
 * How far the cluster has closed: 0 fully bloomed, 1 fully gathered.
 *
 * Smootherstep, per the motion rules — the gather is a camera-driven transform
 * and every one of those is eased mathematically, never sprung.
 */
export function gatherFraction(scale: number, fitScale: number): number {
  // A worklet, because the native renderer blends the two poses on the UI
  // thread. It reaches `smootherstep` in `bands.ts`, which is a worklet for the
  // same reason and is imported rather than copied: one gather curve, or the
  // two renderers would disagree about where a cluster has closed to.
  'worklet';
  if (!Number.isFinite(scale) || !Number.isFinite(fitScale) || fitScale <= 0) {
    return 1;
  }
  const ratio = scale / fitScale;
  const span = BLOOM_KNOBS.GATHER_END_FIT - BLOOM_KNOBS.GATHER_START_FIT;
  if (span <= 0) return ratio >= BLOOM_KNOBS.GATHER_END_FIT ? 1 : 0;
  return smootherstep((ratio - BLOOM_KNOBS.GATHER_START_FIT) / span);
}

/**
 * Where a placement actually is, in world units, at this point in the gather.
 *
 * Every reader of a placement's position must go through this — the canvas, the
 * shelf labels and `hitTestPlacement` above all, or taps land on the mark a
 * song used to be at.
 */
export function placementPoint(placement: Placement, gather: number): Point {
  const bloom = 1 - clamp01(gather);
  return {
    x: placement.x + placement.bloomX * bloom,
    y: placement.y + placement.bloomY * bloom,
  };
}

/** The placement's fully bloomed target, which is what `fit` has to frame. */
export function bloomedTargetPoint(placement: Placement): Point {
  return {
    x: placement.targetX + placement.targetBloomX,
    y: placement.targetY + placement.targetBloomY,
  };
}

/** Squeeze a large cluster back inside `MAX_RADIUS_WORLD`. */
function clusterCompression(count: number): number {
  const outermost = BLOOM_KNOBS.SPACING_WORLD * Math.sqrt(count - 1);
  if (outermost <= BLOOM_KNOBS.MAX_RADIUS_WORLD) return 1;
  return BLOOM_KNOBS.MAX_RADIUS_WORLD / outermost;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}
