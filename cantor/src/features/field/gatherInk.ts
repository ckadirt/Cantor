import {
  FLIGHT_NAME,
  GATHER_KNOBS,
  bowOffsetAt,
  gatherFraction,
  type Camera,
  type FlightTiming,
  type Viewport,
} from '../../field';

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

/**
 * The two cameras a gather is drawn through (gather-plan, find-motion.html
 * frame III): the map's, held where you stood when find opened, and the
 * found shelf's, which is the real camera. A face that changes sides flies
 * between their two pictures of it, on the screen.
 */
export type GatherCameras = Readonly<{
  /** Where you stood when find opened; the map is drawn from here. */
  map: Camera;
  /** The real camera when this cut began, for a face leaving the shelf. */
  fromShelf: Camera | null;
  /** Where the real camera stands when it ends. */
  toShelf: Camera | null;
}>;

/** How far the map has receded, 0..1, from its ink. */
export function recededAt(recede: Recede | null, linear: number): number {
  'worklet';
  if (recede === null) return 0;
  const ink = recedeInkAt(recede, linear);
  const amount = (1 - ink) / (1 - GATHER_KNOBS.RECEDE_INK);
  return amount < 0 ? 0 : amount > 1 ? 1 : amount;
}

/** The map's camera this frame: where you stood, settled back as it recedes. */
export function mapCameraAt(
  map: Camera,
  recede: Recede | null,
  linear: number,
): Camera {
  'worklet';
  const receded = recededAt(recede, linear);
  return {
    x: map.x,
    y: map.y,
    scale: map.scale * (1 - (1 - GATHER_KNOBS.RECEDE_SCALE) * receded),
  };
}

/** A seat and its bloom offset on the screen, through one camera. */
export function seatOnScreen(
  seatX: number,
  seatY: number,
  bloomX: number,
  bloomY: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
): { x: number; y: number } {
  'worklet';
  const bloom = 1 - gatherFraction(camera.scale, fitScale);
  return {
    x: (seatX + bloomX * bloom - camera.x) * camera.scale + viewport.width / 2,
    y: (seatY + bloomY * bloom - camera.y) * camera.scale + viewport.height / 2,
  };
}

/** A screen point back into the world, through one camera. */
export function screenToWorld(
  x: number,
  y: number,
  camera: Camera,
  viewport: Viewport,
): { x: number; y: number } {
  'worklet';
  return {
    x: camera.x + (x - viewport.width / 2) / camera.scale,
    y: camera.y + (y - viewport.height / 2) / camera.scale,
  };
}

/**
 * Where a face is on the screen, `progress` of the way from its picture
 * through `source` to its picture through `target`, on its bow. With one
 * camera at both ends this is the ordinary re-cut's straight line.
 */
export function flightOnScreen(
  fromX: number,
  fromY: number,
  fromBloomX: number,
  fromBloomY: number,
  targetX: number,
  targetY: number,
  targetBloomX: number,
  targetBloomY: number,
  source: Camera,
  target: Camera,
  fitScale: number,
  viewport: Viewport,
  progress: number,
  bowPx: number,
): { x: number; y: number } {
  'worklet';
  const a = seatOnScreen(fromX, fromY, fromBloomX, fromBloomY, source, fitScale, viewport);
  const b = seatOnScreen(
    targetX,
    targetY,
    targetBloomX,
    targetBloomY,
    target,
    fitScale,
    viewport,
  );
  const bow = bowOffsetAt(b.x - a.x, b.y - a.y, bowPx, progress);
  return {
    x: a.x + (b.x - a.x) * progress + bow.x,
    y: a.y + (b.y - a.y) * progress + bow.y,
  };
}

/**
 * The cut's two cameras if it is still drawn through them: always while it
 * runs, and once it has landed only while the map stays receded — a gather
 * that has been left hands the map back to the real camera, which by then
 * stands where the map's did.
 */
export function gatherDrawn(
  gather: GatherCameras | null | undefined,
  recede: Recede | null,
  progress: number,
): GatherCameras | null {
  'worklet';
  if (gather == null) return null;
  if (progress >= 1 && (recede === null || recede.to >= 1)) return null;
  return gather;
}
