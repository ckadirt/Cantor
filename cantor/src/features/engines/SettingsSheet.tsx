import React, { useEffect, useRef, useState } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';
import { easeSmoother, TransformText } from '../../motion';
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  Dial,
  Ledger,
  LedgerGap,
  Row,
  Underway,
  useReach,
  LEDGER_DIAL_ITEM,
} from '../controls';
import { RecoveryGrid, RECOVERY_KNOBS } from './RecoveryGrid';
import { BUDGET_CHOICES } from '../../audio/budget';
import { formatBytes } from '../../lenses';
import { authenticateRecovery, protectRecoveryScreen } from '../../identity/recoveryAccess';
import { loadStoredPhrase } from '../../identity/secureIdentity';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SETTINGS_KNOBS = {
  /** Enough of the key to compare against a node's screen by eye. */
  FINGERPRINT_CHARS: 4,
  /** The two storage bands, drawn as one bar each. */
  BAR_HEIGHT_PX: 5,
  BAR_MORPH_MS: 420,
  META_PX: 12,
  /** `Reveal words` ⇄ `Hide words`: a body-size act, the song sheet's pace. */
  ACT_MS: 520,
  /** The seat that morphing act takes: `type.body`'s own 22 px line. */
  ACT_SLOT_PX: 22,
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
        <RecoveryWords />
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
        <Row label="Budget" control>
          <Dial
            compact
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

/**
 * The twelve words, kept as dust until the owner proves who they are.
 *
 * The grid is always on the page, so the row says what it holds before it is
 * asked to; the words themselves are not read from storage until the device
 * lock has been passed. The act has the panel's three states: it morphs
 * between `Reveal words` and `Hide words`, grows a working rule while the
 * system prompt is up, and `Copy words` is out of reach until there is
 * something to copy.
 */
function RecoveryWords() {
  const pal = usePalette();
  const [words, setWords] = useState<readonly string[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef(0);
  const revealedRef = useRef(false);
  const protectedScreen = useRef(false);
  const mounted = useRef(true);
  const forget = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyInk = useReach(!revealed);

  const dropWords = () => {
    if (forget.current !== null) clearTimeout(forget.current);
    forget.current = null;
    revealedRef.current = false;
    setRevealed(false);
    setWords(null);
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      // Away from the app the words go at once, not on the way to dust. The
      // pending request survives: the device-lock prompt is an activity of its
      // own, so asking for it is itself a trip to the background.
      if (state !== 'active') dropWords();
    });
    return () => {
      mounted.current = false;
      revealedRef.current = false;
      request.current += 1;
      if (forget.current !== null) clearTimeout(forget.current);
      subscription.remove();
      if (protectedScreen.current) {
        protectRecoveryScreen(false).catch(() => {});
      }
    };
  }, []);

  const reveal = async () => {
    if (busy) return;
    const current = ++request.current;
    setBusy(true);
    setMessage(null);
    try {
      await protectRecoveryScreen(true);
      protectedScreen.current = true;
      if (!mounted.current || current !== request.current) {
        if (!mounted.current) protectRecoveryScreen(false).catch(() => {});
        return;
      }
      await authenticateRecovery();
      if (!mounted.current || current !== request.current) return;
      // The prompt's result can land before Cantor is resumed; the words are
      // only drawn onto a screen that is back in front.
      await untilActive();
      if (!mounted.current || current !== request.current) return;
      const stored = await loadStoredPhrase();
      if (!mounted.current || current !== request.current || AppState.currentState !== 'active') return;
      if (stored) {
        if (forget.current !== null) clearTimeout(forget.current);
        forget.current = null;
        revealedRef.current = true;
        setWords(stored);
        setRevealed(true);
      } else {
        setMessage('These words were not kept on this installation. Use your written backup.');
      }
    } catch (error) {
      if (mounted.current && current === request.current &&
          (!isRecoveryCancelled(error))) {
        setMessage(error instanceof Error ? error.message : 'Could not reveal recovery words.');
      }
    } finally {
      if (mounted.current && current === request.current) setBusy(false);
    }
  };

  const hide = () => {
    request.current += 1;
    revealedRef.current = false;
    setRevealed(false);
    setBusy(false);
    setMessage(null);
    // The words scatter on the reveal's own clock reversed; they are needed
    // to draw that, and dropped the moment it is over.
    if (forget.current !== null) clearTimeout(forget.current);
    forget.current = setTimeout(() => {
      forget.current = null;
      if (mounted.current) setWords(null);
    }, RECOVERY_KNOBS.REVEAL_MS);
  };

  const copy = () => {
    if (!words || !revealed) return;
    const current = request.current;
    Alert.alert(
      'Copy recovery words?',
      'Other apps may read your clipboard. Paste the words somewhere private and clear the clipboard when finished.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Copy', onPress: () => {
          if (mounted.current && revealedRef.current && current === request.current) {
            Clipboard.setString(words.join(' '));
          }
        } },
      ],
    );
  };

  const label = busy ? 'Confirm on device' : revealed ? 'Hide words' : 'Reveal words';

  return (
    <Row label="Recovery" control>
      <Pressable
        accessibilityLabel={revealed ? 'Hide recovery words' : 'Reveal recovery words'}
        accessibilityRole="button"
        accessibilityState={{ busy }}
        onPress={busy ? undefined : revealed ? hide : reveal}
        style={styles.recoveryAct}
      >
        <View>
          <TransformText
            charStyle={type.body}
            color={pal.ink}
            duration={SETTINGS_KNOBS.ACT_MS}
            style={styles.recoverySlot}
            text={label}
          />
          <Underway charStyle={type.body} label={label} working={busy} />
        </View>
      </Pressable>
      {message ? <Text style={[type.small, { color: pal.muted }]}>{message}</Text> : null}
      <Pressable
        accessibilityLabel="Reveal recovery words"
        accessibilityState={{ disabled: revealed }}
        onPress={busy || revealed ? undefined : reveal}
        style={styles.recoveryGrid}
      >
        <RecoveryGrid revealed={revealed} words={words} />
      </Pressable>
      <Text style={[type.small, { color: pal.muted }]}>
        This phone's copy is lost if Cantor is removed, app data is cleared, or the phone is lost. Keep a separate backup.
      </Text>
      <Pressable
        accessibilityLabel="Copy recovery words"
        accessibilityRole="button"
        accessibilityState={{ disabled: !revealed }}
        onPress={revealed ? copy : undefined}
        style={styles.recoveryAct}
      >
        <Animated.Text style={[type.body, copyInk.tint]}>Copy words</Animated.Text>
      </Pressable>
    </Row>
  );
}

/** Resolves once the app is in the foreground, at once if it already is. */
function untilActive(): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise(resolve => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      subscription.remove();
      resolve();
    });
  });
}

function isRecoveryCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'CANCELLED';
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
  recoveryAct: { justifyContent: 'center', minHeight: touch.min },
  recoverySlot: { height: SETTINGS_KNOBS.ACT_SLOT_PX },
  recoveryGrid: { marginBottom: space.sm, marginTop: space.xs },
});
