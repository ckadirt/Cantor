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
  SONG_BOX_RATIO: 0.8,
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
  SONG_RISE_RATIO: 0.09,
  /** Where the sweeping arc sits, as a fraction of the player's radius. */
  SONG_ARC_RATIO: 0.5,
  /** The song's name at L2 — `type.title`, the largest type after the field's own. */
  SONG_TITLE_SIZE_PX: 26,
  /**
   * KNOBS — the foot, measured up from the bottom edge.
   *
   * One stack on one axis, in the order a person reads it: what the song looks
   * like, what it is called, what it was made from, what you can do to it, and
   * how it is being drawn. Every one of these is a distance off the bottom
   * rather than a gap from the line above, so changing any single row cannot
   * push the others around — the rhythm is legible as five numbers instead of
   * as a chain of offsets.
   */
  /** The name's baseline. */
  SONG_TITLE_BOTTOM_PX: 245,
  /** The recipe, one line under the name and clear of its descenders. */
  SONG_META_BOTTOM_PX: 215,
  /** The transport's own centre line. */
  SONG_TRANSPORT_BOTTOM_PX: 150,
  /**
   * The lens picker's baseline: how the song is being drawn, not what it is.
   *
   * Paired with the quiet line under it rather than hung off the transport. The
   * foot reads as three groups — the name and its recipe, the transport, then
   * the two lines of small capitals — and a picker sitting closer to the
   * buttons than to the line it belongs with made the transport look like a
   * four-row control.
   */
  SONG_LENS_BOTTOM_PX: 66,
  /**
   * The last quiet line — `DETAIL`, and what the phone has of the audio.
   *
   * Close under the picker, because the two are a pair: both are lines of small
   * capitals about the song rather than parts of it, and the eye should take
   * them as one block. Spaced evenly between the transport and the edge they
   * read as two more rows of the control, which made the transport look four
   * rows tall.
   */
  SONG_WORDS_BOTTOM_PX: 38,
  /**
   * The side margin — `space.lg`, the app's own.
   *
   * Nothing in the player is laid out *from* it any more; it is the column the
   * name is cut to, so a long title stops where every other margin does.
   */
  SONG_FOOT_SIDE_PX: 24,
  /** Where the clock sits: above the ring, as a fraction of the view's height. */
  SONG_ELAPSED_TOP_RATIO: 0.13,
  /** Air between one quiet word and the next. */
  SONG_WORD_GAP_PX: 24,
  /**
   * KNOBS — the transport, which is buttons rather than words.
   *
   * Under the name rather than under the picture. The screen reads as one
   * sentence that way — this is what it looks like, this is what it is called,
   * this is what you can do to it — and the controls end up lowest, which is
   * where a thumb already is. Between the circle and the name they sat in the
   * middle of the screen with the name below them, so the only thing you could
   * press was the furthest thing from your hand.
   */
  /** Centre to centre, from one button to the next. */
  SONG_TRANSPORT_GAP_PX: 64,
  /** The play/pause silhouette's box — the one you look for, so the largest. */
  SONG_TRANSPORT_PLAY_PX: 28,
  /** The step silhouettes' box, quieter than the verb between them. */
  SONG_TRANSPORT_STEP_PX: 19,
  /**
   * The finger's target around any of the three.
   *
   * Larger than the gap would allow if the boxes were square-packed, which is
   * why they are laid out from centres and not from edges: `touch.min` is 44
   * and the gap is 64, so three targets of this size sit side by side with air
   * between them.
   */
  SONG_TRANSPORT_HIT_PX: 56,
  /**
   * KNOBS — seeking, which happens on the ring.
   *
   * There is no rule under the recipe any more. The ring *is* the timeline —
   * the design says so outright — and a straight bar drawn under it was the
   * same fact told twice, in a place where it read as a divider rather than as
   * a control. So the circle is what you drag.
   */
  /** How near the centre a finger stops meaning an angle at all. */
  SONG_SEEK_DEAD_ZONE_RATIO: 0.18,
  /**
   * How far out a drag still counts, as a fraction of the player's radius.
   *
   * One, which is exactly the measurement's own reach: the ticks stand on the
   * arc at `SONG_ARC_RATIO` and grow by `SONG_WAVE_REACH_RATIO` of the radius,
   * so at full amplitude the drawing ends a shade inside this. A target that
   * stopped short of the ticks would leave the loudest part of the circle
   * unpressable, and one much past them is a control in blank space.
   */
  SONG_SEEK_REACH_RATIO: 1,
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
 * Where the name's first letter sits at the row's pose.
 *
 * `nameLens`'s own offset, so the name the native renderer writes and the name
 * the picture draws are in the same place.
 */
export function rowTitleOriginPx(): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
    y: NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
  };
}

/**
 * The player's own axis: the one vertical line every part of it hangs off.
 *
 * Zero, because the mark *is* the axis — the camera is centred on it at L2, so
 * the song's point and the middle of the view are the same x. Written as a
 * function rather than as the literal it returns because it is the claim the
 * whole layout rests on, and a reader who finds a bare `0` in six places has
 * to rediscover why six times.
 *
 * The player used to be two layouts on one screen: the clock, the circle and
 * the transport centred, and the name, the recipe and the words hard against
 * the left margin. Nothing named the seam and there was no reason for it — the
 * left column was inherited from the row, where a name has to start at a fixed
 * offset because a face sits beside it. The player has no face beside its name.
 *
 * Anything centred on this takes its own measured width and steps back half of
 * it. `songPose` deliberately does not do the stepping: measuring a line needs
 * a font, a font needs a runtime that has one, and this file is numbers a
 * worklet can hold. So it says where the axis is, and the drawing says how
 * wide the thing standing on it is.
 */
export function songAxisPx(): number {
  'worklet';
  return 0;
}

/** The baseline of one foot row, measured up from the bottom edge. */
function footRowPx(viewport: PoseViewport, bottomPx: number): number {
  'worklet';
  return viewport.height / 2 - bottomPx;
}

export function songTitleOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: songAxisPx(),
    y: footRowPx(viewport, PLAYER_POSE_KNOBS.SONG_TITLE_BOTTOM_PX),
  };
}

/** The recipe, one line under the name. */
export function songMetaOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: songAxisPx(),
    y: footRowPx(viewport, PLAYER_POSE_KNOBS.SONG_META_BOTTOM_PX),
  };
}

/** The last quiet line, under the lens picker. */
export function songWordsOriginPx(
  viewport: PoseViewport,
): Readonly<{ x: number; y: number }> {
  'worklet';
  return {
    x: songAxisPx(),
    y: footRowPx(viewport, PLAYER_POSE_KNOBS.SONG_WORDS_BOTTOM_PX),
  };
}

/**
 * One transport button: where its silhouette is centred, and how big it is.
 *
 * The same shape of answer `playerWords` gives for the foot, and for the same
 * reason: the canvas draws these and an invisible React Native layer catches
 * them, so both sides have to come from one measurement or the glyph and its
 * button drift apart. This is the only place either side computes an x.
 *
 * Mark-relative, like everything else in this file — see `transportScreenPx`
 * for the translation the touch layer makes.
 */
export type TransportSeat = Readonly<{
  key: 'previous' | 'playPause' | 'next';
  /** The centre of the silhouette, not a corner: the boxes differ in size. */
  x: number;
  y: number;
  size: number;
}>;

/**
 * The three seats, in reading order, centred on the song's own axis.
 *
 * Centred rather than laid out left to right because the transport is one
 * object with a middle: the verb is in the middle, the two steps are either
 * side of it, and a person's thumb finds the middle of the screen without
 * looking. Written as a row of boxes it would have to be re-centred by hand
 * every time one of the three changed size.
 */
export function transportSeatsPx(
  viewport: PoseViewport,
): readonly TransportSeat[] {
  'worklet';
  const knobs = PLAYER_POSE_KNOBS;
  const y = footRowPx(viewport, knobs.SONG_TRANSPORT_BOTTOM_PX);
  return [
    {
      key: 'previous',
      x: -knobs.SONG_TRANSPORT_GAP_PX,
      y,
      size: knobs.SONG_TRANSPORT_STEP_PX,
    },
    { key: 'playPause', x: 0, y, size: knobs.SONG_TRANSPORT_PLAY_PX },
    {
      key: 'next',
      x: knobs.SONG_TRANSPORT_GAP_PX,
      y,
      size: knobs.SONG_TRANSPORT_STEP_PX,
    },
  ];
}

/**
 * The same three seats in *screen* pixels, for the layer that catches fingers.
 *
 * The same translation `playerFootScreenPx` makes, and it holds for the same
 * reason: the camera is centred on the mark at L2, so the mark's point *is* the
 * middle of the view, which is the only distance at which any of this is
 * pressable anyway.
 */
export function transportScreenPx(
  viewport: PoseViewport,
): readonly TransportSeat[] {
  return transportSeatsPx(viewport).map(seat => ({
    ...seat,
    x: viewport.width / 2 + seat.x,
    y: viewport.height / 2 + seat.y,
  }));
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
): Readonly<{ axisX: number; y: number }> {
  return {
    axisX: viewport.width / 2 + songAxisPx(),
    y: viewport.height / 2 + songWordsOriginPx(viewport).y,
  };
}

/**
 * The ring's own centre and reach in *screen* pixels, for the seek gesture.
 *
 * The ring is the timeline, so seeking is an angle about this point rather than
 * a distance along a bar. Both numbers come from the same two knobs the drawing
 * uses — `playerRisePx` at full arrival and `playerRadiusPx` — because a finger
 * that means one angle to the gesture and another to the drawing is a scrub
 * that jumps the moment you touch it.
 *
 * `inner` and `outer` bound where a drag counts at all. Inside `inner` an angle
 * is meaningless — a millimetre of travel across the centre sweeps half the
 * song — and outside `outer` the finger has left the control.
 */
export function playerSeekScreenPx(
  viewport: PoseViewport,
): Readonly<{ cx: number; cy: number; inner: number; outer: number }> {
  'worklet';
  const radius = playerRadiusPx(viewport.width);
  return {
    cx: viewport.width / 2 + songAxisPx(),
    cy: viewport.height / 2 - playerRisePx(viewport.height, 1),
    inner: radius * PLAYER_POSE_KNOBS.SONG_SEEK_DEAD_ZONE_RATIO,
    outer: radius * PLAYER_POSE_KNOBS.SONG_SEEK_REACH_RATIO,
  };
}

/**
 * Where a finger on the ring falls through the song, 0..1 — or null for a
 * touch that is not on it.
 *
 * Measured from twelve o'clock, clockwise, because that is where the arc is
 * drawn from and the direction the hand turns: `PlayerRing` builds its arc at
 * `-90` degrees over `360`, and the same quarter-turn is subtracted here. Two
 * definitions of "the top" would put the playhead a quarter of a song away from
 * the finger that placed it.
 */
export function seekFractionAt(
  viewport: PoseViewport,
  x: number,
  y: number,
): number | null {
  'worklet';
  const ring = playerSeekScreenPx(viewport);
  const dx = x - ring.cx;
  const dy = y - ring.cy;
  const reach = Math.sqrt(dx * dx + dy * dy);
  if (reach < ring.inner || reach > ring.outer) return null;
  const turn = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2);
  return turn - Math.floor(turn);
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
 * Its own row in the foot's rhythm rather than a sum of the name's height and
 * two margins. It was derived that way because the picker was laid out when the
 * foot was React's and the name was the only thing it had to clear; now that
 * every row in the foot is a distance off the bottom edge, being one of them is
 * both simpler and the only way the spacing stays even when a row moves.
 */
export function playerLensBottomPx(): number {
  return PLAYER_POSE_KNOBS.SONG_LENS_BOTTOM_PX;
}
