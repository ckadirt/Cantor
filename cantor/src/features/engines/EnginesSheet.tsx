import React, { useMemo, useState } from 'react';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelView } from '../../../../protocol/ModelView';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { AnimatedSymbol } from '../../motion';
import {
  PanelPressable,
  Ledger,
  LedgerFoot,
  LedgerGap,
  Row,
} from '../controls';
import { ModelsSheet } from './ModelsSheet';
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
  /** Pinned only — the songs a forget can still promise will be here. */
  downloaded: number;
  bytesHere: number;
  /** Cached and part-transferred: the loans a forget gives back. */
  borrowed: number;
  borrowedBytes: number;
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
  const reducedMotion = useReducedMotion();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [page, setPage] = useState<
    | { kind: 'engines' | 'settings' }
    | { kind: 'models' | 'forget'; node: string }
  >({ kind: 'engines' });

  // These are models observed on paired nodes, not a compatibility catalogue.
  const known = useMemo(() => {
    const seen = new Map<string, ModelView>();
    for (const backend of backends ?? []) {
      for (const model of backend.lastNodeInfo?.models ?? []) {
        if (!seen.has(model.selector)) seen.set(model.selector, model);
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.selector.localeCompare(b.selector),
    );
  }, [backends]);
  const selectedBackend =
    'node' in page
      ? backends?.find(backend => backend.nodePubkey === page.node)
      : undefined;
  const home = () => setPage({ kind: 'engines' });
  const isHome = page.kind === 'engines';
  const title =
    page.kind === 'forget'
      ? `FORGET ${nameOf(selectedBackend)}`
      : page.kind.toUpperCase();

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
              page.kind === 'settings'
                ? 'identityMark'
                : page.kind === 'forget'
                ? 'partial'
                : 'contourIntegral'
            }
            width={PANEL_KNOBS.SYMBOL_PX}
            height={PANEL_KNOBS.SYMBOL_PX}
            duration={PANEL_KNOBS.MORPH_MS}
            color={pal.ink}
          />
        </View>
        <Text style={[styles.meta, { color: pal.muted }]}>{title}</Text>
        <PanelPressable
          accessibilityLabel={
            isHome
              ? 'Close engines'
              : page.kind === 'forget'
              ? 'Keep it'
              : 'Back to engines'
          }
          accessibilityRole="button"
          hitSlop={space.md}
          onPress={isHome ? onClose : home}
        >
          <Text style={[styles.meta, { color: pal.muted }]}>
            {isHome ? 'CLOSE' : page.kind === 'forget' ? 'KEEP IT' : 'BACK'}
          </Text>
        </PanelPressable>
      </View>
      <Animated.View
        key={'node' in page ? `${page.kind}-${page.node}` : page.kind}
        entering={FadeIn.duration(reducedMotion ? 0 : PANEL_KNOBS.PAGE_FADE_MS)}
        style={styles.page}
      >
        {page.kind === 'settings' ? (
          <SettingsSheet
            budgetBytes={budgetBytes}
            library={library}
            onChangeBudget={onChangeBudget}
            publicKey={publicKey}
            storage={storage}
            visible
          />
        ) : page.kind === 'models' ? (
          <ModelsSheet backend={selectedBackend} known={known} />
        ) : page.kind === 'forget' ? (
          selectedBackend ? (
            <Forget
              backend={selectedBackend}
              footprint={footprints[selectedBackend.nodePubkey]}
              onConfirm={() => {
                home();
                onForget(selectedBackend.nodePubkey);
              }}
            />
          ) : (
            <Text style={[type.body, { color: pal.muted }]}>
              This engine is no longer paired.
            </Text>
          )
        ) : (
          <>
            <ScrollView
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
            >
              <Ledger>
                {backends === null ? (
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      Loading paired nodes…
                    </Text>
                  </Row>
                ) : backends.length === 0 ? (
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      No engine is paired yet.
                    </Text>
                  </Row>
                ) : (
                  backends.map(backend => {
                    const snapshot = snapshots[backend.nodePubkey];
                    const footprint = footprints[backend.nodePubkey];
                    const installed = backend.lastNodeInfo?.models;
                    return (
                      <React.Fragment key={backend.nodePubkey}>
                        <Row label="Engine">
                          <View style={styles.engineHeading}>
                            <View style={styles.engineName}>
                              {renaming === backend.nodePubkey ? (
                                <TextInput
                                  accessibilityLabel={`Rename ${nameOf(
                                    backend,
                                  )}`}
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
                                  accessibilityLabel={`Rename ${nameOf(
                                    backend,
                                  )}`}
                                  accessibilityRole="button"
                                  onPress={() => {
                                    setDraftName(nameOf(backend));
                                    setRenaming(backend.nodePubkey);
                                  }}
                                >
                                  <Text
                                    style={[type.heading, { color: pal.ink }]}
                                  >
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
                                    : !snapshot ||
                                      snapshot.phase === 'disconnected'
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
                        </Row>
                        <Row label="State">
                          <Text style={[type.body, { color: pal.ink }]}>
                            {snapshot?.phase ?? 'disconnected'}
                          </Text>
                        </Row>
                        <Row label="Library">
                          <Text style={[type.body, { color: pal.ink }]}>
                            {footprint
                              ? `${footprint.songs} songs, ${footprint.downloaded} kept here`
                              : 'Not synced yet'}
                          </Text>
                        </Row>
                        <Row
                          label="Models"
                          note={
                            installed
                              ? `${installed.length} installed`
                              : 'Not reported yet'
                          }
                        >
                          <PanelPressable
                            accessibilityRole="button"
                            accessibilityLabel={`All models on ${nameOf(
                              backend,
                            )}`}
                            onPress={() =>
                              setPage({
                                kind: 'models',
                                node: backend.nodePubkey,
                              })
                            }
                          >
                            <Text style={[type.body, { color: pal.ink }]}>
                              All models
                            </Text>
                          </PanelPressable>
                        </Row>
                        {snapshot?.error ? (
                          <Row>
                            <Text
                              accessibilityRole="alert"
                              style={[type.small, { color: pal.ink }]}
                            >
                              {snapshot.error}
                            </Text>
                          </Row>
                        ) : null}
                        <Row
                          label={
                            footprint
                              ? `${footprint.downloaded} kept`
                              : undefined
                          }
                        >
                          <Action
                            label="Forget this engine"
                            accessibilityLabel={`Forget ${nameOf(backend)}`}
                            onPress={() =>
                              setPage({
                                kind: 'forget',
                                node: backend.nodePubkey,
                              })
                            }
                          />
                        </Row>
                        <LedgerGap />
                      </React.Fragment>
                    );
                  })
                )}
                <Row>
                  <Action label="Add a backend" onPress={onPair} />
                </Row>
                <Row>
                  <Action
                    label={refreshing ? 'Refreshing…' : 'Refresh libraries'}
                    onPress={onRefresh}
                    disabled={refreshing}
                  />
                </Row>
              </Ledger>
            </ScrollView>
            <LedgerFoot>
              <Action
                label="Settings"
                onPress={() => setPage({ kind: 'settings' })}
              />
              <Text style={[styles.meta, { color: pal.faint }]}>
                IDENTITY · STORAGE · ABOUT
              </Text>
            </LedgerFoot>
          </>
        )}
      </Animated.View>
    </>
  );
}

/**
 * What forgetting keeps, and what it gives back.
 *
 * A song is here because you asked — `GET` or `KEEP`, which pins it — or
 * because you played it, which leaves a copy the cache budget may reclaim at
 * any download. Only the first is a promise this phone can keep with the node
 * gone, so the sheet counts the two apart rather than calling both
 * "downloaded". Saying `NOTHING TO DELETE` over a loan about to be released
 * would be the sheet's one job done wrong.
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
  const borrowed = footprint?.borrowed ?? 0;
  const gone = songs - downloaded;
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={[type.title, styles.forgetTitle, { color: pal.ink }]}>
        {gone === 1
          ? '1 song leaves the field.'
          : `${gone} songs leave the field.`}
      </Text>
      <Text style={[type.body, { color: pal.muted }]}>
        Downloaded songs stay on this phone, with their playlist tags. Songs
        only cached from listening are given back — the budget could reclaim
        them anyway, and there would be no engine left to ask again.
      </Text>

      <View style={[styles.hairline, { backgroundColor: pal.line }]} />
      <Text style={[styles.meta, { color: pal.muted }]}>WHAT CHANGES</Text>
      <Count
        label={`${downloaded} downloaded`}
        note={downloaded === 0 ? 'NONE ON THIS PHONE' : 'KEPT ON THIS PHONE'}
      />
      <Count
        label={`${borrowed} cached`}
        note={
          borrowed === 0
            ? 'NOTHING BORROWED'
            : `${formatBytes(footprint?.borrowedBytes ?? 0)} GIVEN BACK`
        }
      />
      <Count
        label={`${songs - downloaded - borrowed} not here`}
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

function Action({
  label,
  accessibilityLabel = label,
  onPress,
  disabled = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const pal = usePalette();
  return (
    <PanelPressable
      accessibilityLabel={accessibilityLabel}
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
  ENGINE_SYMBOL_PX: 24,
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
  rename: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
  hairline: { height: 1, marginVertical: space.sm },
  rule: { height: 1, marginTop: space.md },
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
