import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { JobView } from '../../../protocol/JobView';
import type { SongHeader } from '../../../protocol/SongHeader';
import type { SongDetail } from '../../../protocol/SongDetail';
import type { SongPatch } from '../../../protocol/SongPatch';
import type { ArtifactView } from '../../../protocol/ArtifactView';
import type { AppIdentity } from '../identity/derive';
import { PairBackendModal } from '../backends/PairBackendModal';
import { BackendConnection, NodeRequestError } from '../backends/connection';
import { loadBackends, saveBackends } from '../backends/storage';
import type {
  BackendRecord,
  ConnectionPhase,
  ConnectionSnapshot,
  NodeInfo,
  PairingRequest,
} from '../backends/types';
import { space, touch, type, usePalette } from '../theme/tokens';
import {
  loadOutbox,
  markAccepted,
  markRejected,
  putPending,
  type OutboxEntry,
} from '../jobs/outbox';
import { loadJobs, mergeJobs, mergeJobViews } from '../jobs/repository';
import {
  commitLibrary,
  loadLibrary,
  mergeSongHeaders,
} from '../library/repository';
import { filterLibraryRows, type LibraryFilter } from '../library/query';
import {
  appendAudioChunk,
  audioKey,
  finalizeAudio,
  inspectAudio,
  pinAudio,
  playAudio,
  removeAudio,
  unpinAudio,
} from '../audio/repository';
import type { LocalAudio } from '../audio/native';

const READY_BACKGROUND_LIGHT = '#EFF8F0';
const READY_BACKGROUND_DARK = '#0B2110';
const READY_BORDER_LIGHT = '#73A97B';
const READY_BORDER_DARK = '#70B67A';
const NO_MODELS: NodeInfo['models'] = [];

const DEFAULT_SNAPSHOT: ConnectionSnapshot = {
  phase: 'disconnected',
  error: null,
  jobs: [],
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
};

type Props = {
  identity: AppIdentity;
};

type LiveConnection = {
  relayUrl: string;
  connection: BackendConnection;
};

type JobControl = 'pause' | 'resume' | 'cancel' | 'retry';
type AudioAction = 'download-play' | 'play' | 'pin' | 'unpin' | 'remove';

export function MainScreen({ identity }: Props) {
  const pal = usePalette();
  const dark = pal.bg === '#000000';
  const [backends, setBackends] = useState<BackendRecord[] | null>(null);
  const [snapshots, setSnapshots] = useState<
    Record<string, ConnectionSnapshot>
  >({});
  const [pairing, setPairing] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [localAudio, setLocalAudio] = useState<Record<string, LocalAudio>>({});
  const backendsRef = useRef<BackendRecord[]>([]);
  const connections = useRef(new Map<string, LiveConnection>());
  const pairTokens = useRef(new Map<string, string>());
  const outboxInFlight = useRef(new Set<string>());

  const sendOutbox = useCallback(
    async (connection: BackendConnection, entry: OutboxEntry) => {
      if (outboxInFlight.current.has(entry.clientRequestId)) return;
      outboxInFlight.current.add(entry.clientRequestId);
      try {
        const job = await connection.createJob(
          entry.clientRequestId,
          entry.model,
          entry.generation,
        );
        await markAccepted(entry.clientRequestId, job.id);
      } catch (error) {
        if (error instanceof NodeRequestError && !error.retryable) {
          await markRejected(entry.clientRequestId, error.message);
        }
        throw error;
      } finally {
        outboxInFlight.current.delete(entry.clientRequestId);
      }
    },
    [],
  );

  const replaceBackends = useCallback((next: BackendRecord[]) => {
    backendsRef.current = next;
    setBackends(next);
    saveBackends(next).catch(error => setStorageError(readError(error)));
  }, []);

  useEffect(() => {
    let active = true;
    loadBackends()
      .then(loaded => {
        if (active) {
          backendsRef.current = loaded;
          setBackends(loaded);
        }
      })
      .catch(error => {
        if (active) {
          setStorageError(readError(error));
          backendsRef.current = [];
          setBackends([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const rememberNodeInfo = useCallback(
    (nodePubkey: string, info: NodeInfo) => {
      const current = backendsRef.current;
      const existing = current.find(item => item.nodePubkey === nodePubkey);
      if (
        existing &&
        JSON.stringify(existing.lastNodeInfo) === JSON.stringify(info)
      ) {
        return;
      }
      replaceBackends(
        current.map(item =>
          item.nodePubkey === nodePubkey
            ? { ...item, lastNodeInfo: info }
            : item,
        ),
      );
    },
    [replaceBackends],
  );

  useEffect(() => {
    if (backends === null) {
      return;
    }
    const wanted = new Set(backends.map(backend => backend.nodePubkey));
    for (const [nodePubkey, live] of connections.current) {
      if (!wanted.has(nodePubkey)) {
        live.connection.stop();
        connections.current.delete(nodePubkey);
      }
    }
    for (const backend of backends) {
      loadJobs(backend.nodePubkey)
        .then(jobs =>
          setSnapshots(previous => ({
            ...previous,
            [backend.nodePubkey]: {
              ...(previous[backend.nodePubkey] ?? DEFAULT_SNAPSHOT),
              jobs: mergeJobViews(
                previous[backend.nodePubkey]?.jobs ?? [],
                jobs,
              ),
            },
          })),
        )
        .catch(error => setStorageError(readError(error)));
      loadLibrary(backend.nodePubkey)
        .then(library =>
          setSnapshots(previous => ({
            ...previous,
            [backend.nodePubkey]: {
              ...(previous[backend.nodePubkey] ?? DEFAULT_SNAPSHOT),
              songs: mergeSongHeaders(
                previous[backend.nodePubkey]?.songs ?? [],
                library.songs,
              ),
              libraryRevision:
                previous[backend.nodePubkey]?.libraryRevision ??
                library.revision,
            },
          })),
        )
        .catch(error => setStorageError(readError(error)));
      const current = connections.current.get(backend.nodePubkey);
      if (current?.relayUrl === backend.relayUrl) {
        continue;
      }
      current?.connection.stop();
      const connection = new BackendConnection(
        backend,
        identity,
        pairTokens.current.get(backend.nodePubkey),
        {
          onSnapshot: snapshot => {
            setSnapshots(previous => ({
              ...previous,
              [backend.nodePubkey]: {
                ...snapshot,
                jobs: mergeJobViews(
                  previous[backend.nodePubkey]?.jobs ?? [],
                  snapshot.jobs,
                ),
                songs:
                  snapshot.libraryRevision === null
                    ? mergeSongHeaders(
                        previous[backend.nodePubkey]?.songs ?? [],
                        snapshot.songs,
                      )
                    : snapshot.songs,
                libraryRevision:
                  snapshot.libraryRevision ??
                  previous[backend.nodePubkey]?.libraryRevision ??
                  null,
              },
            }));
            if (snapshot.jobs.length > 0) {
              mergeJobs(backend.nodePubkey, snapshot.jobs)
                .then(jobs =>
                  setSnapshots(previous => ({
                    ...previous,
                    [backend.nodePubkey]: {
                      ...(previous[backend.nodePubkey] ?? snapshot),
                      jobs: mergeJobViews(
                        previous[backend.nodePubkey]?.jobs ?? [],
                        jobs,
                      ),
                    },
                  })),
                )
                .catch(error => setStorageError(readError(error)));
            }
            if (snapshot.libraryRevision !== null && !snapshot.librarySyncing) {
              commitLibrary(
                backend.nodePubkey,
                snapshot.libraryRevision,
                snapshot.songs,
              ).catch(error => setStorageError(readError(error)));
            }
            if (snapshot.phase === 'ready') {
              loadOutbox()
                .then(entries =>
                  Promise.all(
                    entries
                      .filter(
                        entry =>
                          entry.nodePublicKey === backend.nodePubkey &&
                          entry.state === 'pending',
                      )
                      .map(entry => sendOutbox(connection, entry)),
                  ),
                )
                .catch(error => setStorageError(readError(error)));
            }
          },
          onNodeInfo: info => rememberNodeInfo(backend.nodePubkey, info),
          onPairTokenConsumed: () =>
            pairTokens.current.delete(backend.nodePubkey),
        },
      );
      connections.current.set(backend.nodePubkey, {
        relayUrl: backend.relayUrl,
        connection,
      });
      connection.start();
    }
  }, [backends, identity, rememberNodeInfo, sendOutbox]);

  useEffect(
    () => () => {
      for (const live of connections.current.values()) {
        live.connection.stop();
      }
      connections.current.clear();
    },
    [],
  );

  const handlePair = useCallback(
    (request: PairingRequest) => {
      const nodePubkey = request.backend.nodePubkey;
      pairTokens.current.set(nodePubkey, request.pairToken);
      connections.current.get(nodePubkey)?.connection.stop();
      connections.current.delete(nodePubkey);
      const existing = backendsRef.current.find(
        backend => backend.nodePubkey === nodePubkey,
      );
      const backend = {
        ...request.backend,
        lastNodeInfo: existing?.lastNodeInfo ?? null,
      };
      replaceBackends([
        ...backendsRef.current.filter(item => item.nodePubkey !== nodePubkey),
        backend,
      ]);
      setPairing(false);
    },
    [replaceBackends],
  );

  const handleSubmit = useCallback(
    async (
      nodePublicKey: string,
      model: string,
      generation: GenerationRequest,
    ) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Backend is not connected.');
      const entry = await putPending(nodePublicKey, model, generation);
      await sendOutbox(live.connection, entry);
    },
    [sendOutbox],
  );

  const handleSongPatch = useCallback(
    async (nodePublicKey: string, song: SongHeader, patch: SongPatch) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Song node is not connected.');
      await live.connection.patchSong(song.id, song.revision, patch);
    },
    [],
  );

  const handleJobControl = useCallback(
    async (nodePublicKey: string, job: JobView, control: JobControl) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Job node is not connected.');
      await live.connection.controlJob(control, job.id, job.revision);
    },
    [],
  );

  const handleSongPresence = useCallback(
    async (nodePublicKey: string, song: SongHeader) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Song node is not connected.');
      if (song.trashed) {
        await live.connection.restoreSong(song.id, song.revision);
      } else {
        await live.connection.trashSong(song.id, song.revision);
      }
    },
    [],
  );

  const handleSongDetail = useCallback(
    async (nodePublicKey: string, songId: string) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Song node is not connected.');
      return live.connection.getSong(songId);
    },
    [],
  );

  const updateLocalAudio = useCallback(
    (nodeKey: string, songId: string, digest: string, state: LocalAudio) => {
      setLocalAudio(current => ({
        ...current,
        [audioKey(nodeKey, songId, digest)]: state,
      }));
    },
    [],
  );

  const handleAudio = useCallback(
    async (
      nodeKey: string,
      song: SongHeader,
      artifact: ArtifactView,
      action: AudioAction,
    ) => {
      const identify = () => inspectAudio(nodeKey, song.id, artifact.sha256);
      if (action === 'download-play') {
        const live = connections.current.get(nodeKey);
        if (live === undefined) throw new Error('Song node is not connected.');
        const before = await identify();
        if (before.state !== 'cached' && before.state !== 'pinned') {
          await live.connection.downloadArtifact(
            song.id,
            artifact,
            {
              offset: async () => {
                const local = await identify();
                return local.state === 'partial' ? local.bytes : 0;
              },
              append: (offset, data) =>
                appendAudioChunk(
                  nodeKey,
                  song.id,
                  artifact.sha256,
                  offset,
                  data,
                ),
              finalize: bytes =>
                finalizeAudio(nodeKey, song.id, artifact.sha256, bytes),
            },
            (bytes, total) =>
              updateLocalAudio(nodeKey, song.id, artifact.sha256, {
                state: bytes === total ? 'cached' : 'partial',
                bytes,
              }),
          );
        }
        await playAudio(nodeKey, song.id, artifact.sha256);
      } else if (action === 'play') {
        await playAudio(nodeKey, song.id, artifact.sha256);
      } else if (action === 'pin') {
        await pinAudio(nodeKey, song.id, artifact.sha256);
      } else if (action === 'unpin') {
        await unpinAudio(nodeKey, song.id, artifact.sha256);
      } else {
        await removeAudio(nodeKey, song.id, artifact.sha256);
      }
      updateLocalAudio(
        nodeKey,
        song.id,
        artifact.sha256,
        await identify(),
      );
    },
    [updateLocalAudio],
  );

  useEffect(() => {
    let active = true;
    const entries = (backends ?? []).flatMap(backend =>
      (snapshots[backend.nodePubkey]?.songs ?? []).flatMap(song => {
        const artifact = deliveryArtifact(song);
        return artifact === undefined ? [] : [[backend.nodePubkey, song, artifact] as const];
      }),
    );
    Promise.all(
      entries.map(async ([nodeKey, song, artifact]) => ({
        key: audioKey(nodeKey, song.id, artifact.sha256),
        state: await inspectAudio(nodeKey, song.id, artifact.sha256),
      })),
    )
      .then(inspected => {
        if (!active) return;
        setLocalAudio(current => ({
          ...current,
          ...Object.fromEntries(inspected.map(entry => [entry.key, entry.state])),
        }));
      })
      .catch(error => {
        if (active) setStorageError(readError(error));
      });
    return () => {
      active = false;
    };
  }, [backends, snapshots]);

  const refreshLibraries = useCallback(() => {
    for (const live of connections.current.values()) {
      live.connection.refreshLibrary();
    }
  }, []);

  const libraryRows = (backends ?? [])
    .flatMap(backend =>
      (snapshots[backend.nodePubkey]?.songs ?? []).map(song => ({
        backend,
        song,
        delivery: deliveryArtifact(song),
        local:
          localAudio[
            audioKey(
              backend.nodePubkey,
              song.id,
              deliveryArtifact(song)?.sha256 ?? 'none',
            )
          ] ?? { state: 'remote', bytes: 0 },
        availableOffline: ['cached', 'pinned'].includes(
          localAudio[
            audioKey(
              backend.nodePubkey,
              song.id,
              deliveryArtifact(song)?.sha256 ?? 'none',
            )
          ]?.state ?? 'remote',
        ),
        ready: snapshots[backend.nodePubkey]?.phase === 'ready',
        nodeLabels: [
          backend.petname,
          backend.lastNodeInfo?.name ?? '',
          backend.nodePubkey,
        ],
      })),
    )
    .sort(
      (left, right) =>
        right.song.created_at.localeCompare(left.song.created_at) ||
        right.song.id.localeCompare(left.song.id),
    );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: pal.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={Object.values(snapshots).some(
              snapshot => snapshot.librarySyncing,
            )}
            onRefresh={refreshLibraries}
            tintColor={pal.muted}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.eyebrow, { color: pal.muted }]}>CANTOR</Text>
        <Text style={[type.title, styles.title, { color: pal.ink }]}>
          Library
        </Text>
        <Text style={[type.small, styles.identity, { color: pal.faint }]}>
          APP KEY · {shortKey(identity.publicKey)}
        </Text>

        {storageError ? (
          <Text
            accessibilityRole="alert"
            style={[type.small, styles.error, { color: pal.ink }]}
          >
            {storageError}
          </Text>
        ) : null}

        <LibraryTimeline
          rows={libraryRows}
          onDetail={handleSongDetail}
          onPatch={handleSongPatch}
          onPresence={handleSongPresence}
          onAudio={handleAudio}
          onError={error => setStorageError(readError(error))}
        />

        <Text style={[type.eyebrow, styles.sectionLabel, { color: pal.faint }]}>
          BACKENDS
        </Text>

        {backends === null ? (
          <Text style={[type.body, { color: pal.muted }]}>
            Loading backends…
          </Text>
        ) : backends.length === 0 ? (
          <View style={[styles.empty, { borderColor: pal.line }]}>
            <Text style={[type.heading, { color: pal.ink }]}>
              No backend paired
            </Text>
            <Text style={[type.body, styles.emptyBody, { color: pal.muted }]}>
              Pair your computer to let Cantor discover its ACE-Step engine.
            </Text>
          </View>
        ) : (
          backends.map(backend => (
            <BackendCard
              key={backend.nodePubkey}
              backend={backend}
              snapshot={snapshots[backend.nodePubkey] ?? DEFAULT_SNAPSHOT}
              readyBackground={
                dark ? READY_BACKGROUND_DARK : READY_BACKGROUND_LIGHT
              }
              readyBorder={dark ? READY_BORDER_DARK : READY_BORDER_LIGHT}
              onSubmit={handleSubmit}
              onJobControl={handleJobControl}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setPairing(true)}
          style={[styles.pairButton, { borderColor: pal.ink }]}
        >
          <Text style={[type.mono, { color: pal.ink }]}>Pair a backend</Text>
        </Pressable>
      </View>

      <PairBackendModal
        visible={pairing}
        onClose={() => setPairing(false)}
        onPair={handlePair}
      />
    </SafeAreaView>
  );
}

type LibraryRow = {
  backend: BackendRecord;
  song: SongHeader;
  delivery: ArtifactView | undefined;
  local: LocalAudio;
  availableOffline: boolean;
  ready: boolean;
  nodeLabels: string[];
};

function LibraryTimeline({
  rows,
  onDetail,
  onPatch,
  onPresence,
  onAudio,
  onError,
}: {
  rows: LibraryRow[];
  onDetail: (nodePublicKey: string, songId: string) => Promise<SongDetail>;
  onPatch: (
    nodePublicKey: string,
    song: SongHeader,
    patch: SongPatch,
  ) => Promise<void>;
  onPresence: (nodePublicKey: string, song: SongHeader) => Promise<void>;
  onAudio: (
    nodePublicKey: string,
    song: SongHeader,
    artifact: ArtifactView,
    action: AudioAction,
  ) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const pal = usePalette();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('active');
  if (rows.length === 0) {
    return (
      <View style={[styles.libraryEmpty, { borderColor: pal.line }]}>
        <Text style={[type.body, { color: pal.muted }]}>
          Completed songs will appear here without downloading their audio.
        </Text>
      </View>
    );
  }
  const visibleRows = filterLibraryRows(rows, query, filter);
  return (
    <View style={styles.library}>
      <TextInput
        accessibilityLabel="Search private library"
        onChangeText={setQuery}
        placeholder="Search title, caption, tag, or node"
        placeholderTextColor={pal.faint}
        value={query}
        style={[
          styles.librarySearch,
          type.small,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <View style={styles.libraryFilters}>
        {(
          [
            ['active', 'ALL'],
            ['favorite', 'FAVORITES'],
            ['offline', 'OFFLINE'],
            ['trash', 'TRASH'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            onPress={() => setFilter(value)}
            style={[
              styles.libraryFilter,
              {
                borderColor: filter === value ? pal.ink : pal.line,
              },
            ]}
          >
            <Text style={[type.eyebrow, { color: pal.ink }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {visibleRows.length === 0 ? (
        <Text style={[type.small, styles.noMatches, { color: pal.muted }]}>
          No cached songs match this local view.
        </Text>
      ) : null}
      {visibleRows.map(row => (
        <LibrarySongRow
          key={`${row.backend.nodePubkey}:${row.song.id}`}
          row={row}
          onDetail={onDetail}
          onPatch={onPatch}
          onPresence={onPresence}
          onAudio={onAudio}
          onError={onError}
        />
      ))}
    </View>
  );
}

function LibrarySongRow({
  row,
  onDetail,
  onPatch,
  onPresence,
  onAudio,
  onError,
}: {
  row: LibraryRow;
  onDetail: LibraryTimelineProps['onDetail'];
  onPatch: LibraryTimelineProps['onPatch'];
  onPresence: LibraryTimelineProps['onPresence'];
  onAudio: LibraryTimelineProps['onAudio'];
  onError: (error: unknown) => void;
}) {
  const pal = usePalette();
  const [title, setTitle] = useState(row.song.title);
  const [tags, setTags] = useState(row.song.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<SongDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  useEffect(() => {
    setTitle(row.song.title);
    setTags(row.song.tags.join(', '));
  }, [row.song.revision, row.song.tags, row.song.title]);
  useEffect(() => setDetail(null), [row.song.id, row.song.revision]);
  const run = async (operation: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    try {
      await operation();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };
  const parsedTags = tags
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
  const loadDetail = async () => {
    if (detail !== null) {
      setDetail(null);
      return;
    }
    if (detailLoading) return;
    setDetailLoading(true);
    try {
      setDetail(await onDetail(row.backend.nodePubkey, row.song.id));
    } catch (error) {
      onError(error);
    } finally {
      setDetailLoading(false);
    }
  };
  const runAudio = async (action: AudioAction) => {
    if (audioBusy || row.delivery === undefined) return;
    setAudioBusy(true);
    try {
      await onAudio(row.backend.nodePubkey, row.song, row.delivery, action);
    } catch (error) {
      onError(error);
    } finally {
      setAudioBusy(false);
    }
  };
  const audioLabel =
    row.delivery === undefined
      ? 'AUDIO PREPARING'
      : audioBusy && ['remote', 'partial'].includes(row.local.state)
        ? 'DOWNLOADING'
        : row.local.state.toUpperCase();
  const audioBytes =
    row.local.bytes > 0
      ? row.local.bytes
      : (row.delivery?.byte_length ??
        row.song.artifacts.find(artifact => artifact.kind === 'master')
          ?.byte_length ??
        0);
  return (
    <View style={[styles.songCard, { borderColor: pal.line }]}>
      <View style={styles.songHeading}>
        <Text style={[type.small, { color: pal.faint }]}>
          {row.song.trashed ? 'TRASH' : audioLabel} ·{' '}
          {row.backend.lastNodeInfo?.name ?? row.backend.petname}
        </Text>
        <Text style={[type.small, { color: pal.muted }]}>
          {(row.song.duration_ms / 1000).toFixed(1)}s ·{' '}
          {formatBytes(audioBytes)}
        </Text>
      </View>
      <TextInput
        accessibilityLabel="Song title"
        editable={row.ready && !saving}
        onChangeText={setTitle}
        value={title}
        style={[
          styles.songInput,
          type.heading,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <TextInput
        accessibilityLabel="Song tags"
        editable={row.ready && !saving}
        onChangeText={setTags}
        placeholder="tags, separated, by commas"
        placeholderTextColor={pal.faint}
        value={tags}
        style={[
          styles.songInput,
          type.small,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <Text style={[type.small, { color: pal.muted }]}>
        {row.song.caption_summary} · {row.song.model}
      </Text>
      <View style={styles.songActions}>
        {row.delivery === undefined ? (
          <Text style={[type.small, { color: pal.faint }]}>
            The node is preparing the compact audio copy.
          </Text>
        ) : row.local.state === 'remote' || row.local.state === 'partial' ? (
          <Pressable
            accessibilityLabel={
              row.local.state === 'partial'
                ? 'Resume audio download'
                : 'Download and play audio'
            }
            disabled={!row.ready || audioBusy}
            onPress={() => runAudio('download-play')}
            style={[styles.songAction, { borderColor: pal.line }]}
          >
            <Text style={[type.eyebrow, { color: pal.ink }]}>
              {audioBusy
                ? `${Math.round(
                    (row.local.bytes / row.delivery.byte_length) * 100,
                  )}%`
                : row.local.state === 'partial'
                  ? 'RESUME DOWNLOAD'
                  : 'DOWNLOAD & PLAY'}
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityLabel="Play downloaded audio"
              disabled={audioBusy}
              onPress={() => runAudio('play')}
              style={[styles.songAction, { borderColor: pal.line }]}
            >
              <Text style={[type.eyebrow, { color: pal.ink }]}>PLAY</Text>
            </Pressable>
            <Pressable
              disabled={audioBusy}
              onPress={() =>
                runAudio(row.local.state === 'pinned' ? 'unpin' : 'pin')
              }
              style={[styles.songAction, { borderColor: pal.line }]}
            >
              <Text style={[type.eyebrow, { color: pal.ink }]}>
                {row.local.state === 'pinned' ? 'UNPIN' : 'PIN'}
              </Text>
            </Pressable>
            {row.local.state === 'cached' ? (
              <Pressable
                disabled={audioBusy}
                onPress={() => runAudio('remove')}
                style={[styles.songAction, { borderColor: pal.line }]}
              >
                <Text style={[type.eyebrow, { color: pal.ink }]}>REMOVE</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      <View style={styles.songActions}>
        <Pressable
          disabled={!row.ready || detailLoading}
          onPress={loadDetail}
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[type.eyebrow, { color: pal.ink }]}>
            {detailLoading ? 'LOADING' : detail === null ? 'DETAILS' : 'CLOSE'}
          </Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() =>
              onPatch(row.backend.nodePubkey, row.song, {
                title: title.trim(),
                tags: parsedTags,
              }),
            )
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[type.eyebrow, { color: pal.ink }]}>SAVE</Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() =>
              onPatch(row.backend.nodePubkey, row.song, {
                favorite: !row.song.favorite,
              }),
            )
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[type.eyebrow, { color: pal.ink }]}>
            {row.song.favorite ? 'UNFAVORITE' : 'FAVORITE'}
          </Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() => onPresence(row.backend.nodePubkey, row.song))
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[type.eyebrow, { color: pal.ink }]}>
            {row.song.trashed ? 'RESTORE' : 'TRASH'}
          </Text>
        </Pressable>
      </View>
      {detail !== null ? (
        <View style={[styles.songDetail, { borderColor: pal.line }]}>
          <Text style={[type.eyebrow, { color: pal.faint }]}>FULL REQUEST</Text>
          <Text style={[type.small, { color: pal.ink }]}>
            {detail.generation.caption}
          </Text>
          {detail.generation.lyrics ? (
            <Text style={[type.small, { color: pal.muted }]}>
              {detail.generation.lyrics}
            </Text>
          ) : null}
          <Text style={[type.small, { color: pal.muted }]}>
            {detail.engine} · attempt {detail.attempts}
            {detail.generation.seed === undefined
              ? ''
              : ` · seed ${detail.generation.seed}`}
            {detail.generation.steps === undefined
              ? ''
              : ` · ${detail.generation.steps} steps`}
          </Text>
          <Text style={[type.small, { color: pal.faint }]}>
            {detail.component_digests.length} verified component digest(s) ·
            local playback uses a digest-verified Opus derivative
          </Text>
        </View>
      ) : null}
      {!row.ready ? (
        <Text style={[type.small, { color: pal.faint }]}>
          Node offline · cached header
        </Text>
      ) : null}
    </View>
  );
}

type LibraryTimelineProps = React.ComponentProps<typeof LibraryTimeline>;

function BackendCard({
  backend,
  snapshot,
  readyBackground,
  readyBorder,
  onSubmit,
  onJobControl,
}: {
  backend: BackendRecord;
  snapshot: ConnectionSnapshot;
  readyBackground: string;
  readyBorder: string;
  onSubmit: (
    nodePublicKey: string,
    model: string,
    generation: GenerationRequest,
  ) => Promise<void>;
  onJobControl: (
    nodePublicKey: string,
    job: JobView,
    control: JobControl,
  ) => Promise<void>;
}) {
  const pal = usePalette();
  const ready = snapshot.phase === 'ready';
  const node = backend.lastNodeInfo;
  const [caption, setCaption] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [submission, setSubmission] = useState<string | null>(null);
  const submitting = useRef(false);
  const availableModels = node?.models ?? NO_MODELS;
  const durationNumber = duration.length === 0 ? undefined : Number(duration);
  const durationInvalid =
    durationNumber !== undefined &&
    (!Number.isInteger(durationNumber) ||
      durationNumber < (node?.limits.min_song_seconds ?? 0) ||
      durationNumber > (node?.limits.max_song_seconds ?? 0));
  const textInvalid =
    utf8ByteLength(caption.trim()) > (node?.limits.max_caption_bytes ?? 0) ||
    utf8ByteLength(lyrics) > (node?.limits.max_lyrics_bytes ?? 0);
  useEffect(() => {
    if (
      model !== null &&
      !availableModels.some(item => item.selector === model)
    )
      setModel(null);
  }, [availableModels, model]);
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: ready ? readyBackground : pal.bg,
          borderColor: ready ? readyBorder : pal.line,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardName}>
          <Text style={[type.heading, { color: pal.ink }]}>
            {node?.name ?? backend.petname}
          </Text>
          <Text style={[type.small, { color: pal.faint }]}>
            {shortKey(backend.nodePubkey)}
          </Text>
        </View>
        <View style={styles.status}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: ready ? readyBorder : pal.faint },
            ]}
          />
          <Text
            style={[type.eyebrow, { color: ready ? readyBorder : pal.muted }]}
          >
            {phaseLabel(snapshot.phase)}
          </Text>
        </View>
      </View>

      {node ? (
        <View style={styles.facts}>
          <Fact label="DEVICE" value={node.device_type} />
          <Fact label="ENGINE" value={node.engine_version} />
          <Fact
            label="MODELS"
            value={node.models.map(item => item.selector).join(', ') || 'none'}
          />
          <Fact
            label="LIMITS"
            value={`${node.limits.max_concurrent_jobs} concurrent · ${node.limits.max_song_seconds}s max`}
          />
          <Fact
            label="LOAD"
            value={`${node.load.active_jobs} active · ${node.load.queued_jobs} queued`}
          />
          <Fact label="JOBS" value={String(snapshot.jobs.length)} />
          <JobQueue
            jobs={snapshot.jobs}
            online={ready}
            controlsSupported={node.features.job_controls}
            onControl={(job, control) =>
              onJobControl(backend.nodePubkey, job, control)
            }
          />
          {ready && node.features.jobs_create ? (
            <View style={styles.composer}>
              <Text style={[type.eyebrow, { color: pal.faint }]}>NEW JOB</Text>
              <View style={styles.modelChoices}>
                {availableModels.map(item => (
                  <Pressable
                    key={item.selector}
                    onPress={() => setModel(item.selector)}
                    style={[
                      styles.modelChoice,
                      {
                        borderColor:
                          model === item.selector ? readyBorder : pal.line,
                      },
                    ]}
                  >
                    <Text style={[type.small, { color: pal.ink }]}>
                      {item.selector}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                value={caption}
                onChangeText={setCaption}
                placeholder="Describe the song"
                placeholderTextColor={pal.faint}
                maxLength={node.limits.max_caption_bytes}
                style={[
                  styles.captionInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <TextInput
                value={lyrics}
                onChangeText={setLyrics}
                placeholder="Lyrics (optional)"
                placeholderTextColor={pal.faint}
                multiline
                style={[
                  styles.lyricsInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <TextInput
                value={duration}
                onChangeText={value => setDuration(value.replace(/\D/g, ''))}
                placeholder={`${node.limits.min_song_seconds}–${node.limits.max_song_seconds}s (optional)`}
                placeholderTextColor={pal.faint}
                keyboardType="number-pad"
                style={[
                  styles.durationInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <Pressable
                disabled={
                  model === null ||
                  caption.trim().length === 0 ||
                  durationInvalid ||
                  textInvalid ||
                  submission === 'Submitting…'
                }
                onPress={() => {
                  if (model === null || submitting.current) return;
                  submitting.current = true;
                  setSubmission('Submitting…');
                  onSubmit(backend.nodePubkey, model, {
                    caption: caption.trim(),
                    ...(lyrics.length > 0 ? { lyrics } : {}),
                    ...(durationNumber !== undefined
                      ? { duration: durationNumber }
                      : {}),
                  })
                    .then(() => {
                      setCaption('');
                      setLyrics('');
                      setDuration('');
                      setSubmission('Queued');
                    })
                    .catch(error => setSubmission(readError(error)))
                    .finally(() => {
                      submitting.current = false;
                    });
                }}
                style={[styles.submitButton, { borderColor: pal.ink }]}
              >
                <Text style={[type.mono, { color: pal.ink }]}>Submit</Text>
              </Pressable>
              {submission ? (
                <Text style={[type.small, { color: pal.muted }]}>
                  {submission}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : (
        <Text style={[type.small, styles.awaiting, { color: pal.muted }]}>
          Waiting for the first authenticated capability response.
        </Text>
      )}
      {snapshot.error ? (
        <Text style={[type.small, styles.cardError, { color: pal.muted }]}>
          {snapshot.error}
        </Text>
      ) : null}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const pal = usePalette();
  return (
    <View style={styles.fact}>
      <Text style={[type.eyebrow, { color: pal.faint }]}>{label}</Text>
      <Text style={[type.small, styles.factValue, { color: pal.ink }]}>
        {value}
      </Text>
    </View>
  );
}

function JobQueue({
  jobs,
  online,
  controlsSupported,
  onControl,
}: {
  jobs: JobView[];
  online: boolean;
  controlsSupported: boolean;
  onControl: (job: JobView, control: JobControl) => Promise<void>;
}) {
  const pal = usePalette();
  const [requesting, setRequesting] = useState<Record<string, JobControl>>({});
  const [controlErrors, setControlErrors] = useState<Record<string, string>>(
    {},
  );
  if (jobs.length === 0) return null;
  const runControl = async (job: JobView, control: JobControl) => {
    setRequesting(current => ({ ...current, [job.id]: control }));
    setControlErrors(current => {
      const next = { ...current };
      delete next[job.id];
      return next;
    });
    try {
      await onControl(job, control);
    } catch (error) {
      setControlErrors(current => ({
        ...current,
        [job.id]: readError(error),
      }));
    } finally {
      setRequesting(current => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };
  return (
    <View style={[styles.queue, { borderColor: pal.line }]}>
      <Text style={[type.eyebrow, { color: pal.faint }]}>QUEUE</Text>
      {jobs.map(job => {
        const total = job.progress?.total;
        const detail =
          total === undefined
            ? job.progress === undefined
              ? null
              : `${job.progress.completed} ${job.progress.unit}`
            : `${job.progress?.completed}/${total} ${job.progress?.unit}`;
        const controls = controlsSupported ? jobControls(job) : [];
        const pending = requesting[job.id];
        return (
          <View key={job.id} style={styles.jobBlock}>
            <View style={styles.jobRow}>
              <View style={styles.jobText}>
                <Text style={[type.small, { color: pal.ink }]}>
                  {pending ? `Requesting ${pending}…` : jobStateLabel(job)}
                </Text>
                <Text style={[type.small, { color: pal.muted }]}>
                  {job.model} · {shortKey(job.id)}
                </Text>
                {job.error ? (
                  <Text style={[type.small, { color: pal.muted }]}>
                    {job.error.message}
                  </Text>
                ) : null}
              </View>
              <Text style={[type.small, { color: pal.faint }]}>
                {detail ?? (!online ? 'offline' : `r${job.revision}`)}
              </Text>
            </View>
            {controls.length > 0 ? (
              <View style={styles.jobActions}>
                {controls.map(control => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!online || pending !== undefined}
                    key={control}
                    onPress={() => runControl(job, control)}
                    style={[styles.jobAction, { borderColor: pal.line }]}
                  >
                    <Text
                      style={[
                        type.eyebrow,
                        {
                          color:
                            online && pending === undefined
                              ? pal.ink
                              : pal.faint,
                        },
                      ]}
                    >
                      {control.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {controlErrors[job.id] ? (
              <Text style={[type.small, { color: pal.muted }]}>
                {controlErrors[job.id]}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function jobControls(job: JobView): JobControl[] {
  switch (job.state) {
    case 'queued':
    case 'preparing':
    case 'running':
      return ['pause', 'cancel'];
    case 'pause_requested':
      return ['cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'failed':
      return job.error?.retryable ? ['retry'] : [];
    default:
      return [];
  }
}

function jobStateLabel(job: JobView): string {
  if (job.state === 'running') {
    switch (job.stage) {
      case 'plan':
        return 'Writing plan';
      case 'codes':
        return 'Generating codes';
      case 'diffuse':
        return 'Shaping audio';
      case 'decode':
        return 'Decoding';
    }
  }
  switch (job.state) {
    case 'queued':
      return 'Waiting on node';
    case 'preparing':
      return 'Preparing model';
    case 'finalizing':
      return 'Saving song';
    case 'pause_requested':
      return 'Pausing at a safe point';
    case 'paused':
      return `Paused${job.stage ? ` during ${job.stage}` : ''}`;
    case 'cancel_requested':
      return 'Cancelling at a safe point';
    case 'cancelled':
      return 'Generation cancelled';
    case 'completed':
      return 'Generation complete';
    case 'failed':
      return 'Generation failed';
    case 'recovering':
      return 'Restarting from request';
    default:
      return job.state.replaceAll('_', ' ');
  }
}

function phaseLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'disconnected':
      return 'DISCONNECTED';
    case 'connecting':
      return 'CONNECTING';
    case 'attached':
      return 'NODE OFFLINE';
    case 'handshaking':
      return 'VERIFYING';
    case 'ready':
      return 'READY';
  }
}

function shortKey(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function deliveryArtifact(song: SongHeader): ArtifactView | undefined {
  return song.artifacts.find(
    artifact =>
      artifact.kind === 'delivery' &&
      artifact.profile === 'opus-stereo-160k-v1',
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  title: { marginTop: space.sm },
  identity: { marginTop: space.sm, marginBottom: space.xl },
  error: { marginBottom: space.md },
  sectionLabel: { marginTop: space.xl, marginBottom: space.sm },
  library: { gap: space.sm },
  librarySearch: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  libraryFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  libraryFilter: { borderWidth: 1, padding: space.sm, minHeight: touch.min },
  noMatches: { paddingVertical: space.sm },
  libraryEmpty: { borderWidth: 1, padding: space.md },
  songCard: { borderWidth: 1, padding: space.md, gap: space.sm },
  songHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  songInput: {
    borderWidth: 1,
    paddingHorizontal: space.sm,
    minHeight: touch.min,
  },
  songActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  songAction: { borderWidth: 1, minHeight: touch.min, padding: space.sm },
  songDetail: { borderTopWidth: 1, paddingTop: space.sm, gap: space.xs },
  empty: { borderWidth: 1, padding: space.lg },
  emptyBody: { marginTop: space.sm },
  card: { borderWidth: 1, padding: space.lg, marginBottom: space.md },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardName: { flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  facts: { marginTop: space.lg, gap: space.sm },
  fact: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  factValue: { flex: 1, textAlign: 'right' },
  queue: { borderTopWidth: 1, paddingTop: space.sm, gap: space.sm },
  jobRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  jobText: { flex: 1 },
  jobBlock: { gap: space.xs },
  jobActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  jobAction: { borderWidth: 1, minHeight: touch.min, padding: space.sm },
  awaiting: { marginTop: space.lg },
  cardError: { marginTop: space.md },
  composer: { marginTop: space.lg, gap: space.sm },
  modelChoices: { gap: space.xs },
  modelChoice: { borderWidth: 1, padding: space.sm },
  captionInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  lyricsInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min * 2,
    textAlignVertical: 'top',
  },
  durationInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  submitButton: {
    borderWidth: 1,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  pairButton: {
    minHeight: touch.min,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
