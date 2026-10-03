import type { CameraRange } from './browse';
import type { Camera, Point } from './types';

/**
 * Momentum: a throw carries the camera on after the finger lifts.
 *
 * The carry is a cubic ease-out, `1 − (1 − u)³`, rather than a decay or a
 * spring: it leaves at exactly the speed the finger was moving (its slope at
 * the start is three times its average), it comes to rest with no speed and no
 * jolt, and it is a deliberate curve rather than a physical one — the house
 * rule for motion. A glide is a camera flight like any other, run on the same
 * clock; only the curve differs.
 */

/** KNOBS — a throw, in screen pixels and milliseconds. */
export const GLIDE_KNOBS = {
  /** Below this release speed the camera stops where the finger left it. */
  MIN_SPEED_PX_S: 300,
  /**
   * A throw faster than this is taken as this. A hard flick reads as "far",
   * not as "to the end of the library".
   */
  MAX_SPEED_PX_S: 6000,
  /**
   * How long an unobstructed glide runs. Its distance follows from it: a
   * throw at `v` travels `v · GLIDE_MS / 3` — 2000 px/s carries about 670 px.
   */
  GLIDE_MS: 1000,
  /**
   * A glide that would run shorter than this is not started: the camera is
   * already at the edge it was thrown toward.
   */
  MIN_GLIDE_MS: 80,
  /**
   * A touch on a glide still moving faster than this catches it, and is not a
   * tap: a person stopping the field did not choose the song under the
   * finger. A glide slower than this is near enough to rest that the touch is
   * a tap after all.
   */
  CATCH_SPEED_PX_S: 150,
} as const;

/** The glide curve: progress along the distance at linear time `u`. */
export function glideEase(u: number): number {
  'worklet';
  const left = 1 - (u < 0 ? 0 : u > 1 ? 1 : u);
  return 1 - left * left * left;
}

/** How fast a glide is moving at linear time `u`, in screen pixels a second. */
export function glideSpeedPxS(
  from: Camera,
  to: Camera,
  durationMs: number,
  u: number,
): number {
  'worklet';
  if (!(durationMs > 0) || u >= 1) return 0;
  const left = 1 - (u < 0 ? 0 : u);
  const distancePx = Math.hypot(to.x - from.x, to.y - from.y) * to.scale;
  return (3 * distancePx * left * left * 1000) / durationMs;
}

export type Glide = Readonly<{ target: Camera; durationMs: number }>;

/**
 * Where a throw carries the camera, or null when it does not carry it at all.
 *
 * `velocity` is the finger's, in screen pixels a second; the camera moves the
 * other way. Each axis is held inside `range`. When the axis the throw mostly
 * runs along meets an edge, the glide stops *at* it on the same curve — run
 * shorter rather than slower, so it still leaves at the finger's speed. The
 * other axis only has its end held: a throw down the map with a little
 * sideways in it must not be cut short by a field that has no room sideways.
 *
 * A camera already past an edge is never carried further past it, but a
 * throw back toward the content still carries.
 */
export function planGlide(
  start: Camera,
  velocity: Point,
  range: CameraRange,
): Glide | null {
  'worklet';
  if (!(start.scale > 0)) return null;
  const speed = Math.hypot(velocity.x, velocity.y);
  if (!(speed >= GLIDE_KNOBS.MIN_SPEED_PX_S)) return null;
  const cap =
    speed > GLIDE_KNOBS.MAX_SPEED_PX_S ? GLIDE_KNOBS.MAX_SPEED_PX_S / speed : 1;
  // World units a second, in the camera's direction.
  const vx = (-velocity.x * cap) / start.scale;
  const vy = (-velocity.y * cap) / start.scale;
  const lowX = Math.min(range.minX, start.x);
  const highX = Math.max(range.maxX, start.x);
  const lowY = Math.min(range.minY, start.y);
  const highY = Math.max(range.maxY, start.y);
  const alongX = Math.abs(vx) >= Math.abs(vy);
  const from = alongX ? start.x : start.y;
  const v = alongX ? vx : vy;
  const low = alongX ? lowX : lowY;
  const high = alongX ? highX : highY;
  let seconds = GLIDE_KNOBS.GLIDE_MS / 1000;
  const reach = from + (v * seconds) / 3;
  if (reach < low || reach > high) {
    seconds = (3 * ((reach < low ? low : high) - from)) / v;
  }
  const durationMs = seconds * 1000;
  if (!(durationMs >= GLIDE_KNOBS.MIN_GLIDE_MS)) return null;
  const x = start.x + (vx * seconds) / 3;
  const y = start.y + (vy * seconds) / 3;
  return {
    durationMs,
    target: {
      scale: start.scale,
      x: x < lowX ? lowX : x > highX ? highX : x,
      y: y < lowY ? lowY : y > highY ? highY : y,
    },
  };
}
