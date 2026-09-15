import React, { useEffect } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Dial, Ledger, LedgerGap, Row, LEDGER_DIAL_ITEM } from '../controls';
import { BUDGET_CHOICES } from '../../audio/budget';
import { formatBytes } from '../../lenses';
import { space, type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SETTINGS_KNOBS = {
  /** Enough of the key to compare against a node's screen by eye. */
  FINGERPRINT_CHARS: 4,
  /** The two storage bands, drawn as one bar each. */
  BAR_HEIGHT_PX: 5,
  BAR_MORPH_MS: 420,
  META_PX: 12,
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

      <Ledger>
        <Row label="Identity">
          <Text selectable style={[styles.meta, { color: pal.ink }]}>
            {fingerprint(publicKey)}
          </Text>
        </Row>
        <LedgerGap />
        <Row label="Songs">
          <Text style={[type.body, { color: pal.ink }]}>{library.songs}</Text>
        </Row>
        <Row label="Placements">
          <Text style={[type.body, { color: pal.ink }]}>
            {library.placements}
          </Text>
        </Row>
        <Row label="Playlists">
          <Text style={[type.body, { color: pal.ink }]}>
            {library.playlists}
          </Text>
        </Row>
        <LedgerGap />
        <Row label="Downloaded">
          <Band
            colour={pal.ink}
            fraction={storage.downloadedBytes / widest}
            label={`${storage.downloadedSongs} songs`}
            value={formatBytes(storage.downloadedBytes)}
            note="Yours until you remove them. Never reclaimed."
          />
        </Row>
        <Row label="Cached">
          <Band
            colour={pal.muted}
            fraction={storage.cachedBytes / widest}
            label={`${storage.cachedSongs} songs`}
            value={formatBytes(storage.cachedBytes)}
            note="Here because you listened. Reclaimed first."
          />
        </Row>
        <Row label="Budget">
          <Dial
            activeColour={pal.ink}
            activeKey={String(budgetBytes)}
            items={BUDGET_CHOICES.map(choice => ({
              key: String(choice),
              label: formatBytes(choice)
                .replace(' MB', 'M')
                .replace(' GB', 'G'),
              accessibilityLabel: `Budget ${formatBytes(choice)}`,
            }))}
            onSelect={key => onChangeBudget(Number(key))}
            itemStyle={LEDGER_DIAL_ITEM}
            restColour={pal.faint}
            textStyle={styles.meta}
            tickColour={pal.ink}
          />
          <Text style={[type.small, { color: pal.muted }]}>
            Downloads count against this budget but are never reclaimed.
          </Text>
        </Row>
        <LedgerGap />
        <Row label="Diagnostics">
          <Text style={[type.body, { color: pal.faint }]}>not yet</Text>
        </Row>
        <Row label="Licences">
          <Text style={[type.body, { color: pal.faint }]}>not yet</Text>
        </Row>
      </Ledger>
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
  const reducedMotion = useReducedMotion();
  const fill = useSharedValue(Math.min(Math.max(fraction, 0), 1));
  useEffect(() => {
    fill.value = withTiming(Math.min(Math.max(fraction, 0), 1), {
      duration: reducedMotion ? 0 : SETTINGS_KNOBS.BAR_MORPH_MS,
      easing: easeSmoother,
    });
  }, [fill, fraction, reducedMotion]);
  const fillStyle = useAnimatedStyle(() => ({
    width: `${fill.value * 100}%` as `${number}%`,
  }));
  return (
    <View style={styles.band}>
      <View>
        <Text style={[styles.meta, { color: pal.muted }]}>{label}</Text>
        <Text style={[styles.meta, { color: pal.muted }]}>{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: pal.line }]}>
        <Animated.View
          style={[styles.fill, { backgroundColor: colour }, fillStyle]}
        />
      </View>
      <Text style={[type.small, { color: pal.muted }]}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: {
    ...type.eyebrow,
    fontSize: SETTINGS_KNOBS.META_PX,
    letterSpacing: 0.7,
    lineHeight: 19,
  },
  body: { gap: space.xs, paddingBottom: space.xxl, paddingTop: space.md },
  band: { gap: space.xs },
  track: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX, width: '100%' },
  fill: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX },
});
