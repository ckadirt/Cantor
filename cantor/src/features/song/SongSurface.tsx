import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import type { LocalAudioState } from '../../audio/native';
import type { PlayerSnapshot } from '../../player';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS — L2 chrome, in real units. */
const SONG_SURFACE_KNOBS = {
  SCRUB_STEP_SECONDS: 1, // L2 is the coarse rule; L3 zoom-scrubbing is the precise one (M7)
  SCRUB_TRACK_HEIGHT_PX: 2, // the hairline the playhead runs along
  SCRUB_HIT_HEIGHT_PX: 44, // touch target around that hairline
  ELAPSED_SAMPLE_MS: 500, // how often the elapsed label reads the visual clock
} as const;

export type SongSurfaceSong = Readonly<{
  key: string;
  title: string;
  model: string;
  seed: number | undefined;
  durationMs: number;
  nodeLabel: string;
  audioState: LocalAudioState;
}>;

type Props = {
  song: SongSurfaceSong;
  snapshot: PlayerSnapshot;
  /** Visual position in seconds, on the UI thread. */
  positionSeconds: SharedValue<number>;
  /** True when this song is the one the player currently holds. */
  isCurrent: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onOpenDetail: () => void;
  width: number;
};

/**
 * L2: one song filling the view, playing.
 *
 * There is no mini-player anywhere in Cantor — this *is* the player, and it
 * exists only at this distance. It reads position from the shared visual clock
 * rather than from React state, so the playhead moves without re-rendering.
 */
export function SongSurface({
  song,
  snapshot,
  positionSeconds,
  isCurrent,
  onToggle,
  onSeek,
  onOpenDetail,
  width,
}: Props) {
  const pal = usePalette();
  const durationSeconds = song.durationMs / 1000;

  const playhead = useAnimatedStyle(() => {
    const fraction =
      durationSeconds > 0
        ? Math.min(Math.max(positionSeconds.value / durationSeconds, 0), 1)
        : 0;
    return { width: `${fraction * 100}%` };
  }, [durationSeconds]);

  const elapsed = useElapsedLabel(
    positionSeconds,
    isCurrent && snapshot.state === 'playing',
  );

  const scrub = useMemo(() => {
    const seekTo = (x: number) => {
      const fraction = Math.min(Math.max(x / Math.max(width, 1), 0), 1);
      const step = SONG_SURFACE_KNOBS.SCRUB_STEP_SECONDS;
      onSeek(Math.round((fraction * durationSeconds) / step) * step);
    };
    return Gesture.Pan()
      .onBegin(event => seekTo(event.x))
      .onUpdate(event => seekTo(event.x))
      .runOnJS(true);
  }, [durationSeconds, onSeek, width]);

  const transportLabel = isCurrent && snapshot.state === 'playing' ? 'Pause' : 'Play';
  const playable = song.audioState === 'cached' || song.audioState === 'pinned';

  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.head} pointerEvents="none">
        <Text numberOfLines={2} style={[type.title, { color: pal.ink }]}>
          {song.title}
        </Text>
        <Text style={[type.mono, { color: pal.muted }]}>
          {song.model}
          {song.seed === undefined ? '' : ` · seed ${song.seed}`}
        </Text>
      </View>

      <View style={styles.foot}>
        <GestureDetector gesture={scrub}>
          <View style={styles.scrubHit} accessibilityRole="adjustable"
            accessibilityLabel={`Scrub ${song.title}`}>
            <View style={[styles.scrubTrack, { backgroundColor: pal.line }]}>
              <Animated.View
                style={[styles.playhead, { backgroundColor: pal.ink }, playhead]}
              />
            </View>
          </View>
        </GestureDetector>

        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${transportLabel} ${song.title}`}
            disabled={!playable}
            onPress={onToggle}
            style={[styles.transport, { borderColor: playable ? pal.ink : pal.faint }]}>
            <Text style={[type.mono, { color: playable ? pal.ink : pal.faint }]}>
              {transportLabel}
            </Text>
          </Pressable>

          <Text style={[type.mono, { color: pal.muted }]}>
            {formatClock(isCurrent ? elapsed : 0)} / {formatClock(durationSeconds)}
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Details for ${song.title}`}
            onPress={onOpenDetail}
            style={styles.detail}>
            <Text style={[type.mono, { color: pal.muted }]}>
              {describeAudio(song.audioState)}
            </Text>
          </Pressable>
        </View>

        {isCurrent && snapshot.error !== null ? (
          <Text style={[type.mono, { color: pal.ink }]}>{snapshot.error}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Read the visual clock a couple of times a second for the elapsed readout.
 *
 * The playhead itself never comes through React — only these digits do, and a
 * clock that ticks twice a second is honest enough for a number a person reads.
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

/** Never claim a song is here when only part of it is. */
function describeAudio(state: LocalAudioState): string {
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

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  head: { padding: space.lg, gap: space.xs },
  foot: { padding: space.lg, gap: space.md },
  scrubHit: {
    height: SONG_SURFACE_KNOBS.SCRUB_HIT_HEIGHT_PX,
    justifyContent: 'center',
  },
  scrubTrack: {
    height: SONG_SURFACE_KNOBS.SCRUB_TRACK_HEIGHT_PX,
    overflow: 'hidden',
  },
  playhead: { height: SONG_SURFACE_KNOBS.SCRUB_TRACK_HEIGHT_PX },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  transport: {
    minHeight: touch.min,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  detail: { marginLeft: 'auto', minHeight: touch.min, justifyContent: 'center' },
});
