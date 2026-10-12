import { smootherstep, type Camera } from '../../field';

/**
 * The queue moving on at L2 as a morph: the player stays where it is and
 * becomes the next song's, rather than folding back into its row and opening
 * the next one (`FIELD_CAMERA_KNOBS.STEP_STYLE`).
 *
 * The player is drawn off its own mark, so the next song's player is drawn
 * one seat away from the one leaving. Two moves bridge that, and neither can
 * be a React commit:
 *
 * 1. The commit that makes the next song the focus mounts its player drawn
 *    through `camera` — the camera that will stand in it — so it lands on the
 *    screen exactly where the leaving player was, while the real camera has
 *    not moved yet. A commit re-records the canvas from the JS thread's
 *    values, and here they agree.
 * 2. Once that player is live on the canvas (`ready`), on the UI thread, in
 *    one worklet, the real camera is cut to that camera and `camera` cleared:
 *    the player is drawn through the same numbers before and after, so
 *    nothing on the screen moves. Everything else at L2 is the player's or
 *    out of sight.
 *
 * Then the morph clock runs, and every part of the player that belongs to a
 * song walks from `from`'s to `to`'s on it.
 */
export type StepMorph = Readonly<{
  /** The placement the morph leaves, whose row the batch leaves out meanwhile. */
  from: string;
  /** The placement it arrives at: the focus, from the first frame. */
  to: string;
  /** The camera `to` is drawn through until the real one is cut to it. */
  camera: Camera | null;
  /**
   * Whether `to`'s player is live on the canvas: Skia mounts it in a render
   * of its own, after the commit, and the cut waits for it.
   */
  ready: boolean;
}>;

/**
 * The camera a placement's player is drawn through: the step's, for the song
 * it is arriving at while the real camera has not been cut yet, and the live
 * one otherwise (null while a re-cut owns the camera).
 */
export function stepCameraFor(
  morph: StepMorph | null,
  placementKey: string,
  live: Camera | null,
): Camera | null {
  'worklet';
  if (live === null || morph === null || morph.camera === null) return live;
  return morph.to === placementKey ? morph.camera : live;
}

/**
 * The camera the focused player is drawn through while a step waits for its
 * cut, or null: `stepCameraFor` for a renderer that holds the focus's key
 * rather than its own.
 */
export function arrivingCamera(
  morph: StepMorph | null,
  focusKey: string | null,
): Camera | null {
  'worklet';
  if (morph === null || morph.camera === null || focusKey === null) return null;
  return morph.to === focusKey ? morph.camera : null;
}

/** How far the morph has walked, eased once here: the clock itself is linear. */
export function stepMorphAt(clock: number): number {
  'worklet';
  return smootherstep(clock < 0 ? 0 : clock > 1 ? 1 : clock);
}

/** Whether a morph is running: the clock rests at 1. */
export function isStepMorphing(clock: number): boolean {
  'worklet';
  return clock < 1;
}
