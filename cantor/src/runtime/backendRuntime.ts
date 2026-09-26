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
import { createStore, type Store } from '../core/store';
import type { AppIdentity } from '../identity/derive';
import {
  forgetSubmission,
  loadOutbox,
  markAccepted,
  markRejected,
  putPending,
  type OutboxEntry,
} from '../jobs/outbox';
import {
  forgetJobs,
  loadJobs,
  mergeJobs,
  mergeJobViews,
} from '../jobs/repository';
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
/**
 * What can be done to a song's audio on the phone. `keep` is download-and-pin
 * as one act — `GET` — so the song is never published as merely cached on the
 * way to being kept: the mark would step back from a full arc (or a filled-in
 * seal) to "cached" for a beat before filling.
 */
export type AudioAction = 'download' | 'keep' | 'pin' | 'unpin' | 'remove';

/** The floor between two published download-progress samples. */
const ARRIVING_SAMPLE_MS = 100;

export type BackendRuntimeConnection = Pick<
  BackendConnection,
  | 'start'
  | 'stop'
  | 'createJob'
  | 'controlJob'
  | 'forgetJob'
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
  onJobForgotten: (jobId: string) => void;
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
  forgetJobs: typeof forgetJobs;
  loadLibrary: typeof loadLibrary;
  loadLibraries: typeof loadLibraries;
  commitLibrary: typeof commitLibrary;
  loadOutbox: typeof loadOutbox;
  forgetSubmission: typeof forgetSubmission;
  putPending: typeof putPending;
  markAccepted: typeof markAccepted;
  markRejected: typeof markRejected;
  audioStore: LocalAudioStore;
};

/** Explicit seams for focused tests; production uses the concrete stack. */
export type BackendRuntimeDependencies = Partial<RuntimeDependencies>;

export type BackendRuntimeState = {
  backends: BackendRecord[] | null;
  snapshots: Record<string, ConnectionSnapshot>;
  pairing: boolean;
  storageError: string | null;
  localAudio: Record<string, LocalAudio>;
  /**
   * Keys of the artifacts a transfer is running for right now.
   *
   * `localAudio` says what is on the phone; this says what is moving. A song
   * interrupted at 24% stays `partial` forever, so anything that wants to draw
   * a wait — a verb that closes, an arc that fills — has to ask this instead,
   * or it promises motion to a song nothing is fetching.
   */
  downloading: ReadonlySet<string>;
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
  /**
   * Delete a stopped generation everywhere: the node's row and bytes, this
   * phone's cached snapshot, and the submission that held its caption.
   *
   * Nothing is kept, because a failure that has been read has no second use —
   * and the node refuses to erase anything that became a song.
   */
  forgetJob: (nodePublicKey: string, job: JobView) => Promise<void>;
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

const defaultDependencies: RuntimeDependencies = {
  createConnection: (backend, identity, pairToken, callbacks) =>
    new BackendConnection(backend, identity, pairToken, callbacks),
  loadBackends,
  saveBackends,
  loadJobs,
  mergeJobs,
  forgetJobs,
  loadLibrary,
  loadLibraries,
  commitLibrary,
  loadOutbox,
  forgetSubmission,
  putPending,
  markAccepted,
  markRejected,
  audioStore: repositoryLocalAudioStore,
};

type LiveConnection = {
  relayUrl: string;
  connection: BackendRuntimeConnection;
};

export const INITIAL_RUNTIME_STATE: BackendRuntimeState = {
  backends: null,
  snapshots: {},
  pairing: false,
  storageError: null,
  localAudio: {},
  downloading: new Set(),
  outbox: {},
};

/**
 * The phone's side of every paired node: connections, the cached library, the
 * submission outbox, and the audio on disk — published as one store.
 *
 * A plain object rather than a hook, so the state lives outside React and a
 * screen re-renders only for the part it selected. It keeps every unchanged
 * object it publishes: a snapshot whose songs and jobs did not change is the
 * same snapshot, and a song whose audio did not change keeps its entry. That
 * is what lets a job's progress tick leave the whole field alone.
 */
export class BackendRuntime {
  readonly store: Store<BackendRuntimeState> = createStore(
    INITIAL_RUNTIME_STATE,
  );
  readonly commands: BackendRuntimeCommands;
  private readonly deps: RuntimeDependencies;
  private readonly connections = new Map<string, LiveConnection>();
  private readonly pairTokens = new Map<string, string>();
  private readonly outboxInFlight = new Set<string>();
  /*
   * What this runtime has already persisted, so a snapshot that changes
   * nothing durable writes nothing. A running job's progress arrives about
   * once a second, and each one used to rewrite the whole library cache, every
   * job, and re-read the outbox — three storage round trips and ~1.3 s of the
   * JS thread per 15 s of generation (see the rewrite log, phase 4).
   */
  /** The library revision committed per node, for this connection. */
  private readonly committedRevision = new Map<string, number>();
  /** Each node's jobs as last persisted: id → state. */
  private readonly persistedJobs = new Map<string, Map<string, string>>();
  /** Nodes whose outbox held pending entries when last read, or just got one. */
  private readonly outboxPending = new Set<string>();
  /**
   * Audio keys whose file this runtime has already asked native about.
   *
   * A song's file is inspected once when it first appears, and every song is
   * inspected again only after something that can evict — a finished download
   * or an unpin runs `enforceCacheBudget`. Asking about every song on every
   * snapshot, which is what the hook this replaced did, was one bridge call per
   * song per job-progress tick.
   */
  private readonly inspected = new Set<string>();
  /** Bumped by `start` and `dispose`; async work from an older run is dropped. */
  private run = 0;

  constructor(
    private readonly identity: AppIdentity,
    dependencies: BackendRuntimeDependencies = {},
  ) {
    this.deps = { ...defaultDependencies, ...dependencies };
    this.commands = {
      showPairing: () => this.update({ pairing: true }),
      hidePairing: () => this.update({ pairing: false }),
      reportError: this.reportError,
      pairBackend: this.pairBackend,
      renameBackend: this.renameBackend,
      forgetBackend: this.forgetBackend,
      submit: this.submit,
      controlJob: this.controlJob,
      forgetJob: this.forgetJob,
      patchSong: this.patchSong,
      changeSongPresence: this.changeSongPresence,
      getSongDetail: this.getSongDetail,
      audio: this.audio,
      audioPath: this.audioPath,
      refreshLibraries: this.refreshLibraries,
    };
  }

  /** Load the caches and open a connection to every paired node. */
  start(): void {
    const run = ++this.run;
    const alive = () => run === this.run;
    /*
     * Read the submissions back at launch.
     *
     * The words a person typed are durable, but the outbox map is not: without
     * this it is empty until the next submission, so every job from an earlier
     * session draws with no caption at all — which is exactly when a stopped
     * one most needs to say what it was.
     */
    this.refreshOutbox().catch(this.reportError);
    this.deps
      .loadBackends()
      .then(loaded => {
        if (!alive()) return;
        this.update({ backends: loaded });
        this.syncConnections();
      })
      .catch(error => {
        if (!alive()) return;
        this.update({ storageError: readError(error), backends: [] });
      });
    this.deps
      .loadLibraries()
      .then(libraries => {
        if (!alive()) return;
        this.setSnapshots(previous => {
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
        if (alive()) this.reportError(error);
      });
  }

  /** Stop every connection. A later `start` opens them again. */
  dispose(): void {
    this.run += 1;
    for (const live of this.connections.values()) live.connection.stop();
    this.connections.clear();
  }

  private get state(): BackendRuntimeState {
    return this.store.get();
  }

  private update(patch: Partial<BackendRuntimeState>): void {
    this.store.set(current => {
      const changed = (
        Object.keys(patch) as (keyof BackendRuntimeState)[]
      ).some(key => !Object.is(current[key], patch[key]));
      return changed ? { ...current, ...patch } : current;
    });
  }

  private readonly reportError = (error: unknown): void => {
    this.update({ storageError: readError(error) });
  };

  private setSnapshots(
    change: (
      previous: Record<string, ConnectionSnapshot>,
    ) => Record<string, ConnectionSnapshot>,
  ): void {
    const previous = this.state.snapshots;
    const proposed = change(previous);
    // Keep every snapshot whose parts did not change, and the record itself
    // when none did.
    let next: Record<string, ConnectionSnapshot> | null = null;
    for (const [key, snapshot] of Object.entries(proposed)) {
      const kept = keepSnapshot(previous[key], snapshot);
      if (kept !== previous[key]) {
        next ??= { ...previous };
        next[key] = kept;
      }
    }
    for (const key of Object.keys(previous)) {
      if (!(key in proposed)) {
        next ??= { ...previous };
        delete next[key];
      }
    }
    if (next === null) return;
    this.update({ snapshots: next });
    this.inspectNewAudio();
  }

  private setLocalAudio(key: string, value: LocalAudio): void {
    const current = this.state.localAudio[key];
    if (
      current !== undefined &&
      current.state === value.state &&
      current.bytes === value.bytes
    ) {
      return;
    }
    this.update({ localAudio: { ...this.state.localAudio, [key]: value } });
  }

  private markDownloading(key: string, active: boolean): void {
    const current = this.state.downloading;
    if (current.has(key) === active) return;
    const next = new Set(current);
    if (active) next.add(key);
    else next.delete(key);
    this.update({ downloading: next });
  }

  private replaceBackends(next: BackendRecord[]): void {
    this.update({ backends: next });
    this.deps.saveBackends(next).catch(this.reportError);
    this.syncConnections();
  }

  private async refreshOutbox(): Promise<void> {
    const entries = await this.deps.loadOutbox();
    this.update({
      outbox: Object.fromEntries(
        entries
          .filter(entry => entry.canonicalJobId !== undefined)
          .map(entry => [
            `${entry.nodePublicKey}:${entry.canonicalJobId}`,
            entry,
          ]),
      ),
    });
  }

  private async sendOutbox(
    connection: BackendRuntimeConnection,
    entry: OutboxEntry,
  ): Promise<void> {
    if (this.outboxInFlight.has(entry.clientRequestId)) return;
    this.outboxInFlight.add(entry.clientRequestId);
    try {
      const job = await connection.createJob(
        entry.clientRequestId,
        entry.model,
        entry.generation,
      );
      await this.deps.markAccepted(entry.clientRequestId, job.id);
      await this.refreshOutbox();
    } catch (error) {
      if (error instanceof NodeRequestError && !error.retryable) {
        await this.deps.markRejected(entry.clientRequestId, error.message);
        await this.refreshOutbox();
      }
      throw error;
    } finally {
      this.outboxInFlight.delete(entry.clientRequestId);
    }
  }

  private rememberNodeInfo(nodePublicKey: string, info: NodeInfo): void {
    const current = this.state.backends ?? [];
    const existing = current.find(item => item.nodePubkey === nodePublicKey);
    if (
      existing &&
      JSON.stringify(existing.lastNodeInfo) === JSON.stringify(info)
    ) {
      return;
    }
    this.replaceBackends(
      current.map(item =>
        item.nodePubkey === nodePublicKey
          ? { ...item, lastNodeInfo: info }
          : item,
      ),
    );
  }

  private rememberTransport(
    nodePublicKey: string,
    transport: TransportDescriptor,
  ): void {
    const current = this.state.backends ?? [];
    const existing = current.find(item => item.nodePubkey === nodePublicKey);
    if (
      existing === undefined ||
      JSON.stringify(existing.transport) === JSON.stringify(transport)
    ) {
      return;
    }
    this.replaceBackends(
      current.map(item =>
        item.nodePubkey === nodePublicKey ? { ...item, transport } : item,
      ),
    );
  }

  /**
   * Make the live connections match the paired backends.
   *
   * A connection is opened for a node that has none, or whose relay changed;
   * that is also when its cached jobs and library are read back, because a
   * record that merely changed its name or node info has nothing new on disk.
   */
  private syncConnections(): void {
    const backends = this.state.backends;
    if (backends === null) return;
    const wanted = new Set(backends.map(backend => backend.nodePubkey));
    for (const [nodePublicKey, live] of this.connections) {
      if (!wanted.has(nodePublicKey)) {
        live.connection.stop();
        this.connections.delete(nodePublicKey);
      }
    }
    for (const backend of backends) {
      const current = this.connections.get(backend.nodePubkey);
      if (current?.relayUrl === backend.relayUrl) continue;
      current?.connection.stop();
      this.hydrate(backend.nodePubkey);
      this.connect(backend);
    }
  }

  private hydrate(nodePublicKey: string): void {
    const run = this.run;
    this.deps
      .loadJobs(nodePublicKey)
      .then(jobs => {
        if (run !== this.run) return;
        this.setSnapshots(previous => ({
          ...previous,
          [nodePublicKey]: {
            ...(previous[nodePublicKey] ?? DEFAULT_BACKEND_SNAPSHOT),
            jobs: mergeJobViews(previous[nodePublicKey]?.jobs ?? [], jobs),
          },
        }));
      })
      .catch(this.reportError);
    this.deps
      .loadLibrary(nodePublicKey)
      .then(library => {
        if (run !== this.run) return;
        this.setSnapshots(previous => ({
          ...previous,
          [nodePublicKey]: {
            ...(previous[nodePublicKey] ?? DEFAULT_BACKEND_SNAPSHOT),
            songs: mergeSongHeaders(
              previous[nodePublicKey]?.songs ?? [],
              library.songs,
            ),
            libraryRevision:
              previous[nodePublicKey]?.libraryRevision ?? library.revision,
          },
        }));
      })
      .catch(this.reportError);
  }

  private connect(backend: BackendRecord): void {
    const nodePublicKey = backend.nodePubkey;
    // A new connection commits its library again once, whatever it had.
    this.committedRevision.delete(nodePublicKey);
    const owns = () =>
      this.connections.get(nodePublicKey)?.connection === connection;
    const connection = this.deps.createConnection(
      backend,
      this.identity,
      this.pairTokens.get(nodePublicKey),
      {
        onSnapshot: snapshot => {
          if (!owns()) return;
          const wasReady =
            this.state.snapshots[nodePublicKey]?.phase === 'ready';
          this.setSnapshots(previous => ({
            ...previous,
            [nodePublicKey]: {
              ...snapshot,
              jobs: mergeJobViews(
                previous[nodePublicKey]?.jobs ?? [],
                snapshot.jobs,
              ),
              songs:
                snapshot.libraryRevision === null
                  ? mergeSongHeaders(
                      previous[nodePublicKey]?.songs ?? [],
                      snapshot.songs,
                    )
                  : snapshot.songs,
              libraryRevision:
                snapshot.libraryRevision ??
                previous[nodePublicKey]?.libraryRevision ??
                null,
            },
          }));
          // A job is persisted when it is new or its state moved; progress is
          // live data, and the node sends it again on the next connection.
          const persisted =
            this.persistedJobs.get(nodePublicKey) ?? new Map<string, string>();
          const changedJobs = snapshot.jobs.filter(
            job => persisted.get(job.id) !== job.state,
          );
          if (changedJobs.length > 0) {
            for (const job of changedJobs) persisted.set(job.id, job.state);
            this.persistedJobs.set(nodePublicKey, persisted);
            this.deps
              .mergeJobs(nodePublicKey, changedJobs)
              .then(jobs =>
                this.setSnapshots(previous => ({
                  ...previous,
                  [nodePublicKey]: {
                    ...(previous[nodePublicKey] ?? snapshot),
                    jobs: mergeJobViews(
                      previous[nodePublicKey]?.jobs ?? [],
                      jobs,
                    ),
                  },
                })),
              )
              .catch(this.reportError);
          }
          const revision = snapshot.libraryRevision;
          if (
            revision !== null &&
            !snapshot.librarySyncing &&
            this.committedRevision.get(nodePublicKey) !== revision
          ) {
            this.committedRevision.set(nodePublicKey, revision);
            this.deps
              .commitLibrary(nodePublicKey, revision, snapshot.songs)
              .catch(error => {
                // Not written, so the next snapshot tries again.
                this.committedRevision.delete(nodePublicKey);
                this.reportError(error);
              });
          }
          // The outbox is flushed when the node becomes ready, and again while
          // it still held something pending — which is how a submission whose
          // send failed is retried without a reconnect.
          if (
            snapshot.phase === 'ready' &&
            (!wasReady || this.outboxPending.has(nodePublicKey))
          ) {
            this.deps
              .loadOutbox()
              .then(entries => {
                const pending = entries.filter(
                  entry =>
                    entry.nodePublicKey === nodePublicKey &&
                    entry.state === 'pending',
                );
                if (pending.length > 0) this.outboxPending.add(nodePublicKey);
                else this.outboxPending.delete(nodePublicKey);
                return Promise.all(
                  pending.map(entry => this.sendOutbox(connection, entry)),
                );
              })
              .catch(this.reportError);
          }
        },
        /**
         * The node erased a job — at this phone's request or another
         * session's. Everything that remembers it has to be told, because
         * every other path here only ever merges jobs in.
         */
        onJobForgotten: jobId => {
          this.setSnapshots(previous => {
            const snapshot = previous[nodePublicKey];
            if (snapshot?.jobs.some(job => job.id === jobId) !== true) {
              return previous;
            }
            return {
              ...previous,
              [nodePublicKey]: {
                ...snapshot,
                jobs: snapshot.jobs.filter(job => job.id !== jobId),
              },
            };
          });
          this.deps
            .forgetJobs(nodePublicKey, [jobId])
            .then(() => this.deps.forgetSubmission(nodePublicKey, jobId))
            .then(() => this.refreshOutbox())
            .catch(this.reportError);
        },
        onNodeInfo: info => this.rememberNodeInfo(nodePublicKey, info),
        onPairTokenConsumed: () => this.pairTokens.delete(nodePublicKey),
        onTransportConfirmed: transport =>
          this.rememberTransport(nodePublicKey, transport),
      },
    );
    this.connections.set(nodePublicKey, {
      relayUrl: backend.relayUrl,
      connection,
    });
    connection.start();
  }

  /** The live connection, or the command's own words for its absence. */
  private live(
    nodePublicKey: string,
    missing: string,
  ): BackendRuntimeConnection {
    const live = this.connections.get(nodePublicKey);
    if (live === undefined) throw new Error(missing);
    return live.connection;
  }

  /** Every song the runtime knows about that has a deliverable file. */
  private audioRefs(): { key: string; ref: AudioRef }[] {
    return Object.entries(this.state.snapshots).flatMap(([nodeKey, snapshot]) =>
      snapshot.songs.flatMap(song => {
        const artifact = deliveryArtifact(song);
        if (artifact === undefined) return [];
        return [
          {
            key: audioKey(nodeKey, song.id, artifact.sha256),
            ref: { nodeKey, songId: song.id, digest: artifact.sha256 },
          },
        ];
      }),
    );
  }

  private inspectNewAudio(): void {
    this.inspectAudio(
      this.audioRefs().filter(entry => !this.inspected.has(entry.key)),
    );
  }

  /** Ask native about every known file: after anything that can evict. */
  private reconcileAudio(): void {
    this.inspectAudio(this.audioRefs());
  }

  private inspectAudio(entries: { key: string; ref: AudioRef }[]): void {
    if (entries.length === 0) return;
    for (const entry of entries) this.inspected.add(entry.key);
    const run = this.run;
    Promise.all(
      entries.map(async entry => ({
        key: entry.key,
        state: await this.deps.audioStore.inspect(entry.ref),
      })),
    )
      .then(inspected => {
        if (run !== this.run) return;
        let next: Record<string, LocalAudio> | null = null;
        const current = this.state.localAudio;
        for (const entry of inspected) {
          const before = current[entry.key];
          if (
            before !== undefined &&
            before.state === entry.state.state &&
            before.bytes === entry.state.bytes
          ) {
            continue;
          }
          next ??= { ...current };
          next[entry.key] = entry.state;
        }
        if (next !== null) this.update({ localAudio: next });
      })
      .catch(error => {
        for (const entry of entries) this.inspected.delete(entry.key);
        if (run === this.run) this.reportError(error);
      });
  }

  private readonly pairBackend = (request: PairingRequest): void => {
    const nodePublicKey = request.backend.nodePubkey;
    this.pairTokens.set(nodePublicKey, request.pairToken);
    this.connections.get(nodePublicKey)?.connection.stop();
    this.connections.delete(nodePublicKey);
    const current = this.state.backends ?? [];
    const existing = current.find(
      backend => backend.nodePubkey === nodePublicKey,
    );
    const backend = {
      ...request.backend,
      lastNodeInfo: existing?.lastNodeInfo ?? null,
    };
    this.update({ pairing: false });
    this.replaceBackends([
      ...current.filter(item => item.nodePubkey !== nodePublicKey),
      backend,
    ]);
  };

  private readonly renameBackend = (
    nodePublicKey: string,
    petname: string,
  ): void => {
    const trimmed = petname.trim();
    if (trimmed.length === 0) return;
    this.replaceBackends(
      (this.state.backends ?? []).map(backend =>
        backend.nodePubkey === nodePublicKey
          ? { ...backend, petname: trimmed }
          : backend,
      ),
    );
  };

  private readonly forgetBackend = async (
    nodePublicKey: string,
  ): Promise<void> => {
    // Stop talking to it first: a live socket would re-populate the snapshot
    // the moment the record is gone.
    this.connections.get(nodePublicKey)?.connection.stop();
    this.connections.delete(nodePublicKey);
    this.pairTokens.delete(nodePublicKey);

    // Released after the socket is down, so a transfer still in flight has
    // already been cut before its bytes are deleted underneath it.
    const released: string[] = [];
    for (const song of this.state.snapshots[nodePublicKey]?.songs ?? []) {
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
      const held = await this.deps.audioStore.inspect(ref).catch(() => null);
      if (held === null || held.state === 'pinned') continue;
      released.push(audioKey(nodePublicKey, song.id, artifact.sha256));
      if (held.state === 'remote') continue;
      // One failure must not strand the rest: a file that is already gone,
      // or that native refuses, still leaves the record to remove.
      try {
        await this.deps.audioStore.remove(ref);
      } catch (error) {
        this.reportError(error);
      }
    }

    this.replaceBackends(
      (this.state.backends ?? []).filter(
        backend => backend.nodePubkey !== nodePublicKey,
      ),
    );
    this.setSnapshots(current => ({
      ...current,
      [nodePublicKey]: {
        ...(current[nodePublicKey] ?? DEFAULT_BACKEND_SNAPSHOT),
        phase: 'disconnected',
        error: null,
        jobs: [],
        librarySyncing: false,
      },
    }));
    const localAudio = { ...this.state.localAudio };
    for (const key of released) {
      delete localAudio[key];
      // A re-pair should ask again, rather than trust an answer given before
      // the file was deleted.
      this.inspected.delete(key);
    }
    this.update({ localAudio });
  };

  private readonly submit = async (
    nodePublicKey: string,
    model: string,
    generation: GenerationRequest,
  ): Promise<void> => {
    const connection = this.live(nodePublicKey, 'Backend is not connected.');
    const entry = await this.deps.putPending(nodePublicKey, model, generation);
    // Until a read of the outbox finds it sent, snapshots keep retrying it.
    this.outboxPending.add(nodePublicKey);
    await this.refreshOutbox();
    await this.sendOutbox(connection, entry);
  };

  private readonly patchSong = async (
    nodePublicKey: string,
    song: SongHeader,
    patch: SongPatch,
  ): Promise<void> => {
    await this.live(nodePublicKey, 'Song node is not connected.').patchSong(
      song.id,
      song.revision,
      patch,
    );
  };

  private readonly controlJob = async (
    nodePublicKey: string,
    job: JobView,
    control: JobControl,
  ): Promise<void> => {
    await this.live(nodePublicKey, 'Job node is not connected.').controlJob(
      control,
      job.id,
      job.revision,
    );
  };

  private readonly forgetJob = async (
    nodePublicKey: string,
    job: JobView,
  ): Promise<void> => {
    await this.live(nodePublicKey, 'Job node is not connected.').forgetJob(
      job.id,
      job.revision,
    );
  };

  private readonly changeSongPresence = async (
    nodePublicKey: string,
    song: SongHeader,
  ): Promise<void> => {
    const connection = this.live(nodePublicKey, 'Song node is not connected.');
    if (song.trashed) {
      await connection.restoreSong(song.id, song.revision);
    } else {
      await connection.trashSong(song.id, song.revision);
    }
  };

  private readonly getSongDetail = async (
    nodePublicKey: string,
    songId: string,
  ): Promise<SongDetail> =>
    this.live(nodePublicKey, 'Song node is not connected.').getSong(songId);

  /**
   * The verified local path for a song, for the player to load.
   *
   * Runtime resolves and verifies; it does not make sound and does not import
   * `player/`. A partial download has no path — the native side refuses one.
   */
  private readonly audioPath = async (
    nodeKey: string,
    song: SongHeader,
    artifact: ArtifactView,
  ): Promise<string> =>
    this.deps.audioStore.localPath({
      nodeKey,
      songId: song.id,
      digest: artifact.sha256,
    });

  private readonly audio = async (
    nodeKey: string,
    song: SongHeader,
    artifact: ArtifactView,
    action: AudioAction,
  ): Promise<void> => {
    const ref: AudioRef = {
      nodeKey,
      songId: song.id,
      digest: artifact.sha256,
    };
    const key = audioKey(nodeKey, song.id, artifact.sha256);
    const identify = () => this.deps.audioStore.inspect(ref);
    let evicts = false;
    if (action === 'download' || action === 'keep') {
      const connection = this.live(nodeKey, 'Song node is not connected.');
      const before = await identify();
      if (before.state !== 'cached' && before.state !== 'pinned') {
        const sink: ArtifactSink = this.deps.audioStore.createSink(ref);
        this.markDownloading(key, true);
        try {
          /*
           * Progress is sampled, not forwarded.
           *
           * The node answers one acknowledgement per 64 KiB, so a song reports
           * progress sixty-odd times. The arriving arc does not need sixty
           * samples — it needs a number often enough to glide between, which
           * `ARRIVING_SAMPLE_MS` gives it. The last report is never dropped:
           * it is the one that says the song is here.
           */
          let lastSampleMs = 0;
          await connection.downloadArtifact(
            song.id,
            artifact,
            sink,
            (bytes, total) => {
              const now = Date.now();
              const done = bytes === total;
              if (!done && now - lastSampleMs < ARRIVING_SAMPLE_MS) return;
              lastSampleMs = now;
              this.setLocalAudio(key, {
                // A song being kept is still arriving until it is pinned.
                state: done && action === 'download' ? 'cached' : 'partial',
                bytes,
              });
            },
          );
          // Finalising runs the cache budget, which may have taken others.
          evicts = true;
        } finally {
          this.markDownloading(key, false);
        }
      }
      if (action === 'keep') await this.deps.audioStore.pin(ref);
    } else if (action === 'pin') {
      await this.deps.audioStore.pin(ref);
    } else if (action === 'unpin') {
      await this.deps.audioStore.unpin(ref);
      evicts = true;
    } else {
      await this.deps.audioStore.remove(ref);
    }
    this.setLocalAudio(key, await identify());
    if (evicts) this.reconcileAudio();
  };

  private readonly refreshLibraries = (): void => {
    for (const live of this.connections.values()) {
      live.connection.refreshLibrary();
    }
  };
}

/**
 * The previous snapshot when nothing a reader could see has changed.
 *
 * Merges build fresh arrays around the same song and job objects, so the
 * comparison is by member identity, not by value.
 */
function keepSnapshot(
  previous: ConnectionSnapshot | undefined,
  next: ConnectionSnapshot,
): ConnectionSnapshot {
  if (previous === undefined || previous === next) return next;
  const songs = sameMembers(previous.songs, next.songs)
    ? previous.songs
    : next.songs;
  const jobs = sameMembers(previous.jobs, next.jobs)
    ? previous.jobs
    : next.jobs;
  if (
    songs === previous.songs &&
    jobs === previous.jobs &&
    previous.phase === next.phase &&
    previous.error === next.error &&
    previous.libraryRevision === next.libraryRevision &&
    previous.librarySyncing === next.librarySyncing
  ) {
    return previous;
  }
  return songs === next.songs && jobs === next.jobs
    ? next
    : { ...next, songs, jobs };
}

function sameMembers<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
