import {
  LEVEL_BOUNDARIES,
  LEVEL_SCALE_RATIOS,
  REPRESENTATION_WINDOWS,
  bandAlphaAt,
  nearestSeat,
  type Camera,
  type ShelfSeat,
} from '../../field';
import { originRun } from './OriginMark';

/** KNOBS */
export const CAMERA_SUMMARY_KNOBS = {
  /**
   * Where the player's surface changes for React: mounted above the first,
   * touchable above the second. The same two numbers `FieldScreen` tests
   * `songAlpha` against.
   */
  SONG_MOUNT_ALPHA: 0.01,
  SONG_TOUCH_ALPHA: 0.6,
  /**
   * Zoom steps per factor of e at the grain, where the zoom is the scrub: the
   * decoded window is asked for again once per step, ~13% of scale apiece.
   */
  GRAIN_STEPS_PER_E: 8,
} as const;

/** What the origin mark needs of the layout, for the UI thread. */
export type OriginFrame = Readonly<{ centerX: number; groupCount: number }>;

/**
 * Everything React shows of the camera, as one short key.
 *
 * The camera moves on the UI thread every frame; React used to be handed a
 * copy of it as fast as it could commit one, and re-rendered the whole screen
 * for each — ~30% of a core while panning (see the rewrite log). But nothing
 * React draws changes every frame: the level, the shelf the header names, the
 * lit run of the origin mark, whether the player's surface is mounted or
 * touchable, and at the grain which window is decoded. Each is a threshold.
 * The camera is copied into React when this key changes (and whenever a
 * gesture ends or a flight lands), and not otherwise.
 */
export function cameraSummary(
  camera: Camera,
  fitScale: number,
  seats: readonly ShelfSeat[],
  origin: OriginFrame,
): string {
  'worklet';
  if (!(camera.scale > 0) || !(fitScale > 0)) return '';
  const ratio = camera.scale / fitScale;
  const depth =
    ratio < LEVEL_BOUNDARIES.field
      ? 0
      : ratio < LEVEL_BOUNDARIES.shelf
      ? 1
      : ratio < LEVEL_BOUNDARIES.song
      ? 2
      : 3;
  // Where an ascent lets go of the player: see `mirrorCamera`.
  const belowShelf = ratio <= LEVEL_SCALE_RATIOS.shelf ? 1 : 0;
  const seat = depth === 0 ? -1 : nearestSeat(seats, camera);
  const run = originRun(camera.x, origin.centerX, origin.groupCount, depth);
  const song = bandAlphaAt(camera.scale, fitScale, REPRESENTATION_WINDOWS.song);
  const songStep =
    song > CAMERA_SUMMARY_KNOBS.SONG_TOUCH_ALPHA
      ? 2
      : song > CAMERA_SUMMARY_KNOBS.SONG_MOUNT_ALPHA
      ? 1
      : 0;
  const zoom =
    depth === 3
      ? Math.round(
          Math.log(camera.scale) * CAMERA_SUMMARY_KNOBS.GRAIN_STEPS_PER_E,
        )
      : 0;
  return `${depth}:${belowShelf}:${seat}:${run}:${songStep}:${zoom}`;
}
