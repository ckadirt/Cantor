import React, { useEffect, useRef, useState } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';
import { easeSmoother, TransformText } from '../../motion';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  Coda,
  Door,
  FOLIO_ACT_STYLE,
  FOLIO_NOTE_STYLE,
  Measure,
  PanelPressable,
  Rest,
  Reveal,
  Row,
  Ruler,
  Stave,
  Underway,
  useReach,
} from '../controls';
import { RecoveryGrid, RECOVERY_KNOBS } from './RecoveryGrid';
import { BUDGET_CHOICES } from '../../audio/budget';
import { formatBytes } from '../../lenses';
import { authenticateRecovery, protectRecoveryScreen } from '../../identity/recoveryAccess';
import { loadStoredPhrase } from '../../identity/secureIdentity';
import { space, touch, type, usePalette } from '../../theme/tokens';
import { SyncRow, type SyncSong } from './SyncRow';
import { useStore } from '../../core/useStore';
import {
  chooseImportDating,
  importDating,
  IMPORT_DATINGS,
  type ImportDating,
} from '../../device/importDating';
import { appUpdate, RELEASE_ID, updateAvailable, updateBusy, type AppUpdateState } from '../../update';

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
  /** Two body lines for a storage/settings failure, beside the budget. */
  STORAGE_ERROR_SLOT_PX: 44,
  /** The save act's seat: the folio act's own line, as `Bring in` takes it. */
  SAVE_SLOT_PX: 28,
  /** The least time `Saving` shows, so a quick save still reads as one. */
  SAVE_MIN_MS: 600,
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
  library: LibraryReport;
  storage: StorageReport;
  budgetBytes: number;
  storageError?: string | null;
  onChangeBudget: (bytes: number) => void;
  /** How many failures Diagnostics holds, and the door to them. */
  failures?: number;
  onOpenDiagnostics?: () => void;
  /** The song playing, for setting the picture's time against; see `SyncRow`. */
  sync?: SyncSong | null;
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
  library,
  storage,
  budgetBytes,
  storageError = null,
  onChangeBudget,
  failures = 0,
  onOpenDiagnostics = () => {},
  sync = null,
}: Props) {
  const pal = usePalette();
  // The rulers move drafts; nothing changes until Save, so exploring the
  // choices cannot drop the cache or re-date the field by accident.
  const savedDating = useStore(importDating, state => state);
  const [draftBudget, setDraftBudget] = useState(budgetBytes);
  const [draftDating, setDraftDating] = useState<ImportDating>(savedDating);
  const [saving, setSaving] = useState(false);
  // Leaving Settings without saving lets the drafts go.
  useEffect(() => {
    if (visible) return;
    setDraftBudget(budgetBytes);
    setDraftDating(savedDating);
  }, [visible, budgetBytes, savedDating]);
  const dirty = draftBudget !== budgetBytes || draftDating !== savedDating;
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const started = Date.now();
    // Let the wave start before the work: re-dating a large field holds the
    // JS thread for a moment.
    await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    try {
      if (draftBudget !== budgetBytes) onChangeBudget(draftBudget);
      if (draftDating !== savedDating) {
        await chooseImportDating(draftDating);
        // Hold the wave until the field has drawn the new dates: these frames
        // only come once the re-cut has let go of the JS thread.
        for (let frame = 0; frame < 2; frame += 1) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      }
    } finally {
      const left = SETTINGS_KNOBS.SAVE_MIN_MS - (Date.now() - started);
      if (left > 0) await new Promise<void>(resolve => setTimeout(resolve, left));
      setSaving(false);
    }
  };
  if (!visible) return null;

  const total = storage.downloadedBytes + storage.cachedBytes;
  const widest = Math.max(total, budgetBytes, 1);

  return (
    <>
      {/*
        The head — `This phone`, and the key it answers to in the meta line —
        is the sheet's this page opens inside; see `settingsMeta`.
      */}
      <Stave>
        <Measure>
          <RecoveryWords />
        </Measure>
        <Rest />
        <Measure>
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
        </Measure>
        <Rest />
        <Measure>
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
          <Reveal
            open={storageError !== null}
            height={SETTINGS_KNOBS.STORAGE_ERROR_SLOT_PX}
          >
            <TransformText
              text={storageError ?? ''}
              charStyle={type.body}
              color={pal.ink}
              style={styles.storageError}
            />
          </Reveal>
          <Row label="Budget" control>
            {/* The value in words above the line it is chosen along. */}
            <View style={styles.rulerValue}>
              <Text style={[type.body, { color: pal.ink }]}>
                {formatBytes(draftBudget)}
              </Text>
            </View>
            <Ruler
              activeKey={String(draftBudget)}
              onSelect={key => setDraftBudget(Number(key))}
              stops={BUDGET_CHOICES.map(choice => ({
                key: String(choice),
                label: formatBytes(choice)
                  .replace(' MB', 'M')
                  .replace(' GB', 'G'),
                accessibilityLabel: `Budget ${formatBytes(choice)}`,
              }))}
            />
            <Text style={[type.small, { color: pal.muted }]}>
              Downloads count against this budget but are never reclaimed.
            </Text>
          </Row>
        </Measure>
        <Rest />
        <Measure>
          <ImportDatingRow value={draftDating} onChange={setDraftDating} />
        </Measure>
        <Rest />
        <Measure>
          <SyncRow song={sync} />
        </Measure>
        <Rest />
        <Measure>
          <VersionRow />
          <Row label="Diagnostics" control>
            <Door
              accessibilityLabel="Open diagnostics"
              label={
                failures === 0
                  ? 'Nothing went wrong'
                  : failures === 1
                  ? 'One failure'
                  : `The last ${failures} failures`
              }
              onPress={onOpenDiagnostics}
            />
          </Row>
          <Row label="Licences">
            <Text style={[type.body, { color: pal.faint }]}>not yet</Text>
          </Row>
        </Measure>
      </Stave>
      <Coda>
        <SaveAct
          dirty={dirty}
          saving={saving}
          onPress={() => {
            save().catch(() => setSaving(false));
          }}
        />
        <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
          {dirty || saving ? 'APPLIED ON SAVE' : 'NOTHING TO SAVE'}
        </Text>
      </Coda>
    </>
  );
}

/** The version the settings head names before the app has said which it is (Jest, an old build). */
export const APP_VERSION_LABEL = 'ALPHA';

/** `KEY 9F2C · 41AB · 0.1.2 ALPHA`: the settings head's meta line. */
export function settingsMeta(publicKey: string, version: string | null = null): string {
  return `KEY ${fingerprint(publicKey)} · ${version === null ? APP_VERSION_LABEL : `${version} ${APP_VERSION_LABEL}`}`;
}

/**
 * The app's version, and its update (internal/docs/plans/app-updates-plan.md,
 * U6). The control has the panel's states: it morphs between what it will do
 * (`Update to 0.1.3`), what is happening (`Downloading`, `Checking the file`,
 * `Confirm on device`) and `Try again`; the sine rule runs under it while it
 * works. Under it, the release's one line of what changed. On the first open
 * after an update the row says `Updated`, with that line, once.
 */
/** Each dating's stop on the ruler, and the value above it in words. */
const DATING_WORDS: Readonly<Record<ImportDating, { stop: string; value: string }>> = {
  arrived: { stop: 'Phone', value: 'When the file reached this phone' },
  released: { stop: 'Song', value: 'When the song came out' },
  imported: { stop: 'Cantor', value: 'When Cantor brought it in' },
};

/**
 * Which date an imported song stands at on the time axes. A draft until Save;
 * the files are never written.
 */
function ImportDatingRow({
  value: dating,
  onChange,
}: {
  value: ImportDating;
  onChange: (choice: ImportDating) => void;
}) {
  const pal = usePalette();
  return (
    <Row label="Imports" control>
      <View style={styles.rulerValue}>
        <Text style={[type.body, { color: pal.ink }]}>{DATING_WORDS[dating].value}</Text>
      </View>
      <Ruler
        activeKey={dating}
        onSelect={key => onChange(key as ImportDating)}
        stops={IMPORT_DATINGS.map(choice => ({
          key: choice,
          label: DATING_WORDS[choice].stop,
          accessibilityLabel: `Date imported songs: ${DATING_WORDS[choice].value}`,
        }))}
      />
      <Text style={[type.small, { color: pal.muted }]}>
        Where your own songs stand by date. Song reads the date in their tags.
      </Text>
    </Row>
  );
}

/** Settings' one act: apply the drafts, with the wave while it works. */
function SaveAct({
  dirty,
  saving,
  onPress,
}: {
  dirty: boolean;
  saving: boolean;
  onPress: () => void;
}) {
  const disabled = !dirty && !saving;
  const { colour } = useReach(disabled);
  const label = saving ? 'Saving' : dirty ? 'Save' : 'Saved';
  return (
    <PanelPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: saving }}
      disabled={disabled}
      onPress={saving ? undefined : onPress}
      style={styles.saveAct}
    >
      <View>
        <TransformText
          charStyle={FOLIO_ACT_STYLE}
          color={colour}
          duration={SETTINGS_KNOBS.ACT_MS}
          style={styles.saveSlot}
          text={label}
        />
        <Underway charStyle={FOLIO_ACT_STYLE} label={label} working={saving} />
      </View>
    </PanelPressable>
  );
}

function VersionRow() {
  const pal = usePalette();
  const state = useStore(appUpdate.store, current => current);
  // Opening Settings asks again; the row having been seen ends the quiet mark
  // and the once-after-updating line (which this open still shows).
  const [announced] = useState(() => state.justUpdated);
  useEffect(() => {
    appUpdate.check(true).catch(() => {});
  }, []);
  const latestCode = state.latest?.versionCode ?? 0;
  useEffect(() => {
    appUpdate.markSeen();
  }, [latestCode, state.justUpdated]);

  const installed = state.installed;
  if (installed === null) {
    return (
      <Row label="Version">
        <Text style={[type.body, { color: pal.ink }]}>{APP_VERSION_LABEL.toLowerCase()}</Text>
      </Row>
    );
  }
  if (installed.applicationId !== RELEASE_ID) {
    return (
      <Row label="Version" note="Cantor Dev">
        <Text style={[type.body, { color: pal.ink }]}>{installed.versionName}</Text>
      </Row>
    );
  }
  if (!updateAvailable(state)) {
    const justUpdated = announced || state.justUpdated;
    const notes = justUpdated && state.latest?.versionCode === installed.versionCode ? state.latest.notes : '';
    return (
      <Row label="Version" note={versionNote(state, justUpdated)}>
        <Text style={[type.body, { color: pal.ink }]}>{installed.versionName}</Text>
        {notes !== '' ? (
          <Text numberOfLines={1} style={[type.small, { color: pal.muted }]}>
            {notes}
          </Text>
        ) : null}
      </Row>
    );
  }

  const latest = state.latest!;
  const phase = state.phase;
  const busy = updateBusy(state);
  const label =
    phase.kind === 'downloading'
      ? 'Downloading'
      : phase.kind === 'verifying'
      ? 'Checking the file'
      : phase.kind === 'installing'
      ? 'Confirm on device'
      : phase.kind === 'allowing'
      ? 'Allow installs'
      : phase.kind === 'failed'
      ? 'Try again'
      : `Update to ${latest.versionName}`;
  const progress =
    phase.kind === 'downloading'
      ? `${megabytes(phase.received)} of ${megabytes(phase.total)}`
      : `${installed.versionName} now · ${megabytes(latest.bytes)}`;
  return (
    <Row label="Version" control>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ busy }}
        onPress={busy ? undefined : () => appUpdate.start().catch(() => {})}
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
      <Text style={[styles.updateMeta, { color: pal.faint }]}>{progress.toUpperCase()}</Text>
      {phase.kind === 'failed' ? (
        <Text style={[type.small, { color: pal.muted }]}>{phase.message}</Text>
      ) : latest.notes !== '' ? (
        <Text numberOfLines={1} style={[type.small, { color: pal.muted }]}>
          {latest.notes}
        </Text>
      ) : null}
    </Row>
  );
}

/** The state under an up-to-date version: only what is known. */
function versionNote(state: AppUpdateState, justUpdated: boolean): string {
  if (justUpdated) return 'Updated';
  if (state.latest !== null) return state.checkFailed ? 'Up to date when last checked' : 'Up to date';
  if (state.checkFailed) return 'Could not check';
  return 'Checking';
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
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
  storageError: { height: SETTINGS_KNOBS.STORAGE_ERROR_SLOT_PX },
  meta: {
    ...type.eyebrow,
    fontSize: SETTINGS_KNOBS.META_PX,
    letterSpacing: 0.7,
    lineHeight: 19,
  },
  band: { gap: space.xs },
  track: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX, width: '100%' },
  fill: { height: SETTINGS_KNOBS.BAR_HEIGHT_PX },
  recoveryAct: { justifyContent: 'center', minHeight: touch.min },
  rulerValue: { justifyContent: 'center', paddingTop: 13 },
  recoverySlot: { height: SETTINGS_KNOBS.ACT_SLOT_PX },
  saveAct: { justifyContent: 'center', minHeight: touch.min },
  saveSlot: { height: SETTINGS_KNOBS.SAVE_SLOT_PX },
  recoveryGrid: { marginBottom: space.sm, marginTop: space.xs },
  updateMeta: { ...type.eyebrow, fontSize: SETTINGS_KNOBS.META_PX, letterSpacing: 0.7, lineHeight: 19 },
});
