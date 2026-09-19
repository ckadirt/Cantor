import { WAVE_GEOMETRY_KNOBS } from '../../lenses/cantorWaveGeometry';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import type { LocalAudioState } from '../../audio/native';
import {
  describeAudio,
  formatClock,
  playerWords,
  transportWord,
  type PlayerWord,
} from '../field/NativePlayer';
import {
  PLAYER_POSE_KNOBS,
  playerFootScreenPx,
  playerLensBottomPx,
  playerSeekScreenPx,
  seekFractionAt,
  transportScreenPx,
  type TransportSeat,
} from '../field/songPose';
import { REPRESENTATION_WINDOWS, bandAlphaAt, type Camera } from '../../field';
import { useMorphFont } from '../../motion/fonts';
import type { PlayerSnapshot } from '../../player';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS — what is left of L2 in React, in real units. */
const SONG_SURFACE_KNOBS = {
  /** How finely a drag around the ring seeks. */
  SEEK_STEP_SECONDS: 1,
  ELAPSED_SAMPLE_MS: 500, // how often the clock label reads the visual clock
  /** Where the clock sits: above the ring, which is centred on the view. */
  ELAPSED_TOP_RATIO_PCT: '13%',
  /**
   * Air *beside* a word, so a five-letter target is still a target.
   *
   * Sideways only. The box is already `touch.min` tall — taller than a finger
   * needs — and the vertical pad was pure encroachment: it pushed the quiet
   * line's target down to 34 px off the bottom edge, into the rolled engines
   * blind sitting there, which is drawn on top. So the bottom third of
   * `DETAIL` opened the engines instead. `songFoot.test.ts` holds the gap the
   * two now keep.
   */
  WORD_HIT_PAD_PX: 12,
} as const;

export type SongSurfaceSong = Readonly<{
  key: string;
  title: string;
  model: string;
  seed: number | undefined;
  durationMs: number;
  nodeLabel: string;
  audioState: LocalAudioState;
  /**
   * How much of the delivery artifact has landed, 0..1, or null when nothing is
   * on its way. Null is not zero: see `arrivingFraction`.
   */
  arriving: number | null;
  /** Every tag; the playlists among them are named at the foot. */
  tags: readonly string[];
}>;

type Props = {
  song: SongSurfaceSong;
  lensKey?: string;
  snapshot: PlayerSnapshot;
  /** Visual position in seconds, on the UI thread. */
  positionSeconds: SharedValue<number>;
  /** True when this song is the one the player currently holds. */
  isCurrent: boolean;
  /** True when the node has a delivery artifact this song can be fetched from. */
  available: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onSeekEnd?: () => void;
  onOpenDetail: () => void;
  width: number;
  height: number;
  /** The live camera, for the one thing here that is still drawn. */
  cameraShared: SharedValue<Camera>;
  fitScale: number;
  /**
   * The lens control: one place, every level.
   *
   * A real control rather than a drawn one, and it stays that way on purpose.
   * The transport and the foot's words are drawn because they are *part of the
   * player*. A lens picker is not the song, it is a choice about how songs are
   * drawn, so it has no pose at L1 to come from and nothing is lost by leaving
   * it a button.
   */
  lens: React.ReactNode;
};

/**
 * L2's touch targets, and the one readout the canvas cannot hold.
 *
 * There is no mini-player anywhere in Cantor, and as of the third pose there is
 * no *player* here either: the song's face, its name, its recipe, its ring and
 * its transport are all drawn by `NativePlayerParts` inside the field's own
 * canvas, off the song's own mark, on the camera's own clock. What is left in
 * React is what React is still better at.
 *
 * **The words and the transport.** Skia draws them; these press them. A canvas
 * has no `accessibilityRole`, no `hitSlop` and no focus order, and hit-testing
 * a word or a silhouette in canvas space would mean re-implementing all of it
 * against the field's own pan gesture. So the boxes below are invisible, and
 * they are laid out from `playerWords` and `transportScreenPx` — the same two
 * measurements the canvas draws from — because a button a few pixels off from
 * the shape it belongs to is worse than no button.
 *
 * What a press *says* stays here too: the transport is a silhouette on the
 * canvas and a silhouette announces nothing, so `transportWord` gives the same
 * screen reader the word the drawing no longer spells out.
 *
 * **The elapsed.** It stays text because it changes twice a second, and a Skia
 * `Text` node takes a string: feeding it from React state would hand the canvas
 * a fresh element on every tick, which repaints every node from whatever the JS
 * thread last held. That is the flicker `FieldCanvas`'s scene note describes,
 * twice a second, for a number nobody is watching move. It has no pose at L1
 * either — a row has no clock — so there is nothing for it to morph out of, and
 * fading it in on the band is the honest gesture. Its opacity reads
 * `cameraShared` directly so that fade is on the same clock as everything the
 * canvas draws; the whole reason this component used to look disconnected was
 * that it read React's copy of the camera instead, which lands a commit late by
 * design.
 */
function SongSurfaceImpl({
  song,
  lensKey = 'name',
  snapshot,
  positionSeconds,
  isCurrent,
  available,
  onToggle,
  onSeek,
  onSeekEnd,
  onOpenDetail,
  width,
  height,
  cameraShared,
  fitScale,
  lens,
}: Props) {
  const pal = usePalette();
  const durationSeconds = song.durationMs / 1000;
  const metaFont = useMorphFont({
    fontFamily: font.mono,
    fontSize: type.eyebrow.fontSize,
  });

  const onPhone = song.audioState === 'cached' || song.audioState === 'pinned';
  // A song that lives on the node is still playable: pressing play fetches it
  // first. Disabling it here would disable the only path that downloads it.
  const playable = available;
  const transportLabel = transportWord(
    isCurrent,
    snapshot.state === 'playing',
    onPhone,
    song.arriving,
  );

  const foot = useMemo(
    () => playerFootScreenPx({ width, height }),
    [height, width],
  );
  const words = useMemo(
    () =>
      metaFont === null
        ? null
        : playerWords(metaFont, describeAudio(song.audioState)),
    [metaFont, song.audioState],
  );
  const transport = useMemo(
    () => transportScreenPx({ width, height }),
    [height, width],
  );
  /*
   * How wide the whole quiet line is, so the touch layer can centre it on the
   * axis exactly as the canvas does. Both sides step back half of this from
   * `axisX`; measured on one side only, the boxes would sit half a line to the
   * right of the words they belong to.
   */
  const run = useMemo(() => {
    const last = words?.[words.length - 1];
    return last === undefined ? 0 : last.x + last.width;
  }, [words]);

  const seekBox = useMemo(() => seekBoxPx({ width, height }, lensKey), [height, width, lensKey]);
  const scrub = useMemo(
    () => seekGesture({ width, height }, durationSeconds, onSeek, onSeekEnd, lensKey),
    [durationSeconds, height, onSeek, onSeekEnd, width, lensKey],
  );

  useEffect(() => () => onSeekEnd?.(), [onSeekEnd]);

  const elapsed = useElapsedLabel(
    positionSeconds,
    isCurrent && snapshot.state === 'playing',
  );
  // The song band, read from the live camera rather than from React's copy of
  // it: the same number, on the same frame, as the drawing this sits over.
  const readout = useAnimatedStyle(
    () => ({
      opacity: bandAlphaAt(
        cameraShared.value.scale,
        fitScale,
        REPRESENTATION_WINDOWS.song,
      ),
    }),
    [cameraShared, fitScale],
  );

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/*
        The clock, and the only place the song's length is written.

        It used to say the elapsed alone, and the duration padded out the end of
        the recipe line — the same number twice on one screen, once where a
        person looks for it and once where it said nothing about the recipe. One
        readout now, above the ring the position is being drawn on.
      */}
      <Animated.Text
        style={[type.eyebrow, styles.elapsed, { color: pal.ink }, readout]}>
        {`${formatClock(isCurrent ? elapsed : 0)}  ·  ${formatClock(
          durationSeconds,
        )}`}
      </Animated.Text>

      <GestureDetector gesture={scrub}>
        <View
          accessibilityLabel={`Scrub ${song.title}`}
          accessibilityRole="adjustable"
          style={[
            styles.seekHit,
            {
              height: seekBox.size,
              left: seekBox.left,
              top: seekBox.top,
              width: seekBox.size,
            },
          ]}
        />
      </GestureDetector>

      {words === null
        ? null
        : words.map(word => (
            <WordTarget
              foot={{ x: foot.axisX - run / 2, y: foot.y }}
              key={word.key}
              onPress={word.key === 'detail' ? onOpenDetail : null}
              word={word}
            />
          ))}

      {transport.map(seat => (
        <TransportTarget
          disabled={seat.key === 'playPause' && !playable}
          key={seat.key}
          label={
            seat.key === 'playPause'
              ? transportLabel
              : seat.key === 'next'
              ? 'NEXT'
              : 'PREVIOUS'
          }
          onPress={seat.key === 'playPause' ? onToggle : null}
          seat={seat}
        />
      ))}

      <Animated.View style={[styles.lens, readout]}>{lens}</Animated.View>

      {snapshot.error !== null ? (
        <Text style={[type.mono, styles.error, { color: pal.ink }]}>
          {snapshot.error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The square the seek gesture listens over: the ring's own reach, squared off.
 *
 * Exported with the gesture below because the two are one measurement — the
 * gesture receives coordinates in this box's space and has to put them back
 * into the viewport's before `seekFractionAt` can read an angle from them.
 */
export function seekBoxPx(
  viewport: Readonly<{ width: number; height: number }>,
  lensKey = 'name',
): Readonly<{ left: number; top: number; size: number }> {
  const ring = playerSeekScreenPx(viewport);
  const reach = lensKey === 'cantor-wave'
    ? Math.max(viewport.width * WAVE_GEOMETRY_KNOBS.SONG_WIDTH_RATIO,
      viewport.height * WAVE_GEOMETRY_KNOBS.SONG_HEIGHT_RATIO) / 2
    : ring.outer;
  return {
    left: ring.cx - reach,
    top: ring.cy - reach,
    size: reach * 2,
  };
}

/**
 * Seeking, as an angle about the ring.
 *
 * The ring is the timeline, so a drag around it is the scrub — one control for
 * one fact, instead of a circle that shows the position and a bar underneath
 * that sets it.
 *
 * A pure builder rather than a hook body, because the one thing about it that
 * has to be guaranteed is a piece of *configuration*, and configuration is only
 * testable if it can be built without a renderer, a font and a gesture root.
 * See `__tests__/SongSurface.test.tsx`.
 */
export function seekGesture(
  viewport: Readonly<{ width: number; height: number }>,
  durationSeconds: number,
  onSeek: (seconds: number) => void,
  onSeekEnd: () => void = () => {},
  lensKey = 'name',
) {
  const box = seekBoxPx(viewport, lensKey);
  /*
   * The gesture's coordinates are the box's and `seekFractionAt` wants the
   * viewport's, so the box's origin goes back on here. Laying the box out at
   * the ring's own bounds instead would put that offset in two places, agreeing
   * only until one of them changed.
   *
   * A touch in the dead centre or past the ring answers null and is ignored
   * rather than clamped: at the centre one pixel of travel sweeps half the
   * song, so an angle there is noise wearing the shape of an intention.
   */
  const seekTo = (x: number, y: number) => {
    const ring = playerSeekScreenPx(viewport);
    const waveWidth = viewport.width * WAVE_GEOMETRY_KNOBS.SONG_WIDTH_RATIO;
    const fraction = lensKey === 'cantor-wave'
      ? Math.max(0, Math.min(1, (box.left + x - ring.cx) / waveWidth + 0.5))
      : seekFractionAt(viewport, box.left + x, box.top + y);
    if (fraction === null) return;
    const step = SONG_SURFACE_KNOBS.SEEK_STEP_SECONDS;
    onSeek(Math.round((fraction * durationSeconds) / step) * step);
  };
  return (
    Gesture.Pan()
      /*
       * One finger, and this is load-bearing.
       *
       * The box covers the middle of the screen, and a pinch is how you *leave*
       * a song — zoom is the navigation. Left at the default a `Pan` takes one
       * to ten pointers, so it began on the first of the two fingers and
       * swallowed the pinch, and the only way out of the player was the
       * system's own back button. A pan is locked at this distance anyway, so
       * one finger over the circle can mean nothing but a seek.
       */
      .maxPointers(1)
      .onBegin(event => seekTo(event.x, event.y))
      .onUpdate(event => seekTo(event.x, event.y))
      .onFinalize(() => onSeekEnd())
      .runOnJS(true)
  );
}

/**
 * One invisible box over one drawn word.
 *
 * The word's own box padded out to something a thumb can find — `hitSlop`
 * rather than a larger rect, so two adjacent words cannot overlap into each
 * other's target. The label a screen reader announces is the word the canvas
 * drew, which is the only reason this is the right place for it: the drawing
 * carries `importantForAccessibility="no-hide-descendants"` and can announce
 * nothing at all.
 */
function WordTarget({
  word,
  foot,
  onPress,
}: {
  word: PlayerWord;
  foot: Readonly<{ x: number; y: number }>;
  onPress: (() => void) | null;
}) {
  if (onPress === null) return null;
  return (
    <Pressable
      accessibilityLabel={word.text}
      accessibilityRole="button"
      hitSlop={{
        left: SONG_SURFACE_KNOBS.WORD_HIT_PAD_PX,
        right: SONG_SURFACE_KNOBS.WORD_HIT_PAD_PX,
        top: 0,
        bottom: 0,
      }}
      onPress={onPress}
      style={[
        styles.wordHit,
        {
          left: foot.x + word.x,
          // The drawn word sits *on* the baseline; the box is centred over it.
          top: foot.y - touch.min / 2,
          width: word.width,
        },
      ]}
    />
  );
}

/**
 * One invisible box over one drawn silhouette.
 *
 * Square and centred on the seat, because a transport button is a shape with a
 * middle rather than a word with a left edge — `transportScreenPx` is the same
 * measurement the canvas draws the silhouette from, for the reason `WordTarget`
 * gives.
 *
 * A step with nothing to step to gets no box at all rather than a disabled one.
 * There is no queue yet, so the honest state is "not a control", and a disabled
 * button announces itself to a screen reader as a thing that could work and
 * does not.
 */
function TransportTarget({
  seat,
  label,
  onPress,
  disabled,
}: {
  seat: TransportSeat;
  label: string;
  onPress: (() => void) | null;
  disabled: boolean;
}) {
  if (onPress === null) return null;
  const size = PLAYER_POSE_KNOBS.SONG_TRANSPORT_HIT_PX;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.transportHit,
        {
          height: size,
          left: seat.x - size / 2,
          top: seat.y - size / 2,
          width: size,
        },
      ]}
    />
  );
}

/**
 * Read the visual clock a couple of times a second for the elapsed readout.
 *
 * The playhead itself never comes through React — the canvas sweeps it on the
 * UI thread — only these digits do, and a clock that ticks twice a second is
 * honest enough for a number a person reads.
 */
function useElapsedLabel(
  positionSeconds: SharedValue<number>,
  running: boolean,
): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(positionSeconds.value);
    if (!running) return;
    const timer = setInterval(
      () => setElapsed(positionSeconds.value),
      SONG_SURFACE_KNOBS.ELAPSED_SAMPLE_MS,
    );
    return () => clearInterval(timer);
  }, [positionSeconds, running]);
  return elapsed;
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  /**
   * Above the ring, centred: the ring is drawn around the mark's own point,
   * which at this distance is the middle of the view.
   */
  elapsed: {
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
    top: SONG_SURFACE_KNOBS.ELAPSED_TOP_RATIO_PCT,
  },
  seekHit: { position: 'absolute' },
  /**
   * The picker on the axis too: a row centred in a full-width strip, rather
   * than a row pinned to the left margin. It is the last thing that was still
   * laid out against the margin the name used to start at.
   */
  lens: {
    alignItems: 'center',
    bottom: playerLensBottomPx(),
    left: 0,
    position: 'absolute',
    right: 0,
  },
  wordHit: { height: touch.min, position: 'absolute' },
  transportHit: { position: 'absolute' },
  error: { bottom: space.lg, left: space.lg, position: 'absolute' },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const SongSurface = React.memo(SongSurfaceImpl);
