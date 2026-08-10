import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactView } from '../../../protocol/ArtifactView';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { JobView } from '../../../protocol/JobView';
import type { SongDetail } from '../../../protocol/SongDetail';
import type { SongHeader } from '../../../protocol/SongHeader';
import type { SongPatch } from '../../../protocol/SongPatch';
import { audioKey } from '../audio/repository';
import type { LocalAudio } from '../audio/native';
import type { AudioRef, LocalAudioStore } from '../audio/localAudioStore';
import { repositoryLocalAudioStore } from '../audio/repositoryLocalAudioStore';
import {
  BackendConnection,
  NodeRequestError,
  type ArtifactSink,
} from '../backends/connection';
import { loadBackends, saveBackends } from '../backends/storage';
import type {
  BackendRecord,
  ConnectionSnapshot,
  NodeInfo,
  PairingRequest,
} from '../backends/types';
import { readError } from '../core/errors';
import type { AppIdentity } from '../identity/derive';
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
import type { TransportDescriptor } from '../security/types';

export const DEFAULT_BACKEND_SNAPSHOT: ConnectionSnapshot = {
  phase: 'disconnected',
  error: null,
  jobs: [],
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
};

export type JobControl = 'pause' | 'resume' | 'cancel' | 'retry';
export type AudioAction = 'download-play' | 'play' | 'pin' | 'unpin' | 'remove';

export type BackendRuntimeConnection = Pick<
  BackendConnection,
  | 'start'
  | 'stop'
  | 'createJob'
  | 'controlJob'
  | 'patchSong'
  | 'getSong'
  | 'downloadArtifact'
  | 'trashSong'
  | 'restoreSong'
  | 'refreshLibrary'
>;

export type BackendRuntimeConnectionCallbacks = {
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onNodeInfo: (nodeInfo: NodeInfo) => void;
  onPairTokenConsumed: () => void;
  onTransportConfirmed: (descriptor: TransportDescriptor) => void;
};

type RuntimeDependencies = {
  createConnection: (
    backend: BackendRecord,
    identity: AppIdentity,
    pairToken: string | undefined,
    callbacks: BackendRuntimeConnectionCallbacks,
  ) => BackendRuntimeConnection;
  loadBackends: typeof loadBackends;
  saveBackends: typeof saveBackends;
  loadJobs: typeof loadJobs;
  mergeJobs: typeof mergeJobs;
  loadLibrary: typeof loadLibrary;
  commitLibrary: typeof commitLibrary;
  loadOutbox: typeof loadOutbox;
  putPending: typeof putPending;
  markAccepted: typeof markAccepted;
  markRejected: typeof markRejected;
  audioStore: LocalAudioStore;
};

/** Explicit seams for focused hook tests; production uses the concrete stack. */
export type BackendRuntimeDependencies = Partial<RuntimeDependencies>;

export type BackendRuntimeState = {
  backends: BackendRecord[] | null;
  snapshots: Record<string, ConnectionSnapshot>;
  pairing: boolean;
  storageError: string | null;
  localAudio: Record<string, LocalAudio>;
};

export type BackendRuntimeCommands = {
  showPairing: () => void;
  hidePairing: () => void;
  reportError: (error: unknown) => void;
  pairBackend: (request: PairingRequest) => void;
  submit: (
    nodePublicKey: string,
    model: string,
    generation: GenerationRequest,
  ) => Promise<void>;
  controlJob: (
    nodePublicKey: string,
    job: JobView,
    control: JobControl,
  ) => Promise<void>;
  patchSong: (
    nodePublicKey: string,
    song: SongHeader,
    patch: SongPatch,
  ) => Promise<void>;
  changeSongPresence: (
    nodePublicKey: string,
    song: SongHeader,
  ) => Promise<void>;
  getSongDetail: (nodePublicKey: string, songId: string) => Promise<SongDetail>;
  audio: (
    nodePublicKey: string,
    song: SongHeader,
    artifact: ArtifactView,
    action: AudioAction,
  ) => Promise<void>;
  refreshLibraries: () => void;
};

export type BackendRuntime = {
  state: BackendRuntimeState;
  commands: BackendRuntimeCommands;
};

const defaultDependencies: RuntimeDependencies = {
  createConnection: (backend, identity, pairToken, callbacks) =>
    new BackendConnection(backend, identity, pairToken, callbacks),
  loadBackends,
  saveBackends,
  loadJobs,
  mergeJobs,
  loadLibrary,
  commitLibrary,
  loadOutbox,
  putPending,
  markAccepted,
  markRejected,
  audioStore: repositoryLocalAudioStore,
};

type LiveConnection = {
  relayUrl: string;
  connection: BackendRuntimeConnection;
};

export function useBackendRuntime(
  identity: AppIdentity,
  dependencies: BackendRuntimeDependencies = {},
): BackendRuntime {
  const createConnection =
    dependencies.createConnection ?? defaultDependencies.createConnection;
  const loadBackendRecords =
    dependencies.loadBackends ?? defaultDependencies.loadBackends;
  const saveBackendRecords =
    dependencies.saveBackends ?? defaultDependencies.saveBackends;
  const loadCachedJobs = dependencies.loadJobs ?? defaultDependencies.loadJobs;
  const mergeCachedJobs =
    dependencies.mergeJobs ?? defaultDependencies.mergeJobs;
  const loadCachedLibrary =
    dependencies.loadLibrary ?? defaultDependencies.loadLibrary;
  const commitCachedLibrary =
    dependencies.commitLibrary ?? defaultDependencies.commitLibrary;
  const loadPendingOutbox =
    dependencies.loadOutbox ?? defaultDependencies.loadOutbox;
  const createPendingEntry =
    dependencies.putPending ?? defaultDependencies.putPending;
  const acceptOutboxEntry =
    dependencies.markAccepted ?? defaultDependencies.markAccepted;
  const rejectOutboxEntry =
    dependencies.markRejected ?? defaultDependencies.markRejected;
  const audioStore = dependencies.audioStore ?? defaultDependencies.audioStore;
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
    async (connection: BackendRuntimeConnection, entry: OutboxEntry) => {
      if (outboxInFlight.current.has(entry.clientRequestId)) return;
      outboxInFlight.current.add(entry.clientRequestId);
      try {
        const job = await connection.createJob(
          entry.clientRequestId,
          entry.model,
          entry.generation,
        );
        await acceptOutboxEntry(entry.clientRequestId, job.id);
      } catch (error) {
        if (error instanceof NodeRequestError && !error.retryable) {
          await rejectOutboxEntry(entry.clientRequestId, error.message);
        }
        throw error;
      } finally {
        outboxInFlight.current.delete(entry.clientRequestId);
      }
    },
    [acceptOutboxEntry, rejectOutboxEntry],
  );

  const replaceBackends = useCallback(
    (next: BackendRecord[]) => {
      backendsRef.current = next;
      setBackends(next);
      saveBackendRecords(next).catch(error =>
        setStorageError(readError(error)),
      );
    },
    [saveBackendRecords],
  );

  useEffect(() => {
    let active = true;
    loadBackendRecords()
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
  }, [loadBackendRecords]);

  const rememberNodeInfo = useCallback(
    (nodePublicKey: string, info: NodeInfo) => {
      const current = backendsRef.current;
      const existing = current.find(item => item.nodePubkey === nodePublicKey);
      if (
        existing &&
        JSON.stringify(existing.lastNodeInfo) === JSON.stringify(info)
      ) {
        return;
      }
      replaceBackends(
        current.map(item =>
          item.nodePubkey === nodePublicKey
            ? { ...item, lastNodeInfo: info }
            : item,
        ),
      );
    },
    [replaceBackends],
  );

  const rememberTransport = useCallback(
    (nodePublicKey: string, transport: TransportDescriptor) => {
      const current = backendsRef.current;
      const existing = current.find(item => item.nodePubkey === nodePublicKey);
      if (
        existing === undefined ||
        JSON.stringify(existing.transport) === JSON.stringify(transport)
      ) {
        return;
      }
      replaceBackends(
        current.map(item =>
          item.nodePubkey === nodePublicKey ? { ...item, transport } : item,
        ),
      );
    },
    [replaceBackends],
  );

  useEffect(() => {
    if (backends === null) return;
    const wanted = new Set(backends.map(backend => backend.nodePubkey));
    for (const [nodePublicKey, live] of connections.current) {
      if (!wanted.has(nodePublicKey)) {
        live.connection.stop();
        connections.current.delete(nodePublicKey);
      }
    }
    for (const backend of backends) {
      loadCachedJobs(backend.nodePubkey)
        .then(jobs =>
          setSnapshots(previous => ({
            ...previous,
            [backend.nodePubkey]: {
              ...(previous[backend.nodePubkey] ?? DEFAULT_BACKEND_SNAPSHOT),
              jobs: mergeJobViews(
                previous[backend.nodePubkey]?.jobs ?? [],
                jobs,
              ),
            },
          })),
        )
        .catch(error => setStorageError(readError(error)));
      loadCachedLibrary(backend.nodePubkey)
        .then(library =>
          setSnapshots(previous => ({
            ...previous,
            [backend.nodePubkey]: {
              ...(previous[backend.nodePubkey] ?? DEFAULT_BACKEND_SNAPSHOT),
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
      if (current?.relayUrl === backend.relayUrl) continue;
      current?.connection.stop();
      const connection = createConnection(
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
              mergeCachedJobs(backend.nodePubkey, snapshot.jobs)
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
              commitCachedLibrary(
                backend.nodePubkey,
                snapshot.libraryRevision,
                snapshot.songs,
              ).catch(error => setStorageError(readError(error)));
            }
            if (snapshot.phase === 'ready') {
              loadPendingOutbox()
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
          onTransportConfirmed: transport =>
            rememberTransport(backend.nodePubkey, transport),
        },
      );
      connections.current.set(backend.nodePubkey, {
        relayUrl: backend.relayUrl,
        connection,
      });
      connection.start();
    }
  }, [
    backends,
    identity,
    rememberNodeInfo,
    rememberTransport,
    commitCachedLibrary,
    createConnection,
    loadCachedJobs,
    loadCachedLibrary,
    loadPendingOutbox,
    mergeCachedJobs,
    sendOutbox,
  ]);

  useEffect(
    () => () => {
      for (const live of connections.current.values()) {
        live.connection.stop();
      }
      connections.current.clear();
    },
    [],
  );

  const pairBackend = useCallback(
    (request: PairingRequest) => {
      const nodePublicKey = request.backend.nodePubkey;
      pairTokens.current.set(nodePublicKey, request.pairToken);
      connections.current.get(nodePublicKey)?.connection.stop();
      connections.current.delete(nodePublicKey);
      const existing = backendsRef.current.find(
        backend => backend.nodePubkey === nodePublicKey,
      );
      const backend = {
        ...request.backend,
        lastNodeInfo: existing?.lastNodeInfo ?? null,
      };
      replaceBackends([
        ...backendsRef.current.filter(
          item => item.nodePubkey !== nodePublicKey,
        ),
        backend,
      ]);
      setPairing(false);
    },
    [replaceBackends],
  );

  const submit = useCallback(
    async (
      nodePublicKey: string,
      model: string,
      generation: GenerationRequest,
    ) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Backend is not connected.');
      const entry = await createPendingEntry(nodePublicKey, model, generation);
      await sendOutbox(live.connection, entry);
    },
    [createPendingEntry, sendOutbox],
  );

  const patchSong = useCallback(
    async (nodePublicKey: string, song: SongHeader, patch: SongPatch) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Song node is not connected.');
      await live.connection.patchSong(song.id, song.revision, patch);
    },
    [],
  );

  const controlJob = useCallback(
    async (nodePublicKey: string, job: JobView, control: JobControl) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Job node is not connected.');
      await live.connection.controlJob(control, job.id, job.revision);
    },
    [],
  );

  const changeSongPresence = useCallback(
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

  const getSongDetail = useCallback(
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

  const audio = useCallback(
    async (
      nodeKey: string,
      song: SongHeader,
      artifact: ArtifactView,
      action: AudioAction,
    ) => {
      const ref: AudioRef = {
        nodeKey,
        songId: song.id,
        digest: artifact.sha256,
      };
      const identify = () => audioStore.inspect(ref);
      if (action === 'download-play') {
        const live = connections.current.get(nodeKey);
        if (live === undefined) throw new Error('Song node is not connected.');
        const before = await identify();
        if (before.state !== 'cached' && before.state !== 'pinned') {
          const sink: ArtifactSink = audioStore.createSink(ref);
          await live.connection.downloadArtifact(
            song.id,
            artifact,
            sink,
            (bytes, total) =>
              updateLocalAudio(nodeKey, song.id, artifact.sha256, {
                state: bytes === total ? 'cached' : 'partial',
                bytes,
              }),
          );
        }
        await audioStore.play(ref);
      } else if (action === 'play') {
        await audioStore.play(ref);
      } else if (action === 'pin') {
        await audioStore.pin(ref);
      } else if (action === 'unpin') {
        await audioStore.unpin(ref);
      } else {
        await audioStore.remove(ref);
      }
      updateLocalAudio(nodeKey, song.id, artifact.sha256, await identify());
    },
    [audioStore, updateLocalAudio],
  );

  useEffect(() => {
    let active = true;
    const entries = (backends ?? []).flatMap(backend =>
      (snapshots[backend.nodePubkey]?.songs ?? []).flatMap(song => {
        const artifact = deliveryArtifact(song);
        return artifact === undefined
          ? []
          : ([[backend.nodePubkey, song, artifact]] as const);
      }),
    );
    Promise.all(
      entries.map(async ([nodeKey, song, artifact]) => ({
        key: audioKey(nodeKey, song.id, artifact.sha256),
        state: await audioStore.inspect({
          nodeKey,
          songId: song.id,
          digest: artifact.sha256,
        }),
      })),
    )
      .then(inspected => {
        if (!active) return;
        setLocalAudio(current => ({
          ...current,
          ...Object.fromEntries(
            inspected.map(entry => [entry.key, entry.state]),
          ),
        }));
      })
      .catch(error => {
        if (active) setStorageError(readError(error));
      });
    return () => {
      active = false;
    };
  }, [audioStore, backends, snapshots]);

  const refreshLibraries = useCallback(() => {
    for (const live of connections.current.values()) {
      live.connection.refreshLibrary();
    }
  }, []);

  return {
    state: { backends, snapshots, pairing, storageError, localAudio },
    commands: {
      showPairing: () => setPairing(true),
      hidePairing: () => setPairing(false),
      reportError: error => setStorageError(readError(error)),
      pairBackend,
      submit,
      controlJob,
      patchSong,
      changeSongPresence,
      getSongDetail,
      audio,
      refreshLibraries,
    },
  };
}

export function deliveryArtifact(song: SongHeader): ArtifactView | undefined {
  return song.artifacts.find(
    artifact =>
      artifact.kind === 'delivery' &&
      artifact.profile === 'opus-stereo-160k-v1',
  );
}
