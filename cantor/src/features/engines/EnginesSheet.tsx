import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import {
  Coda,
  Constellation,
  Door,
  Fermata,
  PhoneSealMark,
  StationMark,
  FolioHead,
  FOLIO_ACT_STYLE,
  FOLIO_KNOBS,
  FOLIO_NOTE_STYLE,
  FOLIO_TITLE_STYLE,
  Measure,
  PageArrival,
  PanelPressable,
  Rest,
  Row,
  Stave,
  type FolioNav,
} from '../controls';
import { NodeSheet } from './NodeSheet';
import { useFolderPage, usePhonePage, type PhoneActions } from './PhoneSheet';
import { rosterLine } from './phoneState';
import type { DeviceLibraryState } from '../../device/deviceLibrary';
import { DiagnosticsSheet } from './DiagnosticsSheet';
import { diagnostics } from '../../runtime/diagnostics';
import { useStore } from '../../core/useStore';
import { knownModels, nodeState, nodeStateWord } from './nodeState';
import { capitalised, countWord } from './phoneState';
import {
  SettingsSheet,
  settingsMeta,
  type LibraryReport,
  type StorageReport,
} from './SettingsSheet';
import type { SyncSong } from './SyncRow';
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
  /** The song playing, for the sync row; see `SyncRow`. */
  sync?: SyncSong | null;
  /** The phone's own music: the roster's first entry and its page. */
  device: DeviceLibraryState;
  phoneActions: PhoneActions;
  /** Open on the phone's page rather than the roster (the empty field's door). */
  startOn?: 'phone' | null;
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
  sync = null,
  device,
  phoneActions,
  startOn = null,
}: Props) {
  const pal = usePalette();
  const [draftName, setDraftName] = useState('');
  const [page, setPage] = useState<Page>({ kind: 'engines' });
  /**
   * Whether the page shown replaced another since the blind opened: such a
   * page arrives on its own clock; the first arrives with the blind.
   */
  const turned = React.useRef(false);
  const shownPage = React.useRef<Page | null>(null);
  if (!open) {
    turned.current = false;
    shownPage.current = null;
  } else {
    if (shownPage.current !== null && shownPage.current !== page)
      turned.current = true;
    shownPage.current = page;
  }

  const known = useMemo(() => knownModels(backends), [backends]);
  const failures = useStore(diagnostics, state => state);
  const selectedBackend =
    'node' in page
      ? backends?.find(backend => backend.nodePubkey === page.node)
      : undefined;
  const phone = usePhonePage({
    active: open && page.kind === 'phone',
    device,
    actions: phoneActions,
    publicKey,
    onOpenFolder: folder => setPage({ kind: 'folder', folder }),
  });
  const folderPage = useFolderPage({
    device,
    folder: page.kind === 'folder' ? page.folder : null,
    actions: phoneActions,
    onLeft: () => setPage({ kind: 'phone' }),
  });
  const home = () => {
    phone.leave();
    setPage({ kind: 'engines' });
  };
  const close = () => {
    home();
    onClose();
  };
  const isHome = page.kind === 'engines';
  // Before the first paint, so the roster is never shown on the way.
  React.useLayoutEffect(() => {
    if (open && startOn === 'phone') setPage({ kind: 'phone' });
  }, [open, startOn]);
  const { leave } = phone;
  React.useEffect(() => {
    if (open || page.kind === 'engines') return;
    leave();
    setPage({ kind: 'engines' });
  }, [leave, open, page.kind]);
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
    : page.kind === 'diagnostics'
    ? {
        label: '‹ SETTINGS',
        accessibilityLabel: 'Back to settings',
        onPress: () => setPage({ kind: 'settings' }),
      }
    : page.kind === 'folder'
    ? {
        label: '‹ THIS PHONE',
        accessibilityLabel: 'Back to this phone',
        onPress: () => setPage({ kind: 'phone' }),
      }
    : { label: '‹ NODES', accessibilityLabel: 'Back to nodes', onPress: home };

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
        morph
        clef={
          page.kind === 'phone' ? (
            phone.clef
          ) : folderPage !== null ? (
            folderPage.clef
          ) : page.kind === 'settings' || page.kind === 'diagnostics' ? (
            <PhoneSealMark publicKey={publicKey} size={FOLIO_KNOBS.CLEF_PX} />
          ) : page.kind === 'node' && selectedBackend !== undefined ? (
            <StationMark
              models={selectedBackend.lastNodeInfo?.models.length ?? 0}
              nodePublicKey={selectedBackend.nodePubkey}
              size={FOLIO_KNOBS.CLEF_PX}
              state={nodeState(snapshots[selectedBackend.nodePubkey])}
            />
          ) : (
            // The panel's subject is every node, so its clef is all of them.
            <Constellation
              nodes={(backends ?? []).map(backend => ({
                nodePublicKey: backend.nodePubkey,
                models: backend.lastNodeInfo?.models.length ?? 0,
                state: nodeState(snapshots[backend.nodePubkey]),
              }))}
              size={FOLIO_KNOBS.CLEF_PX}
            />
          )
        }
        eyebrow={head.eyebrow}
        meta={
          page.kind === 'phone'
            ? phone.meta
            : folderPage !== null
            ? folderPage.meta
            : head.meta
        }
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
            folderPage?.title ?? head.title
          )
        }
      />
      <View
        key={
          'node' in page
            ? `${page.kind}-${page.node}`
            : 'folder' in page
            ? `${page.kind}-${page.folder}`
            : page.kind
        }
        style={styles.page}
      >
        <PageArrival fresh={turned.current}>
          {page.kind === 'phone' ? (
            phone.body
          ) : folderPage !== null ? (
            folderPage.body
          ) : page.kind === 'settings' ? (
            <SettingsSheet
              budgetBytes={budgetBytes}
              library={library}
              onChangeBudget={onChangeBudget}
              sync={sync}
              failures={failures.length}
              onOpenDiagnostics={() => setPage({ kind: 'diagnostics' })}
              storage={storage}
              visible={open}
            />
          ) : page.kind === 'diagnostics' ? (
            <DiagnosticsSheet failures={failures} />
          ) : page.kind === 'node' ? (
            <NodeSheet
              backend={selectedBackend}
              footprint={footprints[page.node]}
              known={known}
              nameOf={nameOfKey}
              onForget={() => {
                // Held on the node page itself: there is no second page asking.
                home();
                onForget(page.node);
              }}
              snapshot={snapshots[page.node]}
            />
          ) : (
            <>
              <Stave>
                <Measure>
                  <PhoneEntry
                    device={device}
                    onOpen={() => setPage({ kind: 'phone' })}
                    publicKey={publicKey}
                  />
                </Measure>
                <Rest />
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
                        models={backend.lastNodeInfo?.models.length ?? 0}
                        name={nameOf(backend)}
                        nodePublicKey={backend.nodePubkey}
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
                  <Row note="Your key · storage · sync · about">
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
        </PageArrival>
      </View>
    </>
  );
}

/**
 * One node in the roster: its mark where the field names used to hang, its
 * name as a door, and one line of state as a person would say it.
 */
function RosterEntry({
  footprint,
  models,
  name,
  nodePublicKey,
  onOpen,
  snapshot,
}: {
  footprint: BackendFootprint | undefined;
  models: number;
  name: string;
  nodePublicKey: string;
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
          <StationMark
            models={models}
            nodePublicKey={nodePublicKey}
            size={PANEL_KNOBS.STATION_PX}
            state={nodeState(snapshot)}
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

/**
 * The phone, first in the roster and set apart from the nodes by a rest: its
 * seal with the spindle, `This phone` as a door, and one line of state
 * (`f-roster`). New folders are written in ink, because they need you.
 */
function PhoneEntry({
  device,
  onOpen,
  publicKey,
}: {
  device: DeviceLibraryState;
  onOpen: () => void;
  publicKey: string;
}) {
  const pal = usePalette();
  const state = rosterLine(device);
  const colour = state.ink ? pal.ink : pal.muted;
  return (
    <Row
      mark={
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`This phone ${state.words.toLowerCase()}`}
        >
          <PhoneSealMark
            faint={state.faint}
            publicKey={publicKey}
            size={PANEL_KNOBS.STATION_PX}
            spindle
            working={state.working}
          />
        </View>
      }
    >
      <Door
        accessibilityLabel="Open this phone"
        label="This phone"
        name
        onPress={onOpen}
      />
      <View style={styles.line}>
        {state.fermata ? <Fermata colour={colour} /> : null}
        <Text style={[FOLIO_NOTE_STYLE, { color: colour }]}>{state.words}</Text>
      </View>
    </Row>
  );
}

function nameOf(backend: BackendRecord | undefined): string {
  if (backend === undefined) return 'this node';
  return backend.petname || backend.lastNodeInfo?.name || 'this node';
}

type Page =
  | { kind: 'engines' | 'settings' | 'diagnostics' | 'phone' }
  | { kind: 'folder'; folder: string }
  | { kind: 'node'; node: string };

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
    case 'diagnostics':
      return {
        eyebrow: 'DIAGNOSTICS',
        title: 'What went wrong',
        meta: 'LAST 20 · NEWEST FIRST',
      };
    case 'phone':
      // The meta line is the phone page's own (`usePhonePage`).
      return { eyebrow: 'THIS PHONE', title: 'This phone', meta: '' };
    case 'folder':
      // Title and meta are the folder page's own (`useFolderPage`).
      return { eyebrow: 'FOLDER', title: '', meta: '' };
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
  /** A node's station in the roster's label column. */
  STATION_PX: 34,
} as const;

const styles = StyleSheet.create({
  page: { flex: 1 },
  line: { alignItems: 'center', flexDirection: 'row' },
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
