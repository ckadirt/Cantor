import { FLIGHT_NAME, type FlightTiming } from '../../field';

/**
 * How present the map is behind find's gather, on the canvas (gather-plan G2).
 *
 * The found shelf keeps its ink; everything else recedes to a ghost as the
 * gather begins and comes back as it ends. A face on its way out of the
 * column fades as it flies home, and one on its way in brightens as it comes,
 * so no face ever changes ink where it stands.
 */

/** The map's ink at a gather's two ends, and when it has arrived; see `planGatherCut`. */
export type Recede = Readonly<{ from: number; to: number; end: number }>;

/** The map's ink at `linear` on the re-cut's clock. */
export function recedeInkAt(recede: Recede, linear: number): number {
  'worklet';
  const raw = recede.end > 0 ? linear / recede.end : 1;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  return recede.from + (recede.to - recede.from) * eased;
}

/**
 * One face's ink during a gather: the found shelf's in full, a face flying
 * in from the map brightening as it comes, one flying home fading to the
 * map's, and the map's otherwise. `progress` is the face's own, eased.
 */
export function gatherFaceInk(
  recede: Recede | null,
  linear: number,
  timing: FlightTiming | undefined | null,
  found: boolean,
  progress: number,
): number {
  'worklet';
  if (recede === null) return 1;
  const name = timing == null ? FLIGHT_NAME.RIDE : timing.name;
  if (found) {
    return name === FLIGHT_NAME.WRITE
      ? recede.from + (1 - recede.from) * progress
      : 1;
  }
  if (name === FLIGHT_NAME.ERASE) return 1 + (recede.to - 1) * progress;
  return recedeInkAt(recede, linear);
}

/**
 * How much of a name is written, 0..1: written on in its window as its face
 * lands, erased in its window as its face leaves, whole otherwise.
 */
export function gatherNameAt(
  timing: FlightTiming | undefined | null,
  linear: number,
): number {
  'worklet';
  if (timing == null || timing.name === FLIGHT_NAME.RIDE) return 1;
  const span = timing.nameEnd - timing.nameStart;
  const raw = span > 0 ? (linear - timing.nameStart) / span : linear >= timing.nameEnd ? 1 : 0;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  return timing.name === FLIGHT_NAME.WRITE ? eased : 1 - eased;
}
