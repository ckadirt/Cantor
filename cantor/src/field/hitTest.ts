import { gatherFraction, placementPoint } from './bloom';
import { worldToScreen } from './camera';
import { distance as pointDistance } from './geometry';
import type { Camera, Level, Placement, Point, Viewport } from './types';

/** KNOBS — tap targets stay in screen pixels as camera scale changes. */
export const HIT_TEST_KNOBS = {
  MARK_RADIUS_PX: 34,
  ROW_HALF_WIDTH_PX: 150,
  ROW_HALF_HEIGHT_PX: 30,
} as const;

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
