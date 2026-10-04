import { gatherFraction } from './bloom';
import type { Camera } from './types';

/**
 * A song a camera flight holds on to: its bloom offset, the distance its
 * cluster's map pose stands from its shelf column (`Placement.bloomX/Y`).
 */
export type FlightAnchor = Readonly<{ bloomX: number; bloomY: number }>;

/**
 * The camera a flight stands at, `eased` of the way from `from` to `to`:
 * position eased, scale walked logarithmically so a zoom reads as even.
 *
 * With an anchor, the flight is planned relative to that song as it is drawn.
 * A flight between the map and a shelf crosses the gather, which reshapes
 * every cluster on the way — a bloom closes into a column, and the columns
 * above push everything below them down the world — so a straight line in the
 * world carried the tapped song off the screen and back. Here the camera
 * follows the song's own reshaping, and the song travels on the eased line
 * between where it was touched and where it lands. Both ends are the plain
 * flight's: only the way between changes.
 */
export function flightCameraAt(
  from: Camera,
  to: Camera,
  eased: number,
  anchor: FlightAnchor | null,
  fitScale: number,
): Camera {
  'worklet';
  const scale = Math.exp(
    Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * eased,
  );
  let x = from.x + (to.x - from.x) * eased;
  let y = from.y + (to.y - from.y) * eased;
  if (anchor !== null && fitScale > 0) {
    // How bloomed the song is drawn now, against the straight line between
    // how bloomed it was at either end.
    const startOpen = 1 - gatherFraction(from.scale, fitScale);
    const endOpen = 1 - gatherFraction(to.scale, fitScale);
    const open = 1 - gatherFraction(scale, fitScale);
    const drift = open - (startOpen + (endOpen - startOpen) * eased);
    x += anchor.bloomX * drift;
    y += anchor.bloomY * drift;
  }
  return { scale, x, y };
}
