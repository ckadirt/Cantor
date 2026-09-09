import React, { useMemo } from 'react';
import {
  Group as SkiaGroup,
  Path,
  Skia,
  Text,
  type SkFont,
  type SkPath,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { NAME_LENS_KNOBS, fitText } from '../../lenses';
import { buildGlyphMorphPaths } from '../../motion/glyphs';
import { useSeededPathInterpolation } from '../../motion/MorphText';
import { layoutText } from '../../motion/text';
import {
  PLAYER_POSE_KNOBS,
  lineOwnedByPlayer,
  playerRadiusPx,
  rowTitleOriginPx,
  songMetaOriginPx,
  songTitleColumnPx,
  songTitleOriginPx,
  songWordsOriginPx,
  transportSeatsPx,
  type PoseViewport,
  type TransportSeat,
} from './songPose';
import type { FieldPresentation } from './useFieldController';

/** KNOBS — the ring, in fractions of the player's own radius. */
export const PLAYER_RING_KNOBS = {
  SONG_WAVE_TICKS: 96,
  /**
   * The ceiling on that count once the axis opens; see `drawSongDetail`.
   *
   * The tick count grows with the zoom so the *screen* spacing holds still
   * while the axis closes on the playhead. This bounds it: reached at a spread
   * of about twelve, which is where L3 begins and where the decoded detail has
   * taken the drawing over. Past it more ticks would be an upsample of
   * thirty-two numbers, paid for on every frame.
   */
  SONG_WAVE_MAX_TICKS: 1200,
  SONG_WAVE_REACH_RATIO: 0.36,
  SONG_WAVE_WIDTH_PX: 1.5,
  SONG_WAVE_ALPHA: 0.55,
  /** Music sits at 0.1–0.3 RMS; the wave lens takes the same fixed gain. */
  SONG_WAVE_GAIN: 2.6,
  /**
   * The beat: how far either side of the playhead the lift reaches, in turns,
   * and how tall it grows at its centre.
   */
  SONG_PULSE_WINDOW: 0.5,
  SONG_PULSE_GAIN: 1.6,
  SONG_ARC_WIDTH_PX: 1.5,
  /** The hand, from near the centre out to the waveform's baseline. */
  SONG_HAND_INNER_RATIO: 0.12,
  SONG_HAND_OUTER_RATIO: 0.5,
  SONG_HAND_WIDTH_PX: 1,
  /**
   * How long the measurement takes to draw itself on, once you have arrived.
   *
   * The ring is the one part of the player that is not a pose of something you
   * were already looking at. The face grew out of the mark, the name and the
   * recipe travelled from the row — but a row has no waveform, so there is
   * nothing for this to come *from*, and the honest gesture is the same one the
   * name gets one level down: it is written on.
   *
   * It waits for the descent rather than riding it. Every other part of the
   * player is written against the camera, so a measurement drawing itself
   * *during* the flight would be one more thing moving in a frame that already
   * has the face growing, the ring blooming and two lines morphing in it. Held
   * until the camera settles, it is the last thing to happen and it has the
   * frame to itself.
   */
  SONG_WAVE_DRAW_MS: 900,
} as const;

/**
 * KNOBS — the transport's silhouettes, in fractions of each button's own box.
 *
 * Proportions rather than pixels, because `songPose` owns the sizes and this
 * owns the shapes: change `SONG_TRANSPORT_PLAY_PX` and everything below scales
 * with it, which is what makes one drawing work at any box.
 */
export const PLAYER_TRANSPORT_KNOBS = {
  /** The play triangle's width, as a fraction of its height. */
  PLAY_ASPECT: 0.88,
  /** One pause bar's width, and the air between the two, over the box. */
  PAUSE_BAR_RATIO: 0.3,
  PAUSE_GAP_RATIO: 0.26,
  /** The step glyph: its triangle, then the bar it runs into. */
  STEP_TRIANGLE_RATIO: 0.62,
  STEP_BAR_RATIO: 0.16,
  /**
   * How long play takes to become pause.
   *
   * Short, and it has to be: this is the one control a person presses over and
   * over, and a morph they can outrun reads as lag rather than as motion. Long
   * enough to see the triangle open, and no longer.
   */
  MORPH_MS: 240,
  /** How quietly a step is drawn while there is no queue for it to step through. */
  INERT_ALPHA: 0.4,
} as const;

/**
 * Play and pause as one drawing at two poses.
 *
 * The triangle is cut down its own middle into two quads, and each quad is a
 * bar. That is the whole morph: four points travel to four points on each side,
 * in the same order, so the slanted edges straighten and the halves part. No
 * crossfade, no second symbol appearing over the first — the house rule for
 * compound silhouettes, applied to the smallest one in the app.
 *
 * Both paths are emitted with exactly the same verbs — two contours of
 * `moveTo` and three `lineTo`, each closed — because `interpolatePaths` walks
 * points pairwise and answers null for anything else. The apex is emitted
 * *twice* in the play pose for that reason: it is the one point that has to
 * become two, and a triangle written as three points could not be interpolated
 * with a rectangle written as four.
 *
 * Both are centred on `cx, cy` rather than on the origin, so the caller needs
 * no transform node per button and the two poses cannot be centred differently.
 */
export function playPauseSilhouettes(
  cx: number,
  cy: number,
  size: number,
): Readonly<{ play: SkPath; pause: SkPath }> {
  const knobs = PLAYER_TRANSPORT_KNOBS;
  const half = size / 2;
  const playHalfWidth = (size * knobs.PLAY_ASPECT) / 2;
  const bar = size * knobs.PAUSE_BAR_RATIO;
  const gap = size * knobs.PAUSE_GAP_RATIO;

  const play = Skia.PathBuilder.Make();
  // The left half: top-left, the cut's top, the cut's foot, bottom-left.
  quad(play, [
    [cx - playHalfWidth, cy - half],
    [cx, cy - half / 2],
    [cx, cy + half / 2],
    [cx - playHalfWidth, cy + half],
  ]);
  // The right half, read in the same order: the apex stands in for both of the
  // bar's right-hand corners.
  quad(play, [
    [cx, cy - half / 2],
    [cx + playHalfWidth, cy],
    [cx + playHalfWidth, cy],
    [cx, cy + half / 2],
  ]);

  const pause = Skia.PathBuilder.Make();
  quad(pause, [
    [cx - gap / 2 - bar, cy - half],
    [cx - gap / 2, cy - half],
    [cx - gap / 2, cy + half],
    [cx - gap / 2 - bar, cy + half],
  ]);
  quad(pause, [
    [cx + gap / 2, cy - half],
    [cx + gap / 2 + bar, cy - half],
    [cx + gap / 2 + bar, cy + half],
    [cx + gap / 2, cy + half],
  ]);

  return { play: play.detach(), pause: pause.detach() };
}

/**
 * A step: the triangle, and the bar it runs into.
 *
 * `direction` is +1 for the next song and −1 for the one before it — a mirror
 * rather than a second drawing, because they are the same glyph facing two
 * ways and writing them twice is how the two drift apart.
 */
export function stepSilhouette(
  cx: number,
  cy: number,
  size: number,
  direction: 1 | -1,
): SkPath {
  const knobs = PLAYER_TRANSPORT_KNOBS;
  const half = size / 2;
  const triangle = size * knobs.STEP_TRIANGLE_RATIO;
  const bar = size * knobs.STEP_BAR_RATIO;
  const left = (-(triangle + bar) / 2) * direction;
  const apex = left + triangle * direction;
  const edge = apex + bar * direction;

  const builder = Skia.PathBuilder.Make();
  builder.moveTo(cx + left, cy - half);
  builder.lineTo(cx + apex, cy);
  builder.lineTo(cx + left, cy + half);
  builder.close();
  quad(builder, [
    [cx + apex, cy - half],
    [cx + edge, cy - half],
    [cx + edge, cy + half],
    [cx + apex, cy + half],
  ]);
  return builder.detach();
}

/** One closed four-point contour, appended to a builder. */
function quad(
  builder: ReturnType<typeof Skia.PathBuilder.Make>,
  points: readonly (readonly [number, number])[],
): void {
  builder.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) {
    builder.lineTo(points[index][0], points[index][1]);
  }
  builder.close();
}

/**
 * The player's ring, drawn about its own origin.
 *
 * Origin-drawn on purpose: the caller owns where this sits. The recorded-picture
 * path hangs it off the viewport's centre, and the native path hangs it off the
 * song's own mark inside `NativePlacementFlight`, which is what keeps the ring
 * concentric with the face it grew out of on every frame of the way in. Before
 * this was one component the two anchors were written twice and agreed only
 * where the camera happened to be exactly centred.
 *
 * Nothing here answers to a React render. The waveform is rebuilt per frame
 * from one array of numbers — that is the beat riding the playhead — and the
 * arc and the hand are a trim and a rotation of paths that are never rebuilt.
 */
export function PlayerRing({
  radius,
  durationSeconds,
  positionSeconds,
  colour,
}: {
  radius: number;
  durationSeconds: number;
  positionSeconds: SharedValue<number>;
  colour: string;
}) {
  const knobs = PLAYER_RING_KNOBS;
  const arcRadius = radius * PLAYER_POSE_KNOBS.SONG_ARC_RATIO;

  const ring = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    builder.addArc(
      Skia.XYWHRect(-arcRadius, -arcRadius, arcRadius * 2, arcRadius * 2),
      -90,
      360,
    );
    return builder.detach();
  }, [arcRadius]);

  const hand = useMemo(() => {
    const builder = Skia.PathBuilder.Make();
    builder.moveTo(0, -radius * knobs.SONG_HAND_INNER_RATIO);
    builder.lineTo(0, -radius * knobs.SONG_HAND_OUTER_RATIO);
    return builder.detach();
  }, [knobs, radius]);

  const fraction = useDerivedValue(() => {
    if (durationSeconds <= 0) return 0;
    const value = positionSeconds.value / durationSeconds;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }, [durationSeconds]);

  const turn = useDerivedValue(() => [
    { rotate: fraction.value * Math.PI * 2 },
  ]);

  return (
    <>
      <Path
        color={colour}
        end={fraction}
        path={ring}
        start={0}
        strokeWidth={knobs.SONG_ARC_WIDTH_PX}
        style="stroke"
      />
      <SkiaGroup transform={turn}>
        <Path
          color={colour}
          path={hand}
          strokeWidth={knobs.SONG_HAND_WIDTH_PX}
          style="stroke"
        />
      </SkiaGroup>
    </>
  );
}

/** One letter on its way from the row's pose to the player's. */
export type GlyphMorph = Readonly<{ from: SkPath; to: SkPath }>;

/**
 * Everything about the player that does not answer to the camera.
 *
 * Built once per re-cut, and only for the song the camera is focused on: at any
 * distance exactly one song is the player, so this is O(1) in the size of the
 * library no matter how large the field gets. The sampling below is the reason
 * it has to be that way — `buildGlyphMorphPaths` walks both outlines of every
 * letter, which is a thing to do once when the focus changes and never on a
 * frame.
 */
export type NativeSongModel = Readonly<{
  /**
   * The name, as one interpolation per letter between its two poses.
   *
   * Null where the runtime cannot give a glyph outline — CanvasKit, which is
   * what Jest runs, has no `MakeFromText` — and the caller falls back to the
   * two strings crossfaded, which is what the player did before it was drawn
   * here at all.
   */
  titleMorph: readonly GlyphMorph[] | null;
  /** The name at the player's pose, for the fallback and for accessibility. */
  songTitle: string;
  /**
   * Where that name sits once it is here: the axis, less half its own width.
   *
   * Kept on the model rather than recomputed at the draw site because the morph
   * already ends here — measuring it twice is two chances for the fallback
   * glyphs and the morph's last frame to land in different places, which is
   * exactly the hand-off the Flicker Law is about.
   */
  titleSeat: Readonly<{ x: number; y: number }>;
  /** The recipe, which is what the row's availability line becomes. */
  metaMorph: readonly GlyphMorph[] | null;
  songMeta: string;
  metaSeat: Readonly<{ x: number; y: number }>;
  /** What is left in the foot as words: where each sits and what it says. */
  words: readonly PlayerWord[];
  /**
   * Whether the audio is already here.
   *
   * The transport is a silhouette rather than a word now, so it cannot say
   * `FETCH`; it says the same thing the field says about a song it does not
   * have, which is how firmly it is drawn. Firm ink is a song that will sound
   * the instant you press it, quiet ink is a press that starts a download —
   * the design's own three states, applied to the one control that acts on
   * them.
   */
  onPhone: boolean;
}>;

/**
 * One word in the player's foot, and the box a finger has to land in to press
 * it.
 *
 * The canvas draws these and an invisible React Native layer catches them, so
 * both have to come from one measurement or the word and its button drift apart
 * — a control that is a few pixels left of where it looks is worse than one
 * that is not there. `playerWords` is that measurement, and it is the only
 * place either side computes an x.
 */
export type PlayerWord = Readonly<{
  key: 'detail' | 'audio';
  text: string;
  x: number;
  width: number;
}>;

/**
 * The foot's words — which no longer include the transport.
 *
 * `PLAY` and `PAUSE` were words here, and the trouble with a word is that a
 * word is a *string*: pressing play changed it, a changed string rebuilt the
 * song's model, and a rebuilt model handed `Canvas` a fresh element, which
 * makes Skia stop the mapper and re-record the whole root from whatever the JS
 * thread happens to hold. A full re-record on every press of the most-pressed
 * control in the app. The transport is geometry on a shared value now — see
 * `TransportControls` — and what is left here is two labels that change only
 * when the song does.
 */
export function playerWords(
  font: SkFont,
  audioLabel: string,
): readonly PlayerWord[] {
  const words: PlayerWord[] = [];
  let x = 0;
  for (const [key, text] of [
    ['detail', 'DETAIL'],
    ['audio', audioLabel],
  ] as const) {
    // A font with no typeface measures `NaN` rather than refusing, and one NaN
    // here poisons every x after it — the words would be drawn nowhere and
    // their buttons laid out nowhere. `nameLens.textWidth` guards the same way
    // and for the same reason. Zero is the honest answer: a face that measures
    // nothing also draws nothing.
    const measured = font.measureText(text)?.width;
    const width = Number.isFinite(measured) ? measured : 0;
    words.push({ key, text, x, width });
    x += width + PLAYER_POSE_KNOBS.SONG_WORD_GAP_PX;
  }
  return words;
}

/**
 * `ACESTEP:1.5-FAST · SEED 41822` — the recipe, said once.
 *
 * The song's length used to end this line and it does not any more: a duration
 * is a fact about *playing* the song, not about the recipe that made it, and
 * the clock above the ring now says `0:14 · 1:49` where a person is already
 * looking for it. Written in both places it was the same number twice on one
 * screen, once where it belonged and once where it padded a line out.
 */
export function recipeLine(model: string, seed: number | undefined): string {
  const parts = [model.toUpperCase()];
  if (seed !== undefined) parts.push(`SEED ${seed}`);
  return parts.join(' · ');
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * What pressing the transport would do, in one word.
 *
 * Shared because the canvas draws this word and the touch layer presses it, and
 * the two arriving at different answers would be a button labelled `PLAY` that
 * pauses. A song that lives on the node is still playable — pressing fetches it
 * first — so `FETCH` is a promise about the wait, not a refusal.
 */
export function transportWord(
  isCurrent: boolean,
  playing: boolean,
  onPhone: boolean,
): string {
  if (isCurrent && playing) return 'PAUSE';
  return onPhone ? 'PLAY' : 'FETCH';
}

/** Never claim a song is here when only part of it is. */
export function describeAudio(state: FieldPresentation['localAudio']['state']): string {
  switch (state) {
    case 'pinned':
      return 'PINNED';
    case 'cached':
      return 'ON PHONE';
    case 'partial':
      return 'PARTIAL';
    default:
      return 'ON NODE';
  }
}

/**
 * One line of text morphing between two poses, letter by letter in reading
 * order.
 *
 * This is the motion engine's `transform` variant — a plain whole-object Manim
 * transform, one shared alpha, no matching cascade — reached through the same
 * `buildGlyphMorphPaths` the shelf labels use. What makes it carry a *size*
 * change as well as a shape change is that the two sides are sampled from two
 * different faces: the row's 15 px display and the player's 26 px. The letters
 * that are the same at both ends simply grow and travel, which is the whole
 * gesture; the letters a row had no room for grow out of the ellipsis that
 * stood in for them.
 */
function buildLineMorph(
  fromText: string,
  toText: string,
  fromFont: SkFont,
  toFont: SkFont,
  fromOrigin: Readonly<{ x: number; y: number }>,
  toOrigin: Readonly<{ x: number; y: number }>,
  toColumn: number,
): readonly GlyphMorph[] | null {
  if (fromText.length === 0 && toText.length === 0) return null;
  const fromBoxes = layoutText(fromText, fromFont, 0, Infinity, 0);
  const toBoxes = layoutText(toText, toFont, 0, toColumn, 0);
  const count = Math.max(fromBoxes.length, toBoxes.length);
  if (count === 0) return null;
  const morphs: GlyphMorph[] = [];
  for (let index = 0; index < count; index += 1) {
    // Past the end of either line the letter collapses into the last box it
    // had, so a name that gains letters grows them out of its own tail rather
    // than fading a second line in over the first.
    const from = fromBoxes[Math.min(index, fromBoxes.length - 1)];
    const to = toBoxes[Math.min(index, toBoxes.length - 1)];
    if (from === undefined || to === undefined) return null;
    const paths = buildGlyphMorphPaths(
      fromFont,
      { ...from, x: from.x + fromOrigin.x, y: from.y + fromOrigin.y },
      { ...to, x: to.x + toOrigin.x, y: to.y + toOrigin.y },
      toFont,
    );
    // All or nothing: half a line as outlines and half as glyphs is two
    // drawings of one name, which is the thing this whole file exists to end.
    if (paths === null) return null;
    morphs.push(paths);
  }
  return morphs;
}

/**
 * The player with nothing to have come from: every seat, no morph.
 *
 * A morph interpolates the *row's* line into the player's, so it needs a row —
 * and there is only a row where the name lens is drawing one natively. Every
 * other lens draws its own song at every distance and has no such line, so the
 * honest gesture there is the fallback `NativeSongModel` already carries for a
 * runtime with no glyph outlines: two strings, faded on the same arrival.
 *
 * Split out rather than built by passing the same string twice, because
 * `buildLineMorph` would still sample two fonts and interpolate a path per
 * letter to arrive at a morph from a line to itself.
 */
export function playerChromeModel(
  presentation: FieldPresentation,
  viewport: PoseViewport,
  fonts: Readonly<{ songTitle: SkFont; songMeta: SkFont }>,
): NativeSongModel {
  const seats = playerSeats(presentation, viewport, fonts);
  return { ...seats, titleMorph: null, metaMorph: null };
}

/** What both models share: the strings, where they sit, and what is in the foot. */
function playerSeats(
  presentation: FieldPresentation,
  viewport: PoseViewport,
  fonts: Readonly<{ songTitle: SkFont; songMeta: SkFont }>,
): Omit<NativeSongModel, 'titleMorph' | 'metaMorph'> {
  const song = presentation.song;
  const songTitle = fitText(
    song.title,
    fonts.songTitle,
    songTitleColumnPx(viewport.width),
  );
  const songMeta = recipeLine(song.model, song.seed);
  return {
    songTitle,
    titleSeat: centredOnAxis(
      songTitle,
      fonts.songTitle,
      songTitleOriginPx(viewport),
    ),
    songMeta,
    metaSeat: centredOnAxis(
      songMeta,
      fonts.songMeta,
      songMetaOriginPx(viewport),
    ),
    words: playerWords(
      fonts.songMeta,
      describeAudio(presentation.localAudio.state),
    ),
    onPhone:
      presentation.localAudio.state === 'cached' ||
      presentation.localAudio.state === 'pinned',
  };
}

export function nativeSongModel(
  presentation: FieldPresentation,
  viewport: PoseViewport,
  rowTitle: string,
  rowMeta: string,
  rowActionWidthPx: number,
  fonts: Readonly<{
    rowTitle: SkFont;
    songTitle: SkFont;
    rowMeta: SkFont;
    songMeta: SkFont;
  }>,
): NativeSongModel {
  /*
   * Both lines arrive centred, so both morphs *end* centred.
   *
   * That is the whole of what makes the new layout a gesture rather than a
   * different screen: a row's name starts at a fixed offset because a face sits
   * beside it, and the player has no face beside its name — so the letters
   * gather to the middle as you arrive, on the same clock they were already
   * growing on. Nothing here fades; the destination moved.
   *
   * The morphs end at `seats`' own seats rather than at seats measured again
   * here. Measuring twice is two chances for the morph's last frame and the
   * fallback glyphs to land in different places, which is the hand-off the
   * Flicker Law is about — and it is the reason the seats are on the model in
   * the first place.
   */
  const seats = playerSeats(presentation, viewport, fonts);
  return {
    ...seats,
    titleMorph: buildLineMorph(
      rowTitle,
      seats.songTitle,
      fonts.rowTitle,
      fonts.songTitle,
      rowTitleOriginPx(),
      seats.titleSeat,
      songTitleColumnPx(viewport.width),
    ),
    metaMorph: buildLineMorph(
      rowMeta,
      seats.songMeta,
      fonts.rowMeta,
      fonts.songMeta,
      { x: rowTitleOriginPx().x, y: NAME_LENS_KNOBS.ROW_META_BASELINE_PX },
      seats.metaSeat,
      songTitleColumnPx(viewport.width),
    ),
  };
}

/**
 * Where real glyphs have to be drawn to land where their morph does.
 *
 * A seat is a *layout box top*, not a baseline, because that is what the morph
 * reads it as: `buildLineMorph` lays the destination out with `layoutText`,
 * whose boxes carry `y = ascent` for a single line, and adds the seat to that.
 * Skia's `Text` takes a baseline. So the same seat drawn both ways lands one
 * ascent apart — 25 px for the name in CMU Serif at 26, 11 px for the recipe in
 * mono at 11 — and the two renderings of one line are not the same line.
 *
 * That mattered nowhere until the player's chrome was mounted on the picture
 * path, which has no row to morph from and so is always the `Text` branch: the
 * name and the recipe jumped an ascent the moment you changed the lens. It was
 * always a hazard on the native path too, between a morph and the fallback it
 * turns into when the runtime cannot give an outline — the seats are on the
 * model precisely so that the two land in the same place, and they did not.
 *
 * The morph's placement is the one that ships and the one the foot was tuned
 * against, so the glyphs come to it rather than the other way round.
 */
function baselineOf(
  seat: Readonly<{ x: number; y: number }>,
  font: SkFont,
): number {
  // `layoutText`'s own line: metrics report the ascent as a negative rise.
  return seat.y - font.getMetrics().ascent;
}

/**
 * A line's own origin: the axis, stepped back by half of what it measures.
 *
 * The one place the player turns a width into a position. `songPose` says
 * where the axis is and refuses to measure — it is numbers a worklet can hold,
 * and measuring needs a font — so this is the seam between the two, and every
 * centred line goes through it rather than doing the arithmetic itself.
 */
function centredOnAxis(
  text: string,
  font: SkFont,
  origin: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  // A font with no typeface measures `NaN` rather than refusing, and a NaN x
  // draws the line nowhere at all. The axis is the honest fallback: a line
  // that cannot be measured is at least still on the page. `playerWords`
  // guards the same way and for the same reason.
  const measured = font.measureText(text)?.width;
  const width = Number.isFinite(measured) ? measured : 0;
  return { x: origin.x - width / 2, y: origin.y };
}

/** One morphing line, as paths the UI thread interpolates and nothing else. */
function MorphLine({
  morphs,
  progress,
  own,
  colour,
}: {
  morphs: readonly GlyphMorph[];
  progress: DerivedValue<number>;
  /**
   * Whether this line is the one being drawn, as a step.
   *
   * The exact complement of the row's own `rowTitleInk`. Both are steps at the
   * same threshold and they are never both 1: at `progress = 0` the morph's
   * geometry *is* the row's line, in the same place from the same font, so
   * leaving it mounted and visible there would draw one name twice at full
   * weight and read as a focused row set in a heavier face. Below the song band
   * the row owns its line; from the instant the band opens the morph does, and
   * the frame they change hands on is the same pixels either way.
   */
  own: DerivedValue<number>;
  colour: string;
}) {
  return (
    <SkiaGroup opacity={own}>
      {morphs.map((morph, index) => (
        <MorphGlyph
          key={index}
          morph={morph}
          progress={progress}
          colour={colour}
        />
      ))}
    </SkiaGroup>
  );
}

function MorphGlyph({
  morph,
  progress,
  colour,
}: {
  morph: GlyphMorph;
  progress: DerivedValue<number>;
  colour: string;
}) {
  // The engine's own hook, not a plain derived value: an interpolated path has
  // to `notifyChange` or the canvas is never told the geometry moved, and the
  // seeding is what stops a freshly mounted generation painting nothing for a
  // frame. See its note in `MorphText`.
  const path = useSeededPathInterpolation(progress, morph.from, morph.to);
  return <Path path={path} color={colour} style="fill" fillType="evenOdd" />;
}

/**
 * The transport: three silhouettes, and the one of them that is a verb.
 *
 * Drawn here rather than laid out in React for the reason the whole player is —
 * "Nothing that moves with the camera may be laid out in React". It arrives on
 * the chrome band with the words, and the play/pause morph runs on a shared
 * value, so pressing it moves geometry on the UI thread and never touches a
 * React commit. That is what makes the gesture survive being pressed twice in
 * a row: a retarget is `withTiming` picking up wherever the last one had got
 * to, which is the mid-morph interrupt the motion rules ask for, for free.
 *
 * The steps are drawn quiet and are not pressable. There is no queue in Cantor
 * — the shelf's order *is* the order, and nothing auto-advances — so there is
 * nothing for a step to step to yet. Drawing them anyway is the honest half of
 * that: the transport's shape is settled, and the day the shelf can hand the
 * player a neighbour these light up without moving.
 */
export function TransportControls({
  viewport,
  playing,
  onPhone,
  colour,
  mutedColour,
}: {
  viewport: PoseViewport;
  /**
   * How far through the play-to-pause morph the verb is, 0..1.
   *
   * A shared value rather than a boolean prop: a boolean is a React commit, and
   * a React commit re-records this canvas. See `playerWords`.
   */
  playing: SharedValue<number> | null;
  onPhone: boolean;
  colour: string;
  mutedColour: string;
}) {
  const seats = useMemo(() => transportSeatsPx(viewport), [viewport]);
  const steps = useMemo(
    () =>
      seats
        .filter(seat => seat.key !== 'playPause')
        .map(seat => ({
          key: seat.key,
          path: stepSilhouette(
            seat.x,
            seat.y,
            seat.size,
            seat.key === 'next' ? 1 : -1,
          ),
        })),
    [seats],
  );
  const verb = seats.find(seat => seat.key === 'playPause');
  return (
    <>
      {steps.map(step => (
        <Path
          color={mutedColour}
          fillType="evenOdd"
          key={step.key}
          opacity={PLAYER_TRANSPORT_KNOBS.INERT_ALPHA}
          path={step.path}
          style="fill"
        />
      ))}
      {verb === undefined ? null : (
        <TransportVerb
          colour={onPhone ? colour : mutedColour}
          playing={playing}
          seat={verb}
        />
      )}
    </>
  );
}

/** The one button that changes shape, and the only thing that knows it does. */
function TransportVerb({
  seat,
  playing,
  colour,
}: {
  seat: TransportSeat;
  playing: SharedValue<number> | null;
  colour: string;
}) {
  const shapes = useMemo(
    () => playPauseSilhouettes(seat.x, seat.y, seat.size),
    [seat.size, seat.x, seat.y],
  );
  /*
   * A held zero where there is no clock to read.
   *
   * The player draws for whichever song the camera arrived at, and only the one
   * the *port* holds has a transport state at all. Without a value of its own
   * the hook below would have nothing to seed from — and a hook cannot be
   * called conditionally, so the fallback is a value rather than a branch.
   */
  const idle = useSharedValue(0);
  const path = useSeededPathInterpolation(
    playing ?? idle,
    shapes.play,
    shapes.pause,
  );
  return <Path color={colour} fillType="evenOdd" path={path} style="fill" />;
}

/**
 * The player, hung off the song's own mark.
 *
 * `arrived` is the song band read from the live camera — the same number the
 * face's third pose is written against — so every part of this arrives on the
 * frame it is supposed to, not on the frame React managed to commit. That is
 * the whole of what was wrong before: the ring answered to the camera and the
 * chrome answered to React's copy of it, and the two cannot agree because the
 * copy lands a commit late by design.
 */
export function NativePlayerParts({
  model,
  arrived,
  named,
  anchor,
  viewport,
  durationSeconds,
  positionSeconds,
  transportPlaying,
  colour,
  mutedColour,
  songTitleFont,
  songMetaFont,
}: {
  model: NativeSongModel;
  /**
   * How present the player is: the crossfade band. Opacity, and nothing else —
   * where a thing *is* comes from the two arrivals, which move on the camera's
   * own clock rather than on a band's.
   */
  arrived: DerivedValue<number>;
  /** How far the name and the recipe have travelled to the foot. */
  named: DerivedValue<number>;
  /**
   * The player's centre: the face's own pose, so the ring grows out of the
   * contour rather than merely arriving at the same place it does.
   */
  anchor: DerivedValue<Transforms3d>;
  viewport: PoseViewport;
  durationSeconds: number;
  positionSeconds: SharedValue<number> | null;
  /** The play-to-pause morph, 0..1, or null when this song is not the current one. */
  transportPlaying: SharedValue<number> | null;
  colour: string;
  mutedColour: string;
  songTitleFont: SkFont;
  songMetaFont: SkFont;
}) {
  const radius = playerRadiusPx(viewport.width);
  /**
   * The words arrive after the drawing does.
   *
   * They have no pose at L1 — a row has no transport — so unlike the name and
   * the recipe there is nothing for them to come *from*, and the honest gesture
   * is arrival rather than transformation. Held back until the band is most of
   * the way open so they land on a player that is already there.
   */
  const chrome = useDerivedValue(() => {
    const t = (named.value - 0.6) / 0.4;
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  });
  /** The step the row's own ink is the complement of; see `MorphLine`. */
  const owned = useDerivedValue<number>(() => lineOwnedByPlayer(named.value));
  /*
   * The quiet line's own left edge: the axis, less half the width of the whole
   * run. `playerWords` lays the words out from zero, so the run is as wide as
   * its last word's right edge — measured once here rather than by every word.
   */
  const foot = useMemo(() => {
    const origin = songWordsOriginPx(viewport);
    const last = model.words[model.words.length - 1];
    const run = last === undefined ? 0 : last.x + last.width;
    return { x: origin.x - run / 2, y: origin.y };
  }, [model.words, viewport]);
  return (
    <>
      <SkiaGroup opacity={arrived} transform={anchor}>
        {positionSeconds === null ? null : (
          <PlayerRing
            colour={colour}
            durationSeconds={durationSeconds}
            positionSeconds={positionSeconds}
            radius={radius}
          />
        )}
      </SkiaGroup>
      {model.titleMorph === null ? (
        <SkiaGroup opacity={named}>
          <Text
            color={colour}
            font={songTitleFont}
            text={model.songTitle}
            x={model.titleSeat.x}
            y={baselineOf(model.titleSeat, songTitleFont)}
          />
        </SkiaGroup>
      ) : (
        <MorphLine
          colour={colour}
          morphs={model.titleMorph}
          own={owned}
          progress={named}
        />
      )}
      {model.metaMorph === null ? (
        <SkiaGroup opacity={named}>
          <Text
            color={mutedColour}
            font={songMetaFont}
            text={model.songMeta}
            x={model.metaSeat.x}
            y={baselineOf(model.metaSeat, songMetaFont)}
          />
        </SkiaGroup>
      ) : (
        <MorphLine
          colour={mutedColour}
          morphs={model.metaMorph}
          own={owned}
          progress={named}
        />
      )}
      {/*
        No rule under the recipe.

        There was one, and it was the same fact the ring already tells: the
        design settles that "progress *is* the ring, so the timeline is already
        a circle". Drawn again as a straight bar the width of the view, under a
        line of small capitals, it did not read as a timeline at all — it read
        as a divider between the recipe and the words. Seeking is a drag around
        the circle now; see `seekFractionAt`.
      */}
      <SkiaGroup opacity={chrome}>
        {model.words.map(word => (
          <Text
            color={mutedColour}
            font={songMetaFont}
            key={word.key}
            text={word.text}
            x={foot.x + word.x}
            y={foot.y}
          />
        ))}
        <TransportControls
          colour={colour}
          mutedColour={mutedColour}
          onPhone={model.onPhone}
          playing={transportPlaying}
          viewport={viewport}
        />
      </SkiaGroup>
    </>
  );
}
