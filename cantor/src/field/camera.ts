import { REPRESENTATION_WINDOWS, smootherstep } from './bands';
import type {
  Box,
  Camera,
  FieldLayout,
  Level,
  Placement,
  Point,
  Viewport,
} from './types';

/** KNOBS — each level is relative to the scale that frames the whole field. */
export const LEVEL_SCALE_RATIOS = {
  shelf: 5,
  song: 30,
  grain: 670,
} as const;

/** The exclusive upper bound for each semantic zoom level, relative to FIT. */
export const LEVEL_BOUNDARIES = {
  field: 2,
  shelf: 13,
  song: 170,
} as const;

/**
 * KNOBS — how a mark is taken apart and put back together as a row, in
 * multiples of FIT.
 *
 * Two windows rather than one, because a mark becoming a row is two things and
 * they must not happen at once. The face steps aside and grows into the seat
 * beside the row; *then* the name is written into the room it left. Run
 * together, the face travels straight through the title — it leaves the mark's
 * point and its seat is `ROW_PREVIEW_OFFSET_PX` to the left, while the title
 * begins less than half that far left, so partway through its journey the shape
 * is sitting on the first letters of the name it is introducing.
 *
 * Both are written in the boundaries the zoom model already has, so the gesture
 * is legible as a sentence about levels rather than as two more tuning numbers:
 * the mark is seated by the moment the field stops being a map, and the name is
 * finished ink by the moment you are standing in the shelf.
 */
export const ROW_ARRIVAL = {
  /**
   * The walk. It starts where the row band starts — the first distance at
   * which a row is any part of what is on screen — and ends at the level
   * boundary.
   */
  FACE_WALK: [REPRESENTATION_WINDOWS.row[0], LEVEL_BOUNDARIES.field],
  /**
   * The writing, from that boundary to the seat.
   *
   * It deliberately outruns the row band, which holds at 3.6. Ending there
   * would give the pen the last fifth of a tapped descent — about 170 ms of the
   * 700 — and a gesture nobody can see is not a gesture. Ending at the seat
   * gives it most of the flight, and says something truer: the name finishes as
   * you land.
   */
  NAME_WRITE: [LEVEL_BOUNDARIES.field, LEVEL_SCALE_RATIOS.shelf],
} as const;

export type FitOptions = Readonly<{
  horizontalSafePaddingPx: number;
  verticalSafePaddingPx: number;
  minimumContentWidthWorld: number;
  minimumContentHeightWorld: number;
  horizontalContentMarginWorld: number;
  verticalContentMarginWorld: number;
  minScale: number;
  maxScale: number;
  emptyScale: number;
}>;

/*
 * Declared before its callers, not after them: the worklets plugin rewrites a
 * `'worklet'` function declaration into a module-scope `const`, and captures it
 * into a calling worklet's closure at the point that caller is defined. A
 * helper defined further down the file is captured as `undefined`.
 */
function assertPositive(value: number, label: string): void {
  'worklet';
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number.`);
  }
}

/** Where a distance sits inside a window of FIT multiples, eased. */
function arrival(
  scale: number,
  fitScale: number,
  window: readonly [number, number],
): number {
  'worklet';
  if (!(fitScale > 0) || !(scale > 0)) return 0;
  const span = window[1] - window[0];
  if (!(span > 0)) return scale / fitScale >= window[1] ? 1 : 0;
  return smootherstep((scale / fitScale - window[0]) / span);
}

/** How far the face has walked to the seat beside its row. */
export function faceArrival(scale: number, fitScale: number): number {
  'worklet';
  return arrival(scale, fitScale, ROW_ARRIVAL.FACE_WALK);
}

/** How much of the row's name has been written, and its metadata arrived. */
export function nameArrival(scale: number, fitScale: number): number {
  'worklet';
  return arrival(scale, fitScale, ROW_ARRIVAL.NAME_WRITE);
}

export function worldToScreen(
  point: Point,
  camera: Camera,
  viewport: Viewport,
): Point {
  return {
    x: (point.x - camera.x) * camera.scale + viewport.width / 2,
    y: (point.y - camera.y) * camera.scale + viewport.height / 2,
  };
}

export function screenToWorld(
  point: Point,
  camera: Camera,
  viewport: Viewport,
): Point {
  'worklet';
  assertPositive(camera.scale, 'Camera scale');
  return {
    x: (point.x - viewport.width / 2) / camera.scale + camera.x,
    y: (point.y - viewport.height / 2) / camera.scale + camera.y,
  };
}

/**
 * Zoom without letting the world point under the focal point drift.
 *
 * A worklet as well as a function: the pinch handler runs on the UI thread, so
 * the focal-point correction has to be available there rather than a thread
 * hop away.
 */
export function zoomAroundFocalPoint(
  camera: Camera,
  focalPoint: Point,
  scaleMultiplier: number,
  viewport: Viewport,
): Camera {
  'worklet';
  assertPositive(scaleMultiplier, 'Scale multiplier');
  const worldPoint = screenToWorld(focalPoint, camera, viewport);
  const scale = camera.scale * scaleMultiplier;
  assertPositive(scale, 'Resulting camera scale');
  return {
    scale,
    x: worldPoint.x - (focalPoint.x - viewport.width / 2) / scale,
    y: worldPoint.y - (focalPoint.y - viewport.height / 2) / scale,
  };
}

/** Compute FIT from target bounds and the layout-owned safe-frame knobs. */
export function fit(
  bounds: Box | null,
  viewport: Viewport,
  options: FitOptions,
): number {
  assertPositive(viewport.width, 'Viewport width');
  assertPositive(viewport.height, 'Viewport height');
  if (bounds === null) return options.emptyScale;

  const contentWidth =
    Math.max(options.minimumContentWidthWorld, bounds.width) +
    options.horizontalContentMarginWorld;
  const contentHeight =
    Math.max(options.minimumContentHeightWorld, bounds.height) +
    options.verticalContentMarginWorld;
  const safeWidth = Math.max(
    0,
    viewport.width - options.horizontalSafePaddingPx,
  );
  const safeHeight = Math.max(
    0,
    viewport.height - options.verticalSafePaddingPx,
  );
  return clamp(
    Math.min(safeWidth / contentWidth, safeHeight / contentHeight),
    options.minScale,
    options.maxScale,
  );
}

export function levelOf(scale: number, fitScale: number): Level {
  assertPositive(scale, 'Camera scale');
  assertPositive(fitScale, 'Fitted scale');
  const ratio = scale / fitScale;
  if (ratio < LEVEL_BOUNDARIES.field) return 'field';
  if (ratio < LEVEL_BOUNDARIES.shelf) return 'shelf';
  if (ratio < LEVEL_BOUNDARIES.song) return 'song';
  return 'grain';
}

/** The camera target for a semantic level, if that level has a focus target. */
export function levelCameraTarget(
  level: Level,
  layout: FieldLayout,
  focus: Placement | null = null,
): Camera | null {
  if (level === 'field') {
    return {
      x: layout.fieldCenter.x,
      y: layout.fieldCenter.y,
      scale: layout.fitScale,
    };
  }
  if (focus === null) return null;
  if (level === 'shelf') {
    const group = layout.groups.find(
      candidate => candidate.key === focus.groupKey,
    );
    if (group === undefined) return null;
    return {
      x: group.cx,
      y: group.cy,
      scale: layout.fitScale * LEVEL_SCALE_RATIOS.shelf,
    };
  }
  return {
    x: focus.x,
    y: focus.y,
    scale:
      layout.fitScale *
      (level === 'song' ? LEVEL_SCALE_RATIOS.song : LEVEL_SCALE_RATIOS.grain),
  };
}

/** A camera flight uses eased position and logarithmic scale for even zoom. */
export function interpolateCamera(
  from: Camera,
  to: Camera,
  progress: number,
): Camera {
  assertPositive(from.scale, 'Starting camera scale');
  assertPositive(to.scale, 'Target camera scale');
  const t = smootherstep(progress);
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    scale: Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), t)),
  };
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
