import { NAME_LENS_KNOBS } from '../../lenses';

/**
 * Where the player's parts sit, as pure numbers on the UI thread.
 *
 * The player is the third pose of one drawing, not a screen that opens over the
 * second one. A mark is a face at seven pixels; a row is that same face at 1.2×
 * with a name written beside it; the player is that same face again, filling
 * the view, with the same name grown into the foot. Nothing here fades into
 * anything — every value below is a position or a size that a band moves
 * continuously between, which is the whole reason this file is numbers rather
 * than components.
 *
 * Every offset is measured **from the song's own mark point**, because that is
 * the origin the native renderer already moves: `NativePlacementFlight` puts
 * one group at the mark's screen position and hangs both other poses off it.
 * Expressing the player in viewport coordinates instead would need a second
 * anchor, and the two would have to be held level by hand on every frame.
 *
 * That makes the foot's placement exact only where the camera is centred on the
 * mark, which is what arriving at a song means and what `levelCameraTarget`
 * does for `song`. On the way in it is approximate and converging, which reads
 * as the row carrying its name to its seat — the gesture, not an error in it.
 * The recorded picture made the same assumption before this file existed; it
 * drew the player's box at the mark's point too.
 */

/** KNOBS — the player's geometry, in fractions of the view it fills. */
export const PLAYER_POSE_KNOBS = {
  /**
   * The player's ring, as a fraction of the view's *width*.
   *
   * Square and width-derived so the ring is the same size on any phone, and
   * small enough that the song's name, its recipe and its words all clear it:
   * they live under the ring, and a title crossing the waveform is two things
   * claiming the same pixels.
   */
  SONG_BOX_RATIO: 0.76,
  /**
   * How far the ring rises above the mark's own point, as a fraction of the
   * view's height, once the player is fully here.
   *
   * The design seats the ring above the song's name rather than in the middle
   * of the screen, and the name needs the lower third. Scaled by the song band
   * so the ring is still centred on the mark where the row hands over and has
   * risen to its seat by the time the player is the only thing left — the mark
   * rises into its seat rather than jumping to it.
   */
  SONG_RISE_RATIO: 0.12,
  /** Where the sweeping arc sits, as a fraction of the player's radius. */
  SONG_ARC_RATIO: 0.5,
  /** The song's name at L2 — `type.title`, the largest type after the field's own. */
  SONG_TITLE_SIZE_PX: 26,
  /**
   * The foot's inset from the bottom edge, clear of the origin mark that sits
   * at the same corner.
   */
  SONG_FOOT_INSET_PX: 120,
  /** The foot's inset from the left edge — `space.lg`, the app's own margin. */
  SONG_FOOT_SIDE_PX: 24,
  /**
   * The recipe line, one line under the name.
   *
   * Measured from the name's *baseline*, so it has to clear the name's
   * descenders as well as the recipe's own cap — at 24 the two lines touched
   * and the recipe read as an underline.
   */
  SONG_META_GAP_PX: 30,
  /** Where the elapsed sits: above the ring, as a fraction of the view's height. */
  SONG_ELAPSED_TOP_RATIO: 0.13,
  /** The hairline the playhead runs along, between the recipe and the words. */
  SONG_SCRUB_GAP_PX: 52,
  SONG_SCRUB_HEIGHT_PX: 2,
  /** Touch target around that hairline, for the layer that catches fingers. */
  SONG_SCRUB_HIT_PX: 44,
  /** The transport words, under the recipe line. */
  SONG_WORDS_GAP_PX: 78,
  /** Air between one transport word and the next. */
  SONG_WORD_GAP_PX: 24,
} as const;

export type PoseViewport = Readonly<{ width: number; height: number }>;

/** Half the player's box: the radius every other part is measured against. */
export function playerRadiusPx(viewportWidth: number): number {
  'worklet';
  return (viewportWidth * PLAYER_POSE_KNOBS.SONG_BOX_RATIO) / 2;
}

/**
 * How far the player's centre has risen off the mark's point, this frame.
 *
 * A fraction of the *arrival* rather than a fixed offset, so the ring is
 * concentric with the row's face at the moment the row hands over and has
 * climbed to its seat by the time the player is all there is.
 */
export function playerRisePx(viewportHeight: number, arrival: number): number {
  'worklet';
  return viewportHeight * PLAYER_POSE_KNOBS.SONG_RISE_RATIO * arrival;
}

/**
 * What the mark's own path has to be scaled by to be the player's face.
 *
 * `nameLensFacePath` is exactly linear in its radius, which is what lets all
 * three poses be one path: the row's face is the mark's at 1.2×, and the
 * player's is the mark's at whatever this returns — around 12× on a phone.
 * There is never a second contour to crossfade to.
 */
export function playerFaceScale(viewportWidth: number): number {
  'worklet';
  return (
    (playerRadiusPx(viewportWidth) * NAME_LENS_KNOBS.SONG_FACE_RATIO) /
    NAME_LENS_KNOBS.MARK_RADIUS_PX
  );
}

/** The arc the playhead sweeps, and the baseline the waveform stands on. */
export function playerArcRadiusPx(viewportWidth: number): number {
  'worklet';
  return playerRadiusPx(viewportWidth) * PLAYER_POSE_KNOBS.SONG_ARC_RATIO;
}

/**
 * The face's pose, this frame: mark, row, player, and every point between.
 *
 * Two segments on one path rather than three poses crossfaded. `walked` carries
 * the face from the mark's point out to the row's preview seat — that is
 * `ROW_ARRIVAL`, the camera's own clock — and `arrived` carries it from there
 * into the middle of the view, growing the whole way. The row's `-98 px` offset
 * is undone by the same number that applies the rise, so the face is back on
 * the mark's own x exactly when it reaches its seat.
 */
export function facePoseAt(
  walked: number,
  arrived: number,
  viewport: PoseViewport,
  rowGrowth: number,
): Readonly<{ x: number; y: number; scale: number }> {
  'worklet';
  const rowScale = 1 + (rowGrowth - 1) * walked;
  return {
    x: -NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX * walked * (1 - arrived),
    y: -playerRisePx(viewport.height, arrived),
    scale: rowScale + (playerFaceScale(viewport.width) - rowScale) * arrived,
  };
}

/**
 * Where the name's first letter sits at each of its two poses.
 *
 * The row's is `nameLens`'s own offset, so the name the native renderer writes
 * and the name the picture draws are in the same place. The player's is the
 * foot: left margin, up from the bottom edge, clear of the origin mark.
 */
export function rowTitleOriginPx(): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
    y: NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
  };
}

export function songTitleOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: -viewport.width / 2 + PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX,
    y: viewport.height / 2 - PLAYER_POSE_KNOBS.SONG_FOOT_INSET_PX,
  };
}

/** The recipe line, and then the transport words, each under the last. */
export function songMetaOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  const title = songTitleOriginPx(viewport);
  return { x: title.x, y: title.y + PLAYER_POSE_KNOBS.SONG_META_GAP_PX };
}

export function songScrubOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  const title = songTitleOriginPx(viewport);
  return { x: title.x, y: title.y + PLAYER_POSE_KNOBS.SONG_SCRUB_GAP_PX };
}

export function songWordsOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  const title = songTitleOriginPx(viewport);
  return { x: title.x, y: title.y + PLAYER_POSE_KNOBS.SONG_WORDS_GAP_PX };
}

/** The elapsed readout, centred above the ring. */
export function songElapsedOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: 0,
    y: -viewport.height / 2 + viewport.height * PLAYER_POSE_KNOBS.SONG_ELAPSED_TOP_RATIO,
  };
}

/**
 * The column the name is cut to at each pose.
 *
 * The row's is `nameLens`'s, measured from the same two offsets the lens uses.
 * The player's is the view less both margins — which is why the two strings can
 * differ, and why the name has to *morph* between its poses rather than simply
 * being scaled: at L1 a long title is cut and ellipsed, and at L2 there is room
 * for the whole of it. Scaling one string would either truncate the player or
 * overrun the row.
 */
export function rowTitleColumnPx(actionWidthPx: number): number {
  'worklet';
  const titleLeft = -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX;
  const titleRight =
    actionWidthPx <= 0
      ? NAME_LENS_KNOBS.ROW_RIGHT_PX
      : NAME_LENS_KNOBS.ROW_RIGHT_PX -
        actionWidthPx -
        NAME_LENS_KNOBS.ROW_TITLE_GAP_PX;
  return titleRight - titleLeft;
}

export function songTitleColumnPx(viewportWidth: number): number {
  'worklet';
  return viewportWidth - PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX * 2;
}

/**
 * The foot in *screen* pixels, for the layer that catches fingers.
 *
 * Everything else in this file is measured from the song's own mark, because
 * that is the anchor the drawing moves on. A touch target cannot be: React
 * Native lays out in the viewport, and the mark's point is only knowable on the
 * UI thread. The two agree exactly where the player is settled — the camera is
 * centred on the mark at L2, so the mark's point *is* the middle of the view —
 * which is the only distance at which anything down there is pressable anyway.
 */
export function playerFootScreenPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number; scrubY: number }> {
  return {
    x: PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX,
    y:
      viewport.height -
      PLAYER_POSE_KNOBS.SONG_FOOT_INSET_PX +
      PLAYER_POSE_KNOBS.SONG_WORDS_GAP_PX,
    scrubY:
      viewport.height -
      PLAYER_POSE_KNOBS.SONG_FOOT_INSET_PX +
      PLAYER_POSE_KNOBS.SONG_SCRUB_GAP_PX,
  };
}

/**
 * Whether the player owns a line, this frame: 1 from the instant the song band
 * opens, 0 below it.
 *
 * A step, and one definition rather than two. The row draws its title and its
 * availability line with `1 - this`, and the morph draws them with `this`, so
 * the two can never both be on. Written separately they were, and the frame
 * they overlapped on drew one name twice at full weight in exactly the same
 * place — which does not read as a bug, it reads as the focused row being set
 * in a heavier face.
 *
 * A step is safe precisely here because the morph's `t = 0` geometry *is* the
 * row's line: same string, same font, same baseline. The hand-over is the same
 * pixels either way, so there is nothing to fade between.
 */
export function lineOwnedByPlayer(arrived: number): number {
  'worklet';
  return arrived > 0 ? 1 : 0;
}

/**
 * How far off the bottom edge the lens picker sits.
 *
 * Derived rather than chosen: it has to clear the name, and the name's height
 * is the name's own size above its baseline. Written as a number instead, it
 * was `space.xxl` — which put the picker straight through the title and the
 * recipe, because the picker was laid out when the foot was React's and nobody
 * moved it when the foot became the canvas's.
 */
export function playerLensBottomPx(): number {
  return (
    PLAYER_POSE_KNOBS.SONG_FOOT_INSET_PX +
    PLAYER_POSE_KNOBS.SONG_TITLE_SIZE_PX +
    PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX
  );
}
