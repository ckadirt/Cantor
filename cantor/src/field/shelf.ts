import { LEVEL_BOUNDARIES } from './camera';
import type { Camera, FieldLayout } from './types';

/**
 * The shelf as somewhere you can stand.
 *
 * At L1 the bloom has closed and a cluster is a column: one x, and a run of y
 * from its first row to its last. That is a *seat* — a place the camera belongs
 * rather than a place it happens to be — and the whole of this file exists so
 * the camera can be told which seat it is in without being told by a tap.
 *
 * Two things need that answer and neither had it before:
 *
 * - **Containment.** Shelves sit `SHELF_GAP_WORLD` apart in both axes and a
 *   column is much shorter than that gap, so free panning at L1 walks into
 *   nothing. On a small library the void is at its widest — 2.7 screen widths
 *   at six weeks of four songs — which is also a new person's first library.
 * - **The chrome.** The header named the group you *descended into*, because
 *   `focus` is only written by a tap. Pan from September to August and the
 *   header still said September. It now names the seat you are nearest, which
 *   is a question only geometry can answer.
 *
 * Every function here is a worklet: the pan runs on the UI thread and a seat
 * lookup per touch frame must not cost a thread hop.
 */

/** KNOBS — world units, screen pixels, and fractions of a seat. */
export const SHELF_KNOBS = {
  /**
   * How far past a column's ends the camera may travel, as a fraction of the
   * viewport height. A third of a screen is enough to see that the column has
   * ended and not enough to lose it.
   */
  OVERSCROLL_RATIO: 1 / 3,
  /**
   * How much screen stays between an end row and the edge it is nearest, as a
   * fraction of the viewport height. The chrome owns roughly the top 150 px and
   * the dials the foot, so a fifth keeps the first and last rows clear of both.
   */
  END_MARGIN_RATIO: 1 / 5,
  /**
   * The pull needed to leave a seat sideways, as a fraction of the gap to the
   * neighbour. Below this the camera returns; above it, it is a move.
   *
   * Half would make the two outcomes equally likely at the midpoint, which is
   * the one place a person has expressed no preference. A third means a
   * deliberate drag leaves and a wandering one does not.
   */
  ESCAPE_FRACTION: 1 / 3,
} as const;

/** Where one cluster's column stands, in world units. */
export type ShelfSeat = Readonly<{
  key: string;
  /** The column's shared x — every gathered member sits on it. */
  cx: number;
  /** The first and last row's y. Equal when the shelf holds one song. */
  top: number;
  bottom: number;
}>;

/**
 * The gathered extent of every cluster, in the order `layout.groups` has them.
 *
 * Built from `targetY` rather than from the bloomed pose: containment applies
 * at L1, where the gather has finished and the bloom offsets are zero. Framing
 * the bloomed bounds instead would reserve room for a pose that is not on the
 * screen at the level this is used.
 */
export function shelfSeats(layout: FieldLayout): readonly ShelfSeat[] {
  const extents = new Map<string, { top: number; bottom: number }>();
  for (const placement of layout.placements) {
    const seen = extents.get(placement.groupKey);
    if (seen === undefined) {
      extents.set(placement.groupKey, {
        top: placement.targetY,
        bottom: placement.targetY,
      });
      continue;
    }
    if (placement.targetY < seen.top) seen.top = placement.targetY;
    if (placement.targetY > seen.bottom) seen.bottom = placement.targetY;
  }
  return layout.groups.map(group => {
    const extent = extents.get(group.key);
    return {
      key: group.key,
      cx: group.cx,
      top: extent?.top ?? group.cy,
      bottom: extent?.bottom ?? group.cy,
    };
  });
}

/**
 * Which seat the camera is standing in, or -1 when there are none.
 *
 * Nearest by squared distance to the column's *centre*, so a camera below the
 * last row of a short shelf still belongs to that shelf rather than to the one
 * whose centre happens to be closer in x.
 */
export function nearestSeat(
  seats: readonly ShelfSeat[],
  camera: Camera,
): number {
  'worklet';
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < seats.length; index += 1) {
    const seat = seats[index];
    const dx = seat.cx - camera.x;
    const dy = (seat.top + seat.bottom) / 2 - camera.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * Whether the camera is close enough for a column to be the thing on screen.
 *
 * The same boundaries `levelOf` uses, inlined rather than imported as a call:
 * `levelOf` asserts and throws, and a worklet that throws inside a gesture
 * handler takes the gesture with it.
 */
export function isShelfDistance(scale: number, fitScale: number): boolean {
  'worklet';
  if (!(fitScale > 0) || !(scale > 0)) return false;
  const ratio = scale / fitScale;
  return ratio >= LEVEL_BOUNDARIES.field && ratio < LEVEL_BOUNDARIES.shelf;
}

/**
 * An offset damped so that it can grow without ever passing `limit`.
 *
 *     f(x) = limit · x / (limit + x)
 *
 * `f(0) = 0`, `f′(0) = 1` — the first pixel of a drag is free, which is what
 * makes the resistance read as weight rather than as lag — and `f(∞) = limit`,
 * so no drag however long can put the camera past the margin. Half the limit is
 * spent by `x = limit`, three quarters by `x = 3 · limit`.
 */
export function rubberBand(offset: number, limit: number): number {
  'worklet';
  if (!(limit > 0) || !Number.isFinite(offset)) return 0;
  const sign = offset < 0 ? -1 : 1;
  const magnitude = offset < 0 ? -offset : offset;
  return (sign * limit * magnitude) / (limit + magnitude);
}

/**
 * The range of camera `y` that keeps the column on the screen, in world units.
 *
 * List semantics rather than a box around the content: at `min` the first row
 * sits an end margin below the top edge, at `max` the last row sits the same
 * margin above the bottom edge. A column shorter than the screen has no range
 * at all — the two bounds cross — and the honest answer there is its middle,
 * which is also where `levelCameraTarget` seats the camera when you descend.
 */
export function seatCameraBounds(
  seat: ShelfSeat,
  viewport: { readonly height: number },
  scale: number,
): { readonly min: number; readonly max: number } {
  'worklet';
  const halfHeight = viewport.height / 2 / scale;
  const margin = (viewport.height * SHELF_KNOBS.END_MARGIN_RATIO) / scale;
  // At `min` the screen's top edge sits one margin above the first row, so the
  // camera — which is half a screen below whatever is at that edge — is the
  // first row plus half a screen, less the margin. At `max`, the mirror of it.
  const min = seat.top + halfHeight - margin;
  const max = seat.bottom - halfHeight + margin;
  if (min > max) {
    const middle = (seat.top + seat.bottom) / 2;
    return { min: middle, max: middle };
  }
  return { min, max };
}

/**
 * Hold a camera inside its seat.
 *
 * Vertical travel is clamped to the column's own run plus an overscroll margin
 * either end; horizontal travel is damped toward the column's x. Neither is a
 * wall: past the limit the camera keeps moving, just less and less, so the
 * canvas still reads as one continuous surface rather than as a list in a box.
 *
 * `escaped` is the caller's business, not this function's: containment says
 * where the finger is allowed to put the camera, and the decision to leave for
 * a neighbour is made when the finger lifts.
 */
export function containToSeat(
  camera: Camera,
  seat: ShelfSeat,
  viewport: { readonly height: number },
  gapWorld: number,
): Camera {
  'worklet';
  const bounds = seatCameraBounds(seat, viewport, camera.scale);
  const overscroll =
    (viewport.height * SHELF_KNOBS.OVERSCROLL_RATIO) / camera.scale;
  const y =
    camera.y < bounds.min
      ? bounds.min - rubberBand(bounds.min - camera.y, overscroll)
      : camera.y > bounds.max
      ? bounds.max + rubberBand(camera.y - bounds.max, overscroll)
      : camera.y;
  // Sideways there is no free range at all: the column is one x, so every
  // pixel of horizontal travel is already past the limit and damped.
  const limit = gapWorld * SHELF_KNOBS.ESCAPE_FRACTION;
  return {
    scale: camera.scale,
    x: seat.cx + rubberBand(camera.x - seat.cx, limit),
    y,
  };
}


/**
 * The seat a released gesture belongs to: the neighbour if the drag reached
 * far enough sideways, otherwise the one it started in.
 *
 * Measured against the *undamped* camera, because the damping is what the
 * finger felt, not what it asked for. A person who drags a full screen
 * sideways has asked to leave even though the camera only moved a third of it.
 */
export function seatAfterRelease(
  seats: readonly ShelfSeat[],
  released: Camera,
  from: number,
  gapWorld: number,
): number {
  'worklet';
  if (from < 0 || from >= seats.length) return from;
  const travelled = released.x - seats[from].cx;
  const escape = gapWorld * SHELF_KNOBS.ESCAPE_FRACTION;
  if (travelled > -escape && travelled < escape) return from;
  // The nearest seat in the direction of travel, which is not always the one
  // adjacent by index: the grid wraps, so a row's last cluster has no
  // right-hand neighbour and must stay where it is.
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < seats.length; index += 1) {
    if (index === from) continue;
    const dx = seats[index].cx - seats[from].cx;
    if (travelled > 0 ? dx <= 0 : dx >= 0) continue;
    const dy = seats[index].top - seats[from].top;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
