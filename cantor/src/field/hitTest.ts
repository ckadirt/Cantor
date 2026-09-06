import { gatherFraction, placementPoint } from './bloom';
import { worldToScreen } from './camera';
import { distance as pointDistance } from './geometry';
import type { Camera, Level, Placement, Point, Viewport } from './types';

/** KNOBS — tap targets stay in screen pixels as camera scale changes. */
export const HIT_TEST_KNOBS = {
  MARK_RADIUS_PX: 34,
  ROW_HALF_WIDTH_PX: 150,
  ROW_HALF_HEIGHT_PX: 30,
  /**
   * The action column, from the row's point. The name lens right-aligns the
   * word at +120 and cuts the title before it, so this band covers the word
   * and the air around it without ever reaching the title.
   */
  ROW_ACTION_LEFT_PX: 62,
  ROW_ACTION_RIGHT_PX: 150,
} as const;

/**
 * The row whose action column a tap landed in, if any.
 *
 * Tap descends and hold acts, with one exception: the word at the end of a row
 * is the action, and tapping it does that rather than opening the song. The
 * band is only live at L1, where rows are drawn and gathered so they cannot
 * overlap; everywhere else this is nothing and the tap descends as usual.
 *
 * The caller decides whether the row actually offers an action — a song that is
 * already arriving offers none, and its column has to keep descending.
 */
export function hitTestRowAction(
  placements: readonly Placement[],
  camera: Camera,
  viewport: Viewport,
  point: Point,
  level: Level,
  fitScale: number,
): Placement | null {
  if (level !== 'shelf') return null;
  const gather = gatherFraction(camera.scale, fitScale);
  let winner: { placement: Placement; distance: number } | null = null;
  for (const placement of placements) {
    const screen = worldToScreen(
      placementPoint(placement, gather),
      camera,
      viewport,
    );
    const dx = point.x - screen.x;
    const dy = Math.abs(point.y - screen.y);
    if (dx < HIT_TEST_KNOBS.ROW_ACTION_LEFT_PX) continue;
    if (dx > HIT_TEST_KNOBS.ROW_ACTION_RIGHT_PX) continue;
    if (dy > HIT_TEST_KNOBS.ROW_HALF_HEIGHT_PX) continue;
    if (
      winner === null ||
      dy < winner.distance ||
      (dy === winner.distance && placement.key < winner.placement.key)
    ) {
      winner = { placement, distance: dy };
    }
  }
  return winner?.placement ?? null;
}

/**
 * Return the nearest tap target. L1 accepts the full row band as well as the
 * mark; placement-key tie-breaking keeps results independent of input order.
 *
 * `fitScale` is not optional and is not a convenience: a cluster is bloomed at
 * L0 and gathered at L1, so a mark's screen position depends on the camera's
 * distance. Hit testing the gathered column while the canvas draws the packing
 * would send every tap to whichever song happens to hold that seat.
 */
export function hitTestPlacement(
  placements: readonly Placement[],
  camera: Camera,
  viewport: Viewport,
  point: Point,
  level: Level,
  fitScale: number,
): Placement | null {
  const gather = gatherFraction(camera.scale, fitScale);
  let winner: { placement: Placement; distance: number } | null = null;
  for (const placement of placements) {
    const screen = worldToScreen(
      placementPoint(placement, gather),
      camera,
      viewport,
    );
    const markDistance = pointDistance(screen, point);
    const inRowBand =
      level === 'shelf' &&
      Math.abs(screen.x - point.x) <= HIT_TEST_KNOBS.ROW_HALF_WIDTH_PX &&
      Math.abs(screen.y - point.y) <= HIT_TEST_KNOBS.ROW_HALF_HEIGHT_PX;
    if (!inRowBand && markDistance > HIT_TEST_KNOBS.MARK_RADIUS_PX) continue;

    const hitDistance = inRowBand ? 0 : markDistance;
    if (
      winner === null ||
      hitDistance < winner.distance ||
      (hitDistance === winner.distance && placement.key < winner.placement.key)
    ) {
      winner = { placement, distance: hitDistance };
    }
  }
  return winner?.placement ?? null;
}
