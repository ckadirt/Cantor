import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { JobControl } from '../jobs/policy';
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
  loadLibraries,
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


/**
 * Runtime owns getting bytes onto the phone and keeping them there. Making
 * sound is the player's job, reached through `audioPath`.
 */
export type AudioAction = 'download' | 'pin' | 'unpin' | 'remove';

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
  loadLibraries: typeof loadLibraries;
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
  /**
   * Persisted submissions, keyed `${nodePublicKey}:${canonicalJobId}`.
   *
   * A job mark needs the caption the person actually typed, and `JobView` does
   * not carry it. Reading it back off the outbox keeps that text in the one
   * place that already stores it durably, instead of duplicating it onto the
   * wire model or into a second store. Entries the node has not accepted yet
   * have no canonical id and so are not addressable here.
   */
  outbox: Record<string, OutboxEntry>;
};

export type BackendRuntimeCommands = {
  showPairing: () => void;
  hidePairing: () => void;
  reportError: (error: unknown) => void;
  pairBackend: (request: PairingRequest) => void;
  /** Change what this phone calls a node. Nothing on the node changes. */
  renameBackend: (nodePublicKey: string, petname: string) => void;
  /**
   * Remove a node from this phone, keeping the songs you asked to keep.
   *
   * A song is here either because you tapped `GET`/`KEEP`, which pins it, or
   * because you played it, which leaves a cached copy the budget is free to
   * reclaim — the row says so: `CACHED · MAY BE RECLAIMED`. Only the first is a
   * promise this phone can still honour with the node gone, so only the first
   * survives. Keeping the loans would make the field depend on files
   * `enforceCacheBudget` may take at any download, with no node left to fetch
   * them back from.
   *
   * Partial transfers go too: they cannot resume without the node and no screen
   * can reach them.
   *
   * Nothing is deleted on the node itself. Pair again and everything returns.
   */
  forgetBackend: (nodePublicKey: string) => Promise<void>;
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
  /** Verified local path for playback; rejects anything not fully cached. */
  audioPath: (
    nodePublicKey: string,
    song: SongHeader,
    artifact: ArtifactView,
  ) => Promise<string>;
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
  loadLibraries,
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
  const loadAllCachedLibraries =
    dependencies.loadLibraries ?? defaultDependencies.loadLibraries;
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
  const [outbox, setOutbox] = useState<Record<string, OutboxEntry>>({});
  const refreshOutbox = useCallback(async () => {
    const entries = await loadPendingOutbox();
    setOutbox(
      Object.fromEntries(
        entries
          .filter(entry => entry.canonicalJobId !== undefined)
          .map(entry => [
            `${entry.nodePublicKey}:${entry.canonicalJobId}`,
            entry,
          ]),
      ),
    );
  }, [loadPendingOutbox]);
  const [backends, setBackends] = useState<BackendRecord[] | null>(null);
  const [snapshots, setSnapshots] = useState<
    Record<string, ConnectionSnapshot>
  >({});
  const [pairing, setPairing] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [localAudio, setLocalAudio] = useState<Record<string, LocalAudio>>({});
  const backendsRef = useRef<BackendRecord[]>([]);
  /**
   * The snapshots as they are *now*.
   *
   * `forgetBackend` walks a node's songs to release the audio it only borrowed,
   * and a callback closing over the rendered `snapshots` would walk whatever
   * list existed when it was created. Mirrored for the same reason
   * `backendsRef` is.
   */
  const snapshotsRef = useRef<Record<string, ConnectionSnapshot>>({});
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
        await refreshOutbox();
      } catch (error) {
        if (error instanceof NodeRequestError && !error.retryable) {
          await rejectOutboxEntry(entry.clientRequestId, error.message);
          await refreshOutbox();
        }
        throw error;
      } finally {
        outboxInFlight.current.delete(entry.clientRequestId);
      }
    },
    [acceptOutboxEntry, refreshOutbox, rejectOutboxEntry],
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

  useEffect(() => {
    let active = true;
    loadAllCachedLibraries()
      .then(libraries => {
        if (!active) return;
        setSnapshots(previous => {
          const next = { ...previous };
          for (const [nodeKey, library] of Object.entries(libraries)) {
            if (next[nodeKey] !== undefined) continue;
            next[nodeKey] = {
              ...DEFAULT_BACKEND_SNAPSHOT,
              songs: library.songs,
              libraryRevision: library.revision,
            };
          }
          return next;
        });
      })
      .catch(error => {
        if (active) setStorageError(readError(error));
      });
    return () => {
      active = false;
    };
  }, [loadAllCachedLibraries]);

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
            if (
              connections.current.get(backend.nodePubkey)?.connection !== connection
            ) return;
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


  snapshotsRef.current = snapshots;

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

  const renameBackend = useCallback(
    (nodePublicKey: string, petname: string) => {
      const trimmed = petname.trim();
      if (trimmed.length === 0) return;
      replaceBackends(
        backendsRef.current.map(backend =>
          backend.nodePubkey === nodePublicKey
            ? { ...backend, petname: trimmed }
            : backend,
        ),
      );
    },
    [replaceBackends],
  );

  const forgetBackend = useCallback(
    async (nodePublicKey: string) => {
      // Stop talking to it first: a live socket would re-populate the snapshot
      // the moment the record is gone.
      connections.current.get(nodePublicKey)?.connection.stop();
      connections.current.delete(nodePublicKey);
      pairTokens.current.delete(nodePublicKey);

      // Released after the socket is down, so a transfer still in flight has
      // already been cut before its bytes are deleted underneath it.
      const released: string[] = [];
      for (const song of snapshotsRef.current[nodePublicKey]?.songs ?? []) {
        const artifact = deliveryArtifact(song);
        if (artifact === undefined) continue;
        const ref = {
          nodeKey: nodePublicKey,
          songId: song.id,
          digest: artifact.sha256,
        };
        // `inspect` and not the advisory state: the store's own contract says
        // the filesystem is what answers this, and a pin is the one answer
        // worth trusting a deletion to.
        const held = await audioStore.inspect(ref).catch(() => null);
        if (held === null || held.state === 'pinned') continue;
        released.push(audioKey(nodePublicKey, song.id, artifact.sha256));
        if (held.state === 'remote') continue;
        // One failure must not strand the rest: a file that is already gone,
        // or that native refuses, still leaves the record to remove.
        try {
          await audioStore.remove(ref);
        } catch (error) {
          setStorageError(readError(error));
        }
      }

      replaceBackends(
        backendsRef.current.filter(
          backend => backend.nodePubkey !== nodePublicKey,
        ),
      );
      setSnapshots(current => ({
        ...current,
        [nodePublicKey]: {
          ...(current[nodePublicKey] ?? DEFAULT_BACKEND_SNAPSHOT),
          phase: 'disconnected',
          error: null,
          jobs: [],
          librarySyncing: false,
        },
      }));
      setLocalAudio(current => {
        const next = { ...current };
        for (const key of released) delete next[key];
        return next;
      });
    },
    [audioStore, replaceBackends],
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
      await refreshOutbox();
      await sendOutbox(live.connection, entry);
    },
    [createPendingEntry, refreshOutbox, sendOutbox],
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

  /**
   * The verified local path for a song, for the player to load.
   *
   * Runtime resolves and verifies; it does not make sound and does not import
   * `player/`. A partial download has no path — the native side refuses one.
   */
  const audioPath = useCallback(
    async (
      nodeKey: string,
      song: SongHeader,
      artifact: ArtifactView,
    ): Promise<string> =>
      audioStore.localPath({ nodeKey, songId: song.id, digest: artifact.sha256 }),
    [audioStore],
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
      if (action === 'download') {
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
    const entries = Object.entries(snapshots).flatMap(([nodeKey, snapshot]) =>
      snapshot.songs.flatMap(song => {
        const artifact = deliveryArtifact(song);
        return artifact === undefined
          ? []
          : ([[nodeKey, song, artifact]] as const);
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

  const showPairing = useCallback(() => setPairing(true), []);
  const hidePairing = useCallback(() => setPairing(false), []);
  const reportError = useCallback(
    (error: unknown) => setStorageError(readError(error)),
    [],
  );

  // Stable identity: the field re-renders its screen on every camera frame, and
  // a fresh commands object on each render would defeat every memoised sheet
  // downstream. Every member here is already a stable useCallback.
  const commands = useMemo(
    () => ({
      showPairing,
      hidePairing,
      reportError,
      pairBackend,
      renameBackend,
      forgetBackend,
      submit,
      controlJob,
      patchSong,
      changeSongPresence,
      getSongDetail,
      audio,
      audioPath,
      refreshLibraries,
    }),
    [
      audio,
      audioPath,
      changeSongPresence,
      controlJob,
      getSongDetail,
      hidePairing,
      patchSong,
      pairBackend,
      renameBackend,
      forgetBackend,
      refreshLibraries,
      reportError,
      showPairing,
      submit,
    ],
  );

  return {
    state: { backends, snapshots, pairing, storageError, localAudio, outbox },
    commands,
  };
}

export function deliveryArtifact(song: SongHeader): ArtifactView | undefined {
  return song.artifacts.find(
    artifact =>
      artifact.kind === 'delivery' &&
      artifact.profile === 'opus-stereo-160k-v1',
  );
}

// Job control policy is owned by the jobs domain; re-exported so the runtime's
// public surface is unchanged for callers.
export type { JobControl };
