import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BUDGET_CHOICES } from '../../audio/budget';
import { formatBytes } from '../../lenses';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SETTINGS_KNOBS = {
  /** Enough of the key to compare against a node's screen by eye. */
  FINGERPRINT_CHARS: 4,
  /** The two storage bands, drawn as one bar each. */
  BAR_HEIGHT_PX: 3,
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
      <Text style={[type.eyebrow, { color: pal.faint }]}>1.0 · ALPHA</Text>

      <Group label="THIS PHONE" />
      <Row label="Identity" value={fingerprint(publicKey)} />

      <Group label="LIBRARY" />
      <Row label="Songs" value={String(library.songs)} />
      {/* Placements, not just songs: a song in three playlists is three marks,
          and the difference is the whole reason the field has an axis dial. */}
      <Row label="Placements" value={String(library.placements)} />
      <Row label="Playlists" value={String(library.playlists)} />

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
      <Text style={[type.eyebrow, { color: pal.faint }]}>BUDGET</Text>
      <Text style={[type.heading, { color: pal.ink }]}>
        {formatBytes(budgetBytes)}
      </Text>
      <View style={styles.choices}>
        {BUDGET_CHOICES.map(choice => (
          <Pressable
            accessibilityLabel={`Budget ${formatBytes(choice)}`}
            accessibilityRole="button"
            accessibilityState={{ selected: choice === budgetBytes }}
            hitSlop={space.sm}
            key={choice}
            onPress={() => onChangeBudget(choice)}>
            <Text
              style={[
                type.eyebrow,
                { color: choice === budgetBytes ? pal.ink : pal.faint },
              ]}>
              {formatBytes(choice)}
            </Text>
          </Pressable>
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
      <Text style={[type.eyebrow, { color: pal.faint }]}>{label}</Text>
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
        <Text style={[type.eyebrow, { color: pal.muted }]}>{value}</Text>
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
  const width: `${number}%` = `${Math.round(
    Math.min(Math.max(fraction, 0), 1) * 100,
  )}%`;
  return (
    <View style={styles.band}>
      <View style={styles.row}>
        <Text style={[type.eyebrow, { color: pal.faint }]}>{label}</Text>
        <Text style={[type.eyebrow, { color: pal.muted }]}>{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: pal.line }]}>
        <View style={[styles.fill, { backgroundColor: colour, width }]} />
      </View>
      <Text style={[type.body, { color: pal.muted }]}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.xs, paddingBottom: space.xxl, paddingTop: space.md },
  group: { marginTop: space.md },
  hairline: { height: 1, marginTop: space.sm },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: touch.min / 2,
  },
  band: { gap: space.xs, marginTop: space.sm },
  track: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX, width: '100%' },
  fill: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX },
  choices: { flexDirection: 'row', gap: space.lg, minHeight: touch.min },
});
