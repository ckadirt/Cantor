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
  songTitleColumnPx,
  transportScreenPx,
  type TransportSeat,
} from '../field/songPose';
import { REPRESENTATION_WINDOWS, bandAlphaAt, type Camera } from '../../field';
import { useMorphFont } from '../../motion/fonts';
import type { PlayerSnapshot } from '../../player';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS — what is left of L2 in React, in real units. */
const SONG_SURFACE_KNOBS = {
  SCRUB_STEP_SECONDS: 1, // L2 is the coarse rule; L3 zoom-scrubbing is the precise one (M7)
  ELAPSED_SAMPLE_MS: 500, // how often the elapsed label reads the visual clock
  /** Where the elapsed sits: above the ring, which is centred on the view. */
  ELAPSED_TOP_RATIO_PCT: '13%',
  /** Air around a word, so a five-letter target is still a target. */
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
  /** Every tag; the playlists among them are named at the foot. */
  tags: readonly string[];
}>;

type Props = {
  song: SongSurfaceSong;
  snapshot: PlayerSnapshot;
  /** Visual position in seconds, on the UI thread. */
  positionSeconds: SharedValue<number>;
  /** True when this song is the one the player currently holds. */
  isCurrent: boolean;
  /** True when the node has a delivery artifact this song can be fetched from. */
  available: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
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
  snapshot,
  positionSeconds,
  isCurrent,
  available,
  onToggle,
  onSeek,
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

  const scrub = useMemo(() => {
    const column = songTitleColumnPx(width);
    const seekTo = (x: number) => {
      const fraction = Math.min(Math.max(x / Math.max(column, 1), 0), 1);
      const step = SONG_SURFACE_KNOBS.SCRUB_STEP_SECONDS;
      onSeek(Math.round((fraction * durationSeconds) / step) * step);
    };
    return Gesture.Pan()
      .onBegin(event => seekTo(event.x))
      .onUpdate(event => seekTo(event.x))
      .runOnJS(true);
  }, [durationSeconds, onSeek, width]);

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
      <Animated.Text
        style={[type.eyebrow, styles.elapsed, { color: pal.ink }, readout]}>
        {formatClock(isCurrent ? elapsed : 0)}
      </Animated.Text>

      <GestureDetector gesture={scrub}>
        <View
          accessibilityLabel={`Scrub ${song.title}`}
          accessibilityRole="adjustable"
          style={[
            styles.scrubHit,
            {
              left: foot.x,
              top: foot.scrubY - PLAYER_POSE_KNOBS.SONG_SCRUB_HIT_PX / 2,
              width: songTitleColumnPx(width),
            },
          ]}
        />
      </GestureDetector>

      {words === null
        ? null
        : words.map(word => (
            <WordTarget
              foot={foot}
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
      hitSlop={SONG_SURFACE_KNOBS.WORD_HIT_PAD_PX}
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
  scrubHit: {
    height: PLAYER_POSE_KNOBS.SONG_SCRUB_HIT_PX,
    position: 'absolute',
  },
  lens: {
    bottom: playerLensBottomPx(),
    left: PLAYER_POSE_KNOBS.SONG_FOOT_SIDE_PX,
    position: 'absolute',
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
