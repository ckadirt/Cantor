import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Row, Ruler } from '../controls';
import { useStore } from '../../core/useStore';
import { smootherstep } from '../../lenses/motion/motionFrame';
import { outputLatencySeconds, type OutputRoute } from '../../player/outputLatency';
import {
  SYNC_KNOBS,
  setSyncOffset,
  syncStore,
  type SyncState,
} from '../../player/syncOffsets';
import { type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SYNC_ROW_KNOBS = {
  /** The dot that keeps the picture's time: its size, and how long a beat lights it. */
  DOT_PX: 10,
  FLASH_S: 0.12,
  /** Unlit, it is still there to be watched. */
  REST_ALPHA: 0.15,
} as const;

/** What the row needs of the song playing, if one is. */
export type SyncSong = Readonly<{
  /** The picture's clock: the one this row corrects. */
  positionSeconds: SharedValue<number>;
  /** The song's beats, once measured and sure; null otherwise. */
  beats: readonly number[] | null;
  playing: boolean;
}>;

const ROUTE_WORDS: Readonly<Record<OutputRoute, string>> = {
  speaker: 'The speaker',
  wired: 'Wired headphones',
  usb: 'USB audio',
  bluetooth: 'Bluetooth',
  other: 'This output',
};

const STOPS = (() => {
  const stops: { key: string; accessibilityLabel: string }[] = [];
  for (let ms = -SYNC_KNOBS.RANGE_MS; ms <= SYNC_KNOBS.RANGE_MS; ms += SYNC_KNOBS.STEP_MS) {
    stops.push({ key: String(ms), accessibilityLabel: `Picture ${signed(ms)} milliseconds` });
  }
  return stops;
})();

function signed(ms: number): string {
  return ms > 0 ? `+${ms}` : ms < 0 ? `−${-ms}` : '0';
}

function routeOf(state: SyncState) {
  return state.route;
}
function offsetsOf(state: SyncState) {
  return state.offsets;
}

/**
 * The picture's time against the sound's, for the output in use.
 *
 * Set by eye against the song that is playing rather than a test track, so
 * the music does not stop to be measured: a dot lights on every beat by the
 * same clock the player moves by, and the ruler moves that clock until the
 * dot falls on the beat that is heard. Each output keeps its own correction
 * (`syncOffsets.ts`), so the speaker's is not undone by putting headphones on.
 */
export function SyncRow({ song }: { song: SyncSong | null }) {
  const pal = usePalette();
  const route = useStore(syncStore, routeOf);
  const offsets = useStore(syncStore, offsetsOf);
  const at: OutputRoute = route ?? 'speaker';
  const offset = offsets[at];
  const total = Math.round((outputLatencySeconds(at) * 1000 + offset));

  const beats = useSharedValue<readonly number[] | null>(song?.beats ?? null);
  useEffect(() => {
    beats.value = song?.beats ?? null;
  }, [beats, song?.beats]);
  const fallback = useSharedValue(0);
  const position = song?.positionSeconds ?? fallback;
  const dot = useAnimatedStyle(() => {
    const K = SYNC_ROW_KNOBS;
    const list = beats.value;
    const t = position.value;
    let lit = 0;
    if (list !== null && list.length > 0 && t >= list[0]) {
      let lo = 0;
      let hi = list.length - 1;
      while (lo < hi) {
        const m = Math.floor((lo + hi + 1) / 2);
        if (list[m] <= t) lo = m;
        else hi = m - 1;
      }
      lit = 1 - smootherstep((t - list[lo]) / K.FLASH_S);
    }
    return { opacity: K.REST_ALPHA + (1 - K.REST_ALPHA) * lit };
  });

  const listening = song !== null && song.playing && route !== null;
  const note = !listening
    ? 'Play a song, then move this until the dot falls on its beat. Each output keeps its own.'
    : song.beats === null
    ? 'This song has no beat sure enough to set this by. Try one with a steady kick.'
    : `${ROUTE_WORDS[at]}: the picture waits ${total} ms for the sound. Move this until the dot falls on the beat.`;

  const stops = useMemo(() => STOPS, []);
  return (
    <Row label="Sync" control>
      <View style={styles.value}>
        <Text style={[type.body, { color: pal.ink }]}>{`${signed(offset)} ms`}</Text>
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.dot, { backgroundColor: pal.ink }, dot]}
        />
      </View>
      <Ruler
        activeKey={String(offset)}
        onSelect={key => setSyncOffset(at, Number(key))}
        stops={stops}
      />
      <Text style={[type.small, { color: pal.muted }]}>{note}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  // The value in words above the line it is chosen along, as the budget's.
  value: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingTop: 13 },
  dot: {
    borderRadius: SYNC_ROW_KNOBS.DOT_PX / 2,
    height: SYNC_ROW_KNOBS.DOT_PX,
    width: SYNC_ROW_KNOBS.DOT_PX,
  },
});
