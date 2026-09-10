import React, { useMemo, useState } from 'react';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelView } from '../../../../protocol/ModelView';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { AnimatedSymbol } from '../../motion';
import { PanelPressable } from './PanelPressable';
import { formatBytes } from '../../lenses';
import {
  SettingsSheet,
  type LibraryReport,
  type StorageReport,
} from './SettingsSheet';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** What one node's songs weigh on this phone, and how many there are. */
export type BackendFootprint = Readonly<{
  songs: number;
  downloaded: number;
  bytesHere: number;
  playlists: number;
}>;

type Props = {
  backends: readonly BackendRecord[] | null;
  snapshots: Readonly<Record<string, ConnectionSnapshot>>;
  refreshing: boolean;
  /** What forgetting each node would actually take, keyed by public key. */
  footprints: Readonly<Record<string, BackendFootprint>>;
  onClose: () => void;
  onPair: () => void;
  onRefresh: () => void;
  onRename: (nodePublicKey: string, petname: string) => void;
  onForget: (nodePublicKey: string) => void;
  /** Settings hangs off this sheet's foot; everything it shows comes from here. */
  publicKey: string;
  library: LibraryReport;
  storage: StorageReport;
  budgetBytes: number;
  onChangeBudget: (bytes: number) => void;
};

/**
 * Every paired node, what it can run, and what forgetting it would cost.
 *
 * Conventional management belongs in a sheet rather than in the zoom hierarchy:
 * this is list-and-form work, and giving it a distance in the field would make
 * the zoom model mean two different things.
 *
 * The sheet is only its contents. Presence, the surface it is drawn on and the
 * way it arrives belong to the `Curtain` it hangs in — the same blind the
 * composer hangs in, pulled from the other edge — so this is a fragment, and
 * for the same reason `ComposerSheet` is one.
 */
function EnginesSheetImpl({
  backends,
  snapshots,
  refreshing,
  footprints,
  onClose,
  onPair,
  onRefresh,
  onRename,
  onForget,
  publicKey,
  library,
  storage,
  budgetBytes,
  onChangeBudget,
}: Props) {
  const pal = usePalette();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Models any paired node has installed.
   *
   * The only honest way to say a node is *missing* something: the app cannot
   * know a catalogue it was never told about, but it does know that the phone
   * next to this one is running `acestep:1.5-fast`. That is exactly the case
   * `cantor pull …` fixes.
   */
  const known = useMemo(() => {
    const seen = new Map<string, ModelView>();
    for (const backend of backends ?? []) {
      for (const model of backend.lastNodeInfo?.models ?? []) {
        if (!seen.has(model.selector)) seen.set(model.selector, model);
      }
    }
    return [...seen.values()].sort((left, right) =>
      left.selector.localeCompare(right.selector),
    );
  }, [backends]);

  const target = forgetting;
  const targetBackend = (backends ?? []).find(
    backend => backend.nodePubkey === target,
  );

  return (
    <>
      <View style={[styles.header, { borderColor: pal.line }]}>
        <View
          style={styles.headingMark}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          <AnimatedSymbol
            symbol={
              settingsOpen
                ? 'identityMark'
                : target
                ? 'partial'
                : 'contourIntegral'
            }
            width={PANEL_KNOBS.SYMBOL_PX}
            height={PANEL_KNOBS.SYMBOL_PX}
            duration={PANEL_KNOBS.MORPH_MS}
            color={pal.ink}
          />
        </View>
        <Text style={[styles.meta, { color: pal.muted }]}>
          {settingsOpen
            ? 'SETTINGS'
            : target === null
            ? 'ENGINES'
            : `FORGET ${nameOf(targetBackend)}`}
        </Text>
        <PanelPressable
          accessibilityLabel={
            settingsOpen
              ? 'Back to engines'
              : target === null
              ? 'Close engines'
              : 'Keep it'
          }
          accessibilityRole="button"
          hitSlop={space.md}
          onPress={() => {
            if (settingsOpen) setSettingsOpen(false);
            else if (target === null) onClose();
            else setForgetting(null);
          }}
        >
          <Text style={[styles.meta, { color: pal.muted }]}>
            {settingsOpen ? 'ENGINES' : target === null ? 'CLOSE' : 'KEEP IT'}
          </Text>
        </PanelPressable>
      </View>

      <Animated.View
        key={settingsOpen ? 'settings' : target ?? 'engines'}
        entering={FadeIn.duration(PANEL_KNOBS.PAGE_FADE_MS)}
        style={styles.page}
      >
        {settingsOpen ? (
          <SettingsSheet
            budgetBytes={budgetBytes}
            library={library}
            onChangeBudget={onChangeBudget}
            publicKey={publicKey}
            storage={storage}
            visible
          />
        ) : target !== null && targetBackend !== undefined ? (
          <Forget
            backend={targetBackend}
            footprint={footprints[target]}
            onConfirm={() => {
              setForgetting(null);
              onForget(target);
            }}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {backends === null ? (
              <Text style={[type.body, { color: pal.muted }]}>
                Loading paired nodes…
              </Text>
            ) : backends.length === 0 ? (
              <Text style={[type.body, { color: pal.muted }]}>
                No engine is paired yet.
              </Text>
            ) : (
              backends.map(backend => {
                const snapshot = snapshots[backend.nodePubkey];
                const footprint = footprints[backend.nodePubkey];
                const installed = backend.lastNodeInfo?.models ?? [];
                const missing = known.filter(
                  model =>
                    !installed.some(entry => entry.selector === model.selector),
                );
                return (
                  <View
                    key={backend.nodePubkey}
                    style={[styles.backend, { borderColor: pal.line }]}
                  >
                    <View style={styles.engineHeading}>
                      <View style={styles.engineName}>
                        {renaming === backend.nodePubkey ? (
                          <TextInput
                            accessibilityLabel={`Rename ${nameOf(backend)}`}
                            autoFocus
                            onBlur={() => setRenaming(null)}
                            onChangeText={setDraftName}
                            onSubmitEditing={() => {
                              onRename(backend.nodePubkey, draftName);
                              setRenaming(null);
                            }}
                            returnKeyType="done"
                            style={[
                              styles.rename,
                              type.heading,
                              { borderColor: pal.line, color: pal.ink },
                            ]}
                            value={draftName}
                          />
                        ) : (
                          <PanelPressable
                            accessibilityLabel={`Rename ${nameOf(backend)}`}
                            accessibilityRole="button"
                            onPress={() => {
                              setDraftName(nameOf(backend));
                              setRenaming(backend.nodePubkey);
                            }}
                          >
                            <Text style={[type.heading, { color: pal.ink }]}>
                              {nameOf(backend)}
                            </Text>
                          </PanelPressable>
                        )}
                      </View>
                      <View
                        accessible
                        accessibilityRole="image"
                        accessibilityLabel={`Engine ${
                          snapshot?.phase ?? 'disconnected'
                        }`}
                      >
                        <AnimatedSymbol
                          symbol={
                            snapshot?.phase === 'ready'
                              ? 'infinity'
                              : !snapshot || snapshot.phase === 'disconnected'
                              ? 'fermata'
                              : 'interchange'
                          }
                          width={PANEL_KNOBS.ENGINE_SYMBOL_PX}
                          height={PANEL_KNOBS.ENGINE_SYMBOL_PX}
                          duration={PANEL_KNOBS.MORPH_MS}
                          color={pal.ink}
                        />
                      </View>
                    </View>
                    <Text style={[styles.meta, { color: pal.muted }]}>
                      {stateLine(snapshot, footprint)}
                    </Text>

                    {installed.map(model => (
                      <View
                        key={model.selector}
                        style={[styles.model, { borderColor: pal.line }]}
                      >
                        <Text style={[type.body, { color: pal.ink }]}>
                          {model.selector}
                        </Text>
                        <Text style={[styles.meta, { color: pal.muted }]}>
                          {installedLine(model)}
                        </Text>
                      </View>
                    ))}
                    {missing.map(model => (
                      <View
                        key={model.selector}
                        style={[styles.model, { borderColor: pal.line }]}
                      >
                        <Text style={[type.body, { color: pal.faint }]}>
                          {model.selector}
                        </Text>
                        <Text style={[styles.meta, { color: pal.muted }]}>
                          NOT INSTALLED
                        </Text>
                        {/* The command that fixes it, in full, to be copied. */}
                        <Text
                          selectable
                          style={[
                            styles.command,
                            type.mono,
                            { backgroundColor: pal.line, color: pal.ink },
                          ]}
                        >
                          cantor pull {model.selector}
                        </Text>
                      </View>
                    ))}

                    {snapshot?.error ? (
                      <Text
                        accessibilityRole="alert"
                        style={[type.mono, { color: pal.ink }]}
                      >
                        {snapshot.error}
                      </Text>
                    ) : null}

                    <PanelPressable
                      accessibilityLabel={`Forget ${nameOf(backend)}`}
                      accessibilityRole="button"
                      style={styles.forgetAction}
                      onPress={() => setForgetting(backend.nodePubkey)}
                    >
                      <Text style={[styles.meta, { color: pal.muted }]}>
                        FORGET THIS ENGINE
                      </Text>
                    </PanelPressable>
                  </View>
                );
              })
            )}

            <Action label="Add a backend" onPress={onPair} />
            <Action
              label={refreshing ? 'Refreshing…' : 'Refresh libraries'}
              onPress={onRefresh}
              disabled={refreshing}
            />

            {/*
            The app itself is the least interesting thing in the room, so
            it sits at the very foot, behind an ink rule.
          */}
            <View style={[styles.rule, { backgroundColor: pal.ink }]} />
            <PanelPressable
              accessibilityLabel="Settings"
              accessibilityRole="button"
              onPress={() => setSettingsOpen(true)}
              style={styles.action}
            >
              <Text style={[type.body, { color: pal.ink }]}>Settings</Text>
            </PanelPressable>
            <Text style={[styles.meta, { color: pal.muted }]}>
              IDENTITY · STORAGE · ABOUT
            </Text>
          </ScrollView>
        )}
      </Animated.View>
    </>
  );
}

/**
 * What forgetting takes, counted rather than described.
 *
 * Every song in the field belongs to the node that made it, downloaded or not,
 * so the count is the whole library and not just the part on this phone. The
 * last line is the one that makes it survivable: nothing is deleted over there.
 */
function Forget({
  backend,
  footprint,
  onConfirm,
}: {
  backend: BackendRecord;
  footprint: BackendFootprint | undefined;
  onConfirm: () => void;
}) {
  const pal = usePalette();
  const songs = footprint?.songs ?? 0;
  const downloaded = footprint?.downloaded ?? 0;
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={[type.title, styles.forgetTitle, { color: pal.ink }]}>
        {songs === 1
          ? 'Its one song leaves this phone.'
          : `All ${songs} of its songs leave this phone.`}
      </Text>
      <Text style={[type.body, { color: pal.muted }]}>
        Downloaded or not — every song in the field belongs to the node that
        made it.
      </Text>

      <View style={[styles.hairline, { backgroundColor: pal.line }]} />
      <Text style={[styles.meta, { color: pal.muted }]}>WHAT GOES</Text>
      <Count
        label={`${downloaded} downloaded`}
        note={
          downloaded === 0
            ? 'NOTHING TO DELETE'
            : `${formatBytes(footprint?.bytesHere ?? 0)} DELETED HERE`
        }
      />
      <Count
        label={`${songs - downloaded} not downloaded`}
        note="NOTHING TO DELETE"
      />
      <Count
        label={`${footprint?.playlists ?? 0} playlists`}
        note="TAGS LIVE ON THE NODE"
      />

      <View style={[styles.hairline, { backgroundColor: pal.line }]} />
      <Text style={[type.body, { color: pal.ink }]}>
        Nothing is deleted on {nameOf(backend)}. Pair again and everything
        returns.
      </Text>

      <View style={[styles.rule, { backgroundColor: pal.ink }]} />
      <PanelPressable
        accessibilityLabel="Forget it"
        accessibilityRole="button"
        onPress={onConfirm}
        style={styles.confirm}
      >
        <Text style={[type.title, styles.confirmWord, { color: pal.ink }]}>
          Forget it
        </Text>
      </PanelPressable>
    </ScrollView>
  );
}

function Count({ label, note }: { label: string; note: string }) {
  const pal = usePalette();
  return (
    <View style={styles.count}>
      <Text style={[type.body, { color: pal.ink }]}>{label}</Text>
      <Text style={[styles.meta, { color: pal.muted }]}>{note}</Text>
    </View>
  );
}

function nameOf(backend: BackendRecord | undefined): string {
  if (backend === undefined) return 'this engine';
  return backend.petname || backend.lastNodeInfo?.name || 'this engine';
}

/** `READY · 23 SONGS · 6 HERE`, or why it is not ready. */
function stateLine(
  snapshot: ConnectionSnapshot | undefined,
  footprint: BackendFootprint | undefined,
): string {
  const phase = (snapshot?.phase ?? 'disconnected').toUpperCase();
  if (footprint === undefined || footprint.songs === 0) return phase;
  return `${phase} · ${footprint.songs} SONGS · ${footprint.downloaded} HERE`;
}

/** `INSTALLED · FOUR STAGES`, when the model said how many it runs. */
function installedLine(model: ModelView): string {
  const stages = model.stages?.length ?? 0;
  if (stages === 0) return 'INSTALLED';
  return `INSTALLED · ${STAGE_WORDS[stages] ?? stages} STAGE${
    stages === 1 ? '' : 'S'
  }`;
}

const STAGE_WORDS: Record<number, string> = {
  1: 'ONE',
  2: 'TWO',
  3: 'THREE',
  4: 'FOUR',
  5: 'FIVE',
  6: 'SIX',
};

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const pal = usePalette();
  return (
    <PanelPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled, busy: disabled }}
      onPress={onPress}
      style={styles.action}
    >
      <Text style={[type.body, { color: disabled ? pal.faint : pal.ink }]}>
        {label}
      </Text>
    </PanelPressable>
  );
}

/** KNOBS — header geometry and the shared symbol transition. */
const PANEL_KNOBS = {
  SYMBOL_PX: 40,
  /** One retained glyph per node: held, exchanging, then connected. */
  ENGINE_SYMBOL_PX: 48,
  PAGE_FADE_MS: 220,
  ACTION_PX: 56,
  MORPH_MS: 420,
  META_PX: 12,
} as const;

const styles = StyleSheet.create({
  page: { flex: 1 },
  engineHeading: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  engineName: { flex: 1 },
  meta: {
    ...type.eyebrow,
    fontSize: PANEL_KNOBS.META_PX,
    letterSpacing: 0.7,
    lineHeight: 19,
  },
  headingMark: { marginRight: space.sm },
  forgetAction: {
    minHeight: touch.min,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    paddingBottom: space.sm,
    minHeight: PANEL_KNOBS.ACTION_PX,
    gap: space.sm,
  },
  body: { gap: space.sm, paddingBottom: space.xxl, paddingTop: space.md },
  backend: {
    gap: space.sm,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    marginBottom: space.sm,
  },
  rename: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
  hairline: { height: 1, marginVertical: space.sm },
  rule: { height: 1, marginTop: space.md },
  model: { gap: space.sm, paddingVertical: space.md },
  command: { padding: space.sm },
  count: { gap: 2, paddingTop: space.sm },
  forgetTitle: { fontSize: 20, lineHeight: 29 },
  action: {
    justifyContent: 'center',
    minHeight: PANEL_KNOBS.ACTION_PX,
  },
  confirm: { justifyContent: 'center', minHeight: touch.min },
  confirmWord: { fontSize: 17 },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const EnginesSheet = React.memo(EnginesSheetImpl);
