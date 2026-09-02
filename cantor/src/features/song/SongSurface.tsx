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
  ORIGIN_MARK_RESERVE_PX: 96, // keep the transport row clear of the persistent origin mark
  /** The song's name at L2, the largest type in the app after the field's own. */
  NAME_SIZE_PX: 26,
  /** Clear of the origin mark, which sits at the same corner. */
  FOOT_INSET_PX: 96,
  /** Where the elapsed sits: above the ring, which is centred on the view. */
  ELAPSED_TOP_RATIO_PCT: '13%',
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
  /** The lens control lives here: one place, every level. */
  lens: React.ReactNode;
};

/**
 * L2: one song filling the view, playing.
 *
 * There is no mini-player anywhere in Cantor — this *is* the player, and it
 * exists only at this distance. It reads position from the shared visual clock
 * rather than from React state, so the playhead moves without re-rendering.
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
  lens,
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

  const onPhone = song.audioState === 'cached' || song.audioState === 'pinned';
  // A song that lives on the node is still playable: pressing play fetches it
  // first. Disabling it here would disable the only path that downloads it.
  const playable = available;
  const transportLabel =
    isCurrent && snapshot.state === 'playing'
      ? 'Pause'
      : onPhone
        ? 'Play'
        : 'Fetch';

  return (
    <View style={styles.root} pointerEvents="box-none">
      {/*
        The level, in the corner the overlay leaves empty here: at L2 and L3 the
        player draws its own name and metadata, so the chrome stands aside.
      */}
      <Text style={[type.eyebrow, styles.level, { color: pal.muted }]}>
        L2 · SONG
      </Text>

      {/*
        The elapsed time sits just above the ring, because the ring *is* the
        timeline: the digits say where the head is, and the head is drawn where
        every ring in Cantor starts.
      */}
      <Text style={[type.eyebrow, styles.elapsed, { color: pal.ink }]}>
        {formatClock(isCurrent ? elapsed : 0)}
      </Text>

      {/* Everything the ring is not, below it, in reading order. */}
      <View style={styles.foot}>
        <Text numberOfLines={2} style={[type.title, styles.name, { color: pal.ink }]}>
          {song.title}
        </Text>
        <Text style={[type.eyebrow, { color: pal.faint }]}>
          {recipeLine(song)}
        </Text>

        <GestureDetector gesture={scrub}>
          <View
            style={styles.scrubHit}
            accessibilityRole="adjustable"
            accessibilityLabel={`Scrub ${song.title}`}>
            <View style={[styles.scrubTrack, { backgroundColor: pal.line }]}>
              <Animated.View
                style={[styles.playhead, { backgroundColor: pal.ink }, playhead]}
              />
            </View>
          </View>
        </GestureDetector>

        {/*
          Quiet words, not boxes: at this distance the song is the picture and
          everything else is a line of small capitals under it.
        */}
        <View style={styles.words}>
          <Word
            disabled={!playable}
            label={transportLabel.toUpperCase()}
            onPress={onToggle}
            strong
          />
          <Word label="DETAIL" onPress={onOpenDetail} />
          <Text style={[type.eyebrow, { color: pal.faint }]}>
            {describeAudio(song.audioState)}
          </Text>
        </View>

        {playlistLine(song.tags) === null ? null : (
          <Text style={[type.eyebrow, { color: pal.line }]}>
            {playlistLine(song.tags)}
          </Text>
        )}

        {lens}

        {/*
          The one gesture worth naming here. The overlay draws no hint at L2 —
          its foot is the player's — so the player says its own: zooming past a
          song is how L3 is reached, and nothing else on this screen suggests
          there is anywhere further to go.
        */}
        <Text style={[type.eyebrow, { color: pal.line }]}>
          ZOOM PAST TO ENTER THE AUDIO
        </Text>

        {snapshot.error !== null ? (
          <Text style={[type.mono, { color: pal.ink }]}>{snapshot.error}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** One quiet word in the foot's row. */
function Word({
  label,
  onPress,
  disabled = false,
  strong = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  strong?: boolean;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={space.sm}
      onPress={onPress}>
      <Text
        style={[
          type.eyebrow,
          { color: disabled ? pal.faint : strong ? pal.ink : pal.muted },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** `ACESTEP:1.5-FAST · SEED 41822 · 3:12` — the recipe, said once. */
function recipeLine(song: SongSurfaceSong): string {
  const parts = [song.model.toUpperCase()];
  if (song.seed !== undefined) parts.push(`SEED ${song.seed}`);
  parts.push(formatClock(song.durationMs / 1000));
  return parts.join(' · ');
}

/** `P/ LATE NIGHT   P/ KEEP`, or nothing at all when it is in none. */
function playlistLine(tags: readonly string[]): string | null {
  const names = tags
    .filter(tag => tag.startsWith('p/'))
    .map(tag => tag.slice(2).trim().toUpperCase())
    .filter(name => name.length > 0);
  return names.length === 0 ? null : names.map(name => `P/ ${name}`).join('   ');
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
  },
  level: { left: space.lg, position: 'absolute', top: space.xl },
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
  foot: {
    bottom: SONG_SURFACE_KNOBS.FOOT_INSET_PX,
    gap: space.sm,
    left: space.lg,
    position: 'absolute',
    right: space.lg,
  },
  name: { fontSize: SONG_SURFACE_KNOBS.NAME_SIZE_PX },
  words: { flexDirection: 'row', gap: space.lg, minHeight: touch.min },
  scrubHit: {
    height: SONG_SURFACE_KNOBS.SCRUB_HIT_HEIGHT_PX,
    justifyContent: 'center',
  },
  scrubTrack: {
    height: SONG_SURFACE_KNOBS.SCRUB_TRACK_HEIGHT_PX,
    overflow: 'hidden',
  },
  playhead: { height: SONG_SURFACE_KNOBS.SCRUB_TRACK_HEIGHT_PX },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingRight: SONG_SURFACE_KNOBS.ORIGIN_MARK_RESERVE_PX,
  },
  transport: {
    minHeight: touch.min,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  detail: { marginLeft: 'auto', minHeight: touch.min, justifyContent: 'center' },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const SongSurface = React.memo(SongSurfaceImpl);
