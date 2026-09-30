import React, { useMemo, useState } from 'react';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelView } from '../../../../protocol/ModelView';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { AnimatedSymbol } from '../../motion';
import {
  Coda,
  FolioHead,
  FOLIO_ACT_STYLE,
  FOLIO_KNOBS,
  FOLIO_NOTE_STYLE,
  Measure,
  PanelPressable,
  Rest,
  Row,
  Stave,
  type FolioNav,
} from '../controls';
import { ModelsSheet } from './ModelsSheet';
import { formatBytes } from '../../lenses';
import {
  SettingsSheet,
  settingsMeta,
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
  open: boolean;
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
  open,
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
  const [page, setPage] = useState<Page>({ kind: 'engines' });

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
  const close = () => {
    home();
    onClose();
  };
  const isHome = page.kind === 'engines';
  React.useEffect(() => {
    if (!open && page.kind !== 'engines') home();
  }, [open, page.kind]);
  const head = headOf(page, {
    backends,
    snapshots,
    footprints,
    selected: selectedBackend,
    publicKey,
  });
  const nav: FolioNav = isHome
    ? { label: 'CLOSE', accessibilityLabel: 'Close nodes', onPress: close }
    : page.kind === 'forget'
    ? { label: 'KEEP IT', accessibilityLabel: 'Keep it', onPress: home }
    : { label: '‹ NODES', accessibilityLabel: 'Back to nodes', onPress: home };

  return (
    <>
      <FolioHead
        clef={
          // One retained glyph across the pages, so a page change morphs the
          // clef rather than replacing it.
          <AnimatedSymbol
            symbol={
              page.kind === 'settings'
                ? 'identityMark'
                : page.kind === 'forget'
                ? 'partial'
                : 'contourIntegral'
            }
            width={FOLIO_KNOBS.CLEF_PX}
            height={FOLIO_KNOBS.CLEF_PX}
            duration={PANEL_KNOBS.MORPH_MS}
            color={pal.ink}
          />
        }
        eyebrow={head.eyebrow}
        meta={head.meta}
        nav={nav}
        title={head.title}
      />
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
            storage={storage}
            visible={open}
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
            <>
              <Stave>
                <Measure>
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      This node is no longer paired.
                    </Text>
                  </Row>
                </Measure>
              </Stave>
              <Coda />
            </>
          )
        ) : (
          <>
            <Stave keyboardShouldPersistTaps="handled">
              {backends === null ? (
                <Measure>
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      Loading paired nodes…
                    </Text>
                  </Row>
                </Measure>
              ) : backends.length === 0 ? (
                <Measure>
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      No node is paired yet.
                    </Text>
                  </Row>
                </Measure>
              ) : (
                backends.map((backend, index) => {
                  const snapshot = snapshots[backend.nodePubkey];
                  const footprint = footprints[backend.nodePubkey];
                  const installed = backend.lastNodeInfo?.models;
                  return (
                    <React.Fragment key={backend.nodePubkey}>
                      {index === 0 ? null : <Rest />}
                      <Measure>
                        <Row label="Node" control>
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
                              accessibilityLabel={`Node ${
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
                          control
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
                            label="Forget this node"
                            accessibilityLabel={`Forget ${nameOf(backend)}`}
                            onPress={() =>
                              setPage({
                                kind: 'forget',
                                node: backend.nodePubkey,
                              })
                            }
                          />
                        </Row>
                      </Measure>
                    </React.Fragment>
                  );
                })
              )}
              <Rest />
              <Measure>
                <Row control>
                  <Action label="Pair a node" onPress={onPair} />
                </Row>
                <Row control>
                  <Action
                    label={refreshing ? 'Refreshing…' : 'Refresh libraries'}
                    onPress={onRefresh}
                    disabled={refreshing}
                  />
                </Row>
              </Measure>
            </Stave>
            <Coda>
              <Action
                display
                label="Settings"
                onPress={() => setPage({ kind: 'settings' })}
              />
              <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
                IDENTITY · STORAGE · ABOUT
              </Text>
            </Coda>
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
  return (
    <>
      <Stave>
        <Measure>
          <Row>
            <Text style={[type.small, { color: pal.muted }]}>
              Downloaded songs stay on this phone, with their playlist tags.
              Songs only cached from listening are given back — the budget could
              reclaim them anyway, and there would be no node left to ask again.
            </Text>
          </Row>
        </Measure>
        <Rest />
        <Measure>
          <Count
            label="Downloaded"
            value={String(downloaded)}
            note={
              downloaded === 0 ? 'NONE ON THIS PHONE' : 'KEPT ON THIS PHONE'
            }
          />
          <Count
            label="Cached"
            value={String(borrowed)}
            note={
              borrowed === 0
                ? 'NOTHING BORROWED'
                : `${formatBytes(footprint?.borrowedBytes ?? 0)} GIVEN BACK`
            }
          />
          <Count
            label="Not here"
            value={String(songs - downloaded - borrowed)}
            note="NOTHING TO DELETE"
          />
          <Count
            label="Playlists"
            value={String(footprint?.playlists ?? 0)}
            note="TAGS LIVE ON THE NODE"
          />
        </Measure>
        <Rest />
        <Measure>
          <Row>
            <Text style={[type.body, { color: pal.ink }]}>
              Nothing is deleted on {nameOf(backend)}. Pair again and everything
              returns.
            </Text>
          </Row>
        </Measure>
      </Stave>
      <Coda>
        <Action display label="Forget it" onPress={onConfirm} />
      </Coda>
    </>
  );
}

function Count({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  const pal = usePalette();
  return (
    <Row label={label} note={note}>
      <Text style={[type.body, { color: pal.ink }]}>{value}</Text>
    </Row>
  );
}

function nameOf(backend: BackendRecord | undefined): string {
  if (backend === undefined) return 'this node';
  return backend.petname || backend.lastNodeInfo?.name || 'this node';
}

/** `Four nodes`: a count said as a word while it is small enough to read as one. */
const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

function countWord(count: number): string {
  return count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

type Page =
  | { kind: 'engines' | 'settings' }
  | { kind: 'models' | 'forget'; node: string };

/** The head each page of this sheet opens on: where, what, and its state. */
function headOf(
  page: Page,
  {
    backends,
    snapshots,
    footprints,
    selected,
    publicKey,
  }: {
    backends: readonly BackendRecord[] | null;
    snapshots: Readonly<Record<string, ConnectionSnapshot>>;
    footprints: Readonly<Record<string, BackendFootprint>>;
    selected: BackendRecord | undefined;
    publicKey: string;
  },
): { eyebrow: string; title: string; meta: string } {
  switch (page.kind) {
    case 'settings':
      return {
        eyebrow: 'SETTINGS',
        title: 'This phone',
        meta: settingsMeta(publicKey),
      };
    case 'models': {
      const installed = selected?.lastNodeInfo?.models;
      return {
        eyebrow: 'MODELS',
        title: nameOf(selected),
        meta: installed
          ? `${countWord(installed.length).toUpperCase()} INSTALLED`
          : 'NOT REPORTED YET',
      };
    }
    case 'forget': {
      const footprint =
        selected === undefined ? undefined : footprints[selected.nodePubkey];
      const gone = (footprint?.songs ?? 0) - (footprint?.downloaded ?? 0);
      return {
        eyebrow: 'FORGET',
        title: nameOf(selected),
        meta: `${gone} SONG${gone === 1 ? '' : 'S'} LEAVE${
          gone === 1 ? 'S' : ''
        } THE FIELD`,
      };
    }
    default: {
      if (backends === null)
        return { eyebrow: 'NODES', title: 'Nodes', meta: 'LOADING' };
      const count = backends.length;
      const ready = backends.filter(
        backend => snapshots[backend.nodePubkey]?.phase === 'ready',
      ).length;
      const songs = backends.reduce(
        (sum, backend) => sum + (footprints[backend.nodePubkey]?.songs ?? 0),
        0,
      );
      return {
        eyebrow: 'NODES',
        title: `${capitalised(countWord(count))} node${count === 1 ? '' : 's'}`,
        meta:
          count === 0
            ? 'NONE PAIRED YET'
            : `${countWord(ready).toUpperCase()} READY · ${songs} SONGS`,
      };
    }
  }
}

function Action({
  label,
  accessibilityLabel = label,
  onPress,
  disabled = false,
  display = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  /** The coda's act, in the display face. */
  display?: boolean;
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
      <Text
        style={[
          display ? FOLIO_ACT_STYLE : type.body,
          { color: disabled ? pal.faint : pal.ink },
        ]}
      >
        {label}
      </Text>
    </PanelPressable>
  );
}

/** KNOBS — the sheet's own glyphs and page transition. */
const PANEL_KNOBS = {
  /** One retained glyph per node: held, exchanging, then connected. */
  ENGINE_SYMBOL_PX: 24,
  PAGE_FADE_MS: 220,
  MORPH_MS: 420,
} as const;

const styles = StyleSheet.create({
  page: { flex: 1 },
  engineHeading: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  engineName: { flex: 1 },
  rename: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
  action: {
    justifyContent: 'center',
    minHeight: touch.min,
  },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const EnginesSheet = React.memo(EnginesSheetImpl);
