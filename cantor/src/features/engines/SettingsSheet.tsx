import React, { useEffect } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother, TransformText } from '../../motion';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { PanelPressable } from '../controls';
import { BUDGET_CHOICES } from '../../audio/budget';
import { formatBytes } from '../../lenses';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SETTINGS_KNOBS = {
  /** Enough of the key to compare against a node's screen by eye. */
  FINGERPRINT_CHARS: 4,
  /** The two storage bands, drawn as one bar each. */
  BAR_HEIGHT_PX: 5,
  BAR_MORPH_MS: 420,
  META_PX: 12,
  CHOICE_MIN_PX: 64,
  /** Stable text slot: changing units never changes the surrounding layout. */
  BUDGET_HEIGHT_PX: 48,
  BUDGET_MORPH_MS: 420,
} as const;

/** What this phone is holding, counted the way the design counts it. */
export type StorageReport = Readonly<{
  downloadedSongs: number;
  downloadedBytes: number;
  cachedSongs: number;
  cachedBytes: number;
}>;

export type LibraryReport = Readonly<{
  songs: number;
  placements: number;
  playlists: number;
}>;

type Props = {
  visible: boolean;
  publicKey: string;
  library: LibraryReport;
  storage: StorageReport;
  budgetBytes: number;
  onChangeBudget: (bytes: number) => void;
};

/**
 * Deliberately ordinary: identity, library, storage, about, in the order
 * people reach for them.
 *
 * The design says settings takes convention, and it does — with one idea that
 * is not conventional at all. **Downloaded is a promise and cached is a loan,
 * so they are counted apart.** The budget is the size of the loan; it never
 * reclaims a download, and saying so on the screen is the difference between a
 * number and a rule someone can trust.
 */
export function SettingsSheet({
  visible,
  publicKey,
  library,
  storage,
  budgetBytes,
  onChangeBudget,
}: Props) {
  const pal = usePalette();
  if (!visible) return null;

  const total = storage.downloadedBytes + storage.cachedBytes;
  const widest = Math.max(total, budgetBytes, 1);

  return (
    <ScrollView contentContainerStyle={styles.body}>
      {/*
        No header of its own: the sheet it opens inside already carries one,
        and two rows saying where you are is the fault the chrome work in step
        3 existed to remove.
      */}
      <Text style={[type.title, { color: pal.ink }]}>Cantor</Text>
      <Text style={[styles.meta, { color: pal.muted }]}>1.0 · ALPHA</Text>

      <Group label="THIS PHONE" />
      <Row label="Identity" value={fingerprint(publicKey)} />

      <Group label="LIBRARY" />
      <View style={[styles.statistics, { borderColor: pal.line }]}>
        <Stat label="Songs" value={library.songs} />
        {/* Placements, not just songs: a song in three playlists is three marks,
          and the difference is the whole reason the field has an axis dial. */}
        <Stat label="Placements" value={library.placements} />
        <Stat label="Playlists" value={library.playlists} />
      </View>

      <Group label="STORAGE" />
      <Band
        colour={pal.ink}
        fraction={storage.downloadedBytes / widest}
        label={`DOWNLOADED · ${storage.downloadedSongs} ${
          storage.downloadedSongs === 1 ? 'SONG' : 'SONGS'
        }`}
        note="Yours until you remove them. Never reclaimed."
        value={formatBytes(storage.downloadedBytes)}
      />
      <Band
        colour={pal.muted}
        fraction={storage.cachedBytes / widest}
        label={`CACHED · ${storage.cachedSongs} ${
          storage.cachedSongs === 1 ? 'SONG' : 'SONGS'
        }`}
        note="Here because you listened. Reclaimed first when room runs out."
        value={formatBytes(storage.cachedBytes)}
      />

      <View style={[styles.hairline, { backgroundColor: pal.line }]} />
      <Text style={[styles.meta, { color: pal.muted }]}>BUDGET</Text>
      <TransformText
        text={formatBytes(budgetBytes)}
        charStyle={type.title}
        color={pal.ink}
        appearance="none"
        duration={SETTINGS_KNOBS.BUDGET_MORPH_MS}
        style={styles.budgetValue}
      />
      <View style={styles.choices}>
        {BUDGET_CHOICES.map(choice => (
          <PanelPressable
            accessibilityLabel={`Budget ${formatBytes(choice)}`}
            accessibilityRole="button"
            accessibilityState={{ selected: choice === budgetBytes }}
            style={[
              styles.choice,
              {
                borderColor: choice === budgetBytes ? pal.ink : pal.line,
              },
            ]}
            key={choice}
            onPress={() => onChangeBudget(choice)}
          >
            <Text
              style={[
                styles.meta,
                { color: choice === budgetBytes ? pal.ink : pal.muted },
              ]}
            >
              {formatBytes(choice)}
            </Text>
          </PanelPressable>
        ))}
      </View>
      <Text style={[type.body, { color: pal.muted }]}>
        The budget only ever reclaims cached songs. Downloads count against it
        but are never taken.
      </Text>

      <Group label="ABOUT" />
      <Row label="Diagnostics" value="NOT YET" />
      <Row label="Licences" value="NOT YET" />
    </ScrollView>
  );
}

/** `9F2C · 41AB` — enough of the key to check against a node by eye. */
function fingerprint(publicKey: string): string {
  const chars = SETTINGS_KNOBS.FINGERPRINT_CHARS;
  const head = publicKey.slice(0, chars).toUpperCase();
  const tail = publicKey.slice(-chars).toUpperCase();
  return `${head} · ${tail}`;
}

function Group({ label }: { label: string }) {
  const pal = usePalette();
  return (
    <View style={styles.group}>
      <Text style={[styles.meta, { color: pal.muted }]}>{label}</Text>
      <View style={[styles.hairline, { backgroundColor: pal.line }]} />
    </View>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  const pal = usePalette();
  return (
    <View style={styles.row}>
      <Text style={[type.body, { color: pal.ink }]}>{label}</Text>
      {value === undefined ? null : (
        <Text style={[styles.meta, { color: pal.muted }]}>{value}</Text>
      )}
    </View>
  );
}

/** One storage band: what it is, what it weighs, and what it promises. */
function Band({
  label,
  value,
  fraction,
  colour,
  note,
}: {
  label: string;
  value: string;
  fraction: number;
  colour: string;
  note: string;
}) {
  const pal = usePalette();
  const fill = useSharedValue(Math.min(Math.max(fraction, 0), 1));
  useEffect(() => {
    fill.value = withTiming(Math.min(Math.max(fraction, 0), 1), {
      duration: SETTINGS_KNOBS.BAR_MORPH_MS,
      easing: easeSmoother,
    });
  }, [fill, fraction]);
  const fillStyle = useAnimatedStyle(() => ({
    width: `${fill.value * 100}%` as `${number}%`,
  }));
  return (
    <View style={[styles.band, { borderColor: pal.line }]}>
      <View style={styles.row}>
        <Text style={[styles.meta, { color: pal.muted }]}>{label}</Text>
        <Text style={[styles.meta, { color: pal.muted }]}>{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: pal.line }]}>
        <Animated.View
          style={[styles.fill, { backgroundColor: colour }, fillStyle]}
        />
      </View>
      <Text style={[type.body, { color: pal.muted }]}>{note}</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const pal = usePalette();
  return (
    <View style={styles.stat}>
      <Text style={[type.title, { color: pal.ink }]}>{value}</Text>
      <Text style={[type.small, { color: pal.muted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  budgetValue: { height: SETTINGS_KNOBS.BUDGET_HEIGHT_PX },
  meta: {
    ...type.eyebrow,
    fontSize: SETTINGS_KNOBS.META_PX,
    letterSpacing: 0.7,
    lineHeight: 19,
  },
  statistics: {
    flexDirection: 'row',
    paddingVertical: space.md,
  },
  stat: { flex: 1, alignItems: 'center', gap: space.xs },
  choice: {
    flexGrow: 1,
    minWidth: SETTINGS_KNOBS.CHOICE_MIN_PX,
    minHeight: touch.min,
    borderBottomWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  body: { gap: space.xs, paddingBottom: space.xxl, paddingTop: space.md },
  group: { marginTop: space.lg, marginBottom: space.sm },
  hairline: { height: 1, marginTop: space.sm },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.sm,
    minHeight: touch.min,
  },
  band: {
    gap: space.sm,
    marginTop: space.sm,
    paddingVertical: space.sm,
  },
  track: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX, width: '100%' },
  fill: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginVertical: space.sm,
  },
});
