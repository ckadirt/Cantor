import React, { useMemo, useState } from 'react';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { AnimatedSymbol } from '../../motion';
import {
  Coda,
  Door,
  FolioHead,
  FOLIO_ACT_STYLE,
  FOLIO_KNOBS,
  FOLIO_NOTE_STYLE,
  FOLIO_TITLE_STYLE,
  Measure,
  PanelPressable,
  Rest,
  Row,
  Stave,
  type FolioNav,
} from '../controls';
import { NodeSheet } from './NodeSheet';
import { knownModels, nodeState, nodeStateWord } from './nodeState';
import { formatBytes } from '../../lenses';
import {
  SettingsSheet,
  settingsMeta,
  type LibraryReport,
  type StorageReport,
} from './SettingsSheet';
import { touch, type, usePalette } from '../../theme/tokens';

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
  const [draftName, setDraftName] = useState('');
  const [page, setPage] = useState<Page>({ kind: 'engines' });

  const known = useMemo(() => knownModels(backends), [backends]);
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
  // The panel syncs when it opens: there is no `Refresh libraries` to press.
  const refreshed = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      refreshed.current = false;
      return;
    }
    if (refreshed.current || refreshing) return;
    refreshed.current = true;
    onRefresh();
  }, [onRefresh, open, refreshing]);
  // The node page's title is its name, renamed in place.
  React.useEffect(() => {
    if (selectedBackend !== undefined) setDraftName(nameOf(selectedBackend));
  }, [selectedBackend?.nodePubkey]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOfKey = (key: string) =>
    nameOf(backends?.find(backend => backend.nodePubkey === key));
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
    ? { label: 'KEEP IT', accessibilityLabel: 'Keep it', onPress: back(page) }
    : { label: '‹ NODES', accessibilityLabel: 'Back to nodes', onPress: home };

  function back(from: Page) {
    return () =>
      'node' in from ? setPage({ kind: 'node', node: from.node }) : home();
  }

  const commitName = () => {
    if (selectedBackend === undefined) return;
    const next = draftName.trim();
    if (next.length > 0 && next !== nameOf(selectedBackend))
      onRename(selectedBackend.nodePubkey, next);
    else setDraftName(nameOf(selectedBackend));
  };

  return (
    <>
      <FolioHead
        clef={
          // One retained glyph across the pages, so a page change morphs the
          // clef rather than replacing it. F4 draws a node's station here.
          <AnimatedSymbol
            symbol={
              page.kind === 'settings'
                ? 'identityMark'
                : page.kind === 'forget'
                ? 'partial'
                : page.kind === 'node'
                ? stateSymbol(snapshots[page.node])
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
        title={
          page.kind === 'node' && selectedBackend !== undefined ? (
            <TextInput
              accessibilityLabel={`Rename ${nameOf(selectedBackend)}`}
              onBlur={commitName}
              onChangeText={setDraftName}
              onSubmitEditing={commitName}
              returnKeyType="done"
              style={[FOLIO_TITLE_STYLE, styles.rename, { color: pal.ink }]}
              value={draftName}
            />
          ) : (
            head.title
          )
        }
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
        ) : page.kind === 'node' ? (
          <NodeSheet
            backend={selectedBackend}
            footprint={footprints[page.node]}
            known={known}
            nameOf={nameOfKey}
            onForget={() => setPage({ kind: 'forget', node: page.node })}
            snapshot={snapshots[page.node]}
          />
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
            <Stave>
              <Measure>
                {backends === null ? (
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      Loading paired nodes…
                    </Text>
                  </Row>
                ) : backends.length === 0 ? (
                  <Row>
                    <Text style={[type.body, { color: pal.muted }]}>
                      No node is paired yet.
                    </Text>
                  </Row>
                ) : (
                  backends.map(backend => (
                    <RosterEntry
                      key={backend.nodePubkey}
                      footprint={footprints[backend.nodePubkey]}
                      name={nameOf(backend)}
                      onOpen={() =>
                        setPage({ kind: 'node', node: backend.nodePubkey })
                      }
                      snapshot={snapshots[backend.nodePubkey]}
                    />
                  ))
                )}
              </Measure>
              <Rest />
              <Measure>
                <Row note="Your key · storage · about">
                  <Door
                    label="Settings"
                    onPress={() => setPage({ kind: 'settings' })}
                  />
                </Row>
              </Measure>
            </Stave>
            <Coda>
              <Action display label="Pair a node" onPress={onPair} />
              <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
                A PC, A MAC OR A SERVER
              </Text>
            </Coda>
          </>
        )}
      </Animated.View>
    </>
  );
}

/**
 * One node in the roster: its mark where the field names used to hang, its
 * name as a door, and one line of state as a person would say it.
 */
function RosterEntry({
  footprint,
  name,
  onOpen,
  snapshot,
}: {
  footprint: BackendFootprint | undefined;
  name: string;
  onOpen: () => void;
  snapshot: ConnectionSnapshot | undefined;
}) {
  const pal = usePalette();
  const offline = nodeState(snapshot) === 'offline';
  const state = nodeStateWord(snapshot);
  return (
    <Row
      mark={
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${name} ${state.toLowerCase()}`}
        >
          <AnimatedSymbol
            symbol={stateSymbol(snapshot)}
            width={PANEL_KNOBS.ENGINE_SYMBOL_PX}
            height={PANEL_KNOBS.ENGINE_SYMBOL_PX}
            duration={PANEL_KNOBS.MORPH_MS}
            color={offline ? pal.faint : pal.ink}
          />
        </View>
      }
    >
      <Door
        accessibilityLabel={`Open ${name}`}
        label={name}
        name
        onPress={onOpen}
        quiet={offline}
      />
      <Text
        style={[FOLIO_NOTE_STYLE, { color: offline ? pal.faint : pal.muted }]}
      >
        {footprint === undefined
          ? state
          : `${state} · ${footprint.songs} SONG${
              footprint.songs === 1 ? '' : 'S'
            }`}
      </Text>
    </Row>
  );
}

/** Until F4's station: the glyph that has always said a node's state. */
function stateSymbol(
  snapshot: ConnectionSnapshot | undefined,
): 'infinity' | 'fermata' | 'interchange' {
  const state = nodeState(snapshot);
  return state === 'offline'
    ? 'fermata'
    : state === 'connecting'
    ? 'interchange'
    : 'infinity';
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
  | { kind: 'node' | 'forget'; node: string };

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
    case 'node': {
      if (selected === undefined)
        return { eyebrow: 'NODE', title: nameOf(selected), meta: '' };
      const index =
        (backends ?? []).findIndex(
          backend => backend.nodePubkey === selected.nodePubkey,
        ) + 1;
      const info = selected.lastNodeInfo;
      return {
        eyebrow: `NODE · ${index} OF ${backends?.length ?? 1}`,
        title: nameOf(selected),
        meta: [
          nodeStateWord(snapshots[selected.nodePubkey]),
          info?.device_type,
          info?.engine_version,
        ]
          .filter(
            (part): part is string => typeof part === 'string' && part !== '',
          )
          .join(' · ')
          .toUpperCase(),
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
  /** The node's name, renamed where it stands: no box, as the caption. */
  rename: { includeFontPadding: false, padding: 0 },
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
