import React, { useMemo } from 'react';
import {
  Group as SkiaGroup,
  Path,
  Rect,
  Skia,
  Text,
  type SkFont,
  type SkPath,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
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
  songScrubOriginPx,
  songTitleColumnPx,
  songTitleOriginPx,
  songWordsOriginPx,
  type PoseViewport,
} from './songPose';
import type { FieldPresentation } from './useFieldController';

/** How quietly the unplayed part of the rule is drawn. */
const SCRUB_TRACK_ALPHA = 0.35;

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
  /** The recipe, which is what the row's availability line becomes. */
  metaMorph: readonly GlyphMorph[] | null;
  songMeta: string;
  /** The transport, as words in the foot: where each sits and what it says. */
  words: readonly PlayerWord[];
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
  key: 'transport' | 'detail' | 'audio';
  text: string;
  x: number;
  width: number;
}>;

export function playerWords(
  font: SkFont,
  transportLabel: string,
  audioLabel: string,
): readonly PlayerWord[] {
  const words: PlayerWord[] = [];
  let x = 0;
  for (const [key, text] of [
    ['transport', transportLabel],
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

/** `ACESTEP:1.5-FAST · SEED 41822 · 3:12` — the recipe, said once. */
export function recipeLine(
  model: string,
  seed: number | undefined,
  durationMs: number,
): string {
  const parts = [model.toUpperCase()];
  if (seed !== undefined) parts.push(`SEED ${seed}`);
  parts.push(formatClock(durationMs / 1000));
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
  transportLabel: string,
): NativeSongModel {
  const song = presentation.song;
  const songTitle = fitText(
    song.title,
    fonts.songTitle,
    songTitleColumnPx(viewport.width),
  );
  const songMeta = recipeLine(song.model, song.seed, song.duration_ms);
  return {
    titleMorph: buildLineMorph(
      rowTitle,
      songTitle,
      fonts.rowTitle,
      fonts.songTitle,
      rowTitleOriginPx(),
      songTitleOriginPx(viewport),
      songTitleColumnPx(viewport.width),
    ),
    songTitle,
    metaMorph: buildLineMorph(
      rowMeta,
      songMeta,
      fonts.rowMeta,
      fonts.songMeta,
      { x: rowTitleOriginPx().x, y: NAME_LENS_KNOBS.ROW_META_BASELINE_PX },
      songMetaOriginPx(viewport),
      songTitleColumnPx(viewport.width),
    ),
    songMeta,
    words: playerWords(
      fonts.songMeta,
      transportLabel,
      describeAudio(presentation.localAudio.state),
    ),
  };
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
  const foot = useMemo(() => songWordsOriginPx(viewport), [viewport]);
  const scrub = useMemo(() => songScrubOriginPx(viewport), [viewport]);
  const column = songTitleColumnPx(viewport.width);
  const playhead = useDerivedValue(() => {
    if (durationSeconds <= 0 || positionSeconds === null) return 0;
    const at = positionSeconds.value / durationSeconds;
    return column * (at < 0 ? 0 : at > 1 ? 1 : at);
  }, [column, durationSeconds]);
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
            x={songTitleOriginPx(viewport).x}
            y={songTitleOriginPx(viewport).y}
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
            x={songMetaOriginPx(viewport).x}
            y={songMetaOriginPx(viewport).y}
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
      <SkiaGroup opacity={chrome}>
        {/*
          The coarse rule. The ring is the timeline and this is the ruler under
          it: `SCRUB_STEP_SECONDS` at L2, and the sample-exact scrub at L3.
        */}
        <Rect
          color={mutedColour}
          height={PLAYER_POSE_KNOBS.SONG_SCRUB_HEIGHT_PX}
          opacity={SCRUB_TRACK_ALPHA}
          width={songTitleColumnPx(viewport.width)}
          x={scrub.x}
          y={scrub.y}
        />
        <Rect
          color={colour}
          height={PLAYER_POSE_KNOBS.SONG_SCRUB_HEIGHT_PX}
          width={playhead}
          x={scrub.x}
          y={scrub.y}
        />
        {model.words.map(word => (
          <Text
            color={word.key === 'transport' ? colour : mutedColour}
            font={songMetaFont}
            key={word.key}
            text={word.text}
            x={foot.x + word.x}
            y={foot.y}
          />
        ))}
      </SkiaGroup>
    </>
  );
}
