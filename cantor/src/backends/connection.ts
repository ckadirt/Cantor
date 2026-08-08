import { Platform } from 'react-native';
import type { AppIdentity } from '../identity/derive';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { JobView } from '../../../protocol/JobView';
import type { SongDetail } from '../../../protocol/SongDetail';
import type { SongHeader } from '../../../protocol/SongHeader';
import type { SongPatch } from '../../../protocol/SongPatch';
import { mergeJobViews } from '../jobs/repository';
import { applyLibraryChanges, mergeSongHeaders } from '../library/repository';
import { signChallenge } from '../identity/derive';
import { backendRoomUrl, createPairProof } from './pairing';
import {
  isRecord,
  parseJob,
  parseJobs,
  parseLibraryChanges,
  parseNodeInfo,
  parseSong,
  parseSongDetail,
  parseSongs,
  APPLICATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  type BackendRecord,
  type ConnectionSnapshot,
  type NodeInfo,
} from './types';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 250;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Mobile networks drop idle sockets well before the relay would notice. The
 * relay answers this exact text frame from `setWebSocketAutoResponse` without
 * waking the Durable Object, so the keepalive is free on its side.
 */
const KEEPALIVE_INTERVAL_MS = 25_000;
const KEEPALIVE_PING = 'ping';
const KEEPALIVE_PONG = 'pong';
/** Matches `MAX_PETNAME_BYTES` in the node's `config.rs`. */
const MAX_PETNAME_BYTES = 64;

type ConnectionCallbacks = {
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onNodeInfo: (nodeInfo: NodeInfo) => void;
  onPairTokenConsumed: () => void;
};

type PendingRequest = {
  expected:
    | 'jobs.page'
    | 'job.accepted'
    | 'job.controlled'
    | 'library.page'
    | 'library.changes'
    | 'song.updated'
    | 'song.detail';
  resolveJob?: (value: JobView) => void;
  resolveSong?: (value: SongHeader) => void;
  resolveDetail?: (value: SongDetail) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class NodeRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NodeRequestError';
  }
}

export class SongRevisionConflict extends NodeRequestError {
  constructor(message: string, readonly current: SongHeader) {
    super(message, 'revision_conflict', false);
    this.name = 'SongRevisionConflict';
  }
}

export class BackendConnection {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fatal = false;
  private reconnectAttempt = 0;
  private pairToken: string | undefined;
  private handshakeId: string | null = null;
  private requestSequence = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private snapshot: ConnectionSnapshot = {
    phase: 'disconnected',
    error: null,
    jobs: [],
    songs: [],
    libraryRevision: null,
    librarySyncing: false,
  };
  private libraryStage: {
    snapshotRevision: number;
    songs: Map<string, SongHeader>;
  } | null = null;
  private libraryRequestInFlight = false;

  constructor(
    private readonly backend: BackendRecord,
    private readonly identity: AppIdentity,
    pairToken: string | undefined,
    private readonly callbacks: ConnectionCallbacks,
  ) {
    this.pairToken = pairToken;
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPending('Backend connection stopped.');
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(1000, 'backend-stopped');
    }
  }

  private connect(): void {
    if (this.stopped || this.fatal) {
      return;
    }
    this.clearPending('Backend reconnected before the request completed.');
    this.libraryStage = null;
    this.libraryRequestInFlight = false;
    this.setSnapshot({
      ...this.snapshot,
      phase: 'connecting',
      error: null,
    });
    let socket: WebSocket;
    try {
      socket = new WebSocket(backendRoomUrl(this.backend));
    } catch (error) {
      this.scheduleReconnect(readError(error));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) {
        this.startKeepalive();
      }
    };
    socket.onmessage = event => this.handleRelayMessage(event.data);
    socket.onerror = () => {
      // React Native follows this with onclose; that event owns retry timing.
    };
    socket.onclose = event => {
      if (this.socket === socket) {
        this.socket = null;
        this.stopKeepalive();
      }
      if (!this.stopped && !this.fatal) {
        this.scheduleReconnect(
          event.reason || `Relay connection closed (${event.code}).`,
        );
      }
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(KEEPALIVE_PING);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // Anything this build does not understand is skipped rather than treated as
  // an error. A frame type added by a newer relay must not be able to take a
  // deployed app offline permanently.
  private handleRelayMessage(data: unknown): void {
    if (typeof data !== 'string' || data === KEEPALIVE_PONG) {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame) || frame.v !== RELAY_PROTOCOL_VERSION) {
      return;
    }
    if (frame.t === 'relay.presence' && typeof frame.online === 'boolean') {
      if (frame.online) {
        this.beginHandshake();
      } else {
        this.handshakeId = null;
        this.setSnapshot({
          ...this.snapshot,
          phase: 'attached',
          error: null,
        });
      }
      return;
    }
    if (frame.t === 'relay.error') {
      if (frame.code === 'node-offline') {
        this.setSnapshot({
          ...this.snapshot,
          phase: 'attached',
          error: null,
        });
      } else {
        // The relay closes the socket after most errors; onclose owns retrying.
        this.fail(
          typeof frame.msg === 'string'
            ? frame.msg
            : 'Relay rejected the connection.',
          false,
        );
      }
      return;
    }
    if (frame.t === 'tunnel' && 'payload' in frame) {
      this.handleNodeMessage(frame.payload);
    }
  }

  private beginHandshake(): void {
    this.handshakeId = this.nextRequestId('hello');
    this.setSnapshot({
      ...this.snapshot,
      phase: 'handshaking',
      error: null,
    });
    let pairProof: string | undefined;
    try {
      pairProof = this.pairToken
        ? createPairProof(
            this.pairToken,
            this.backend.nodePubkey,
            this.identity.publicKey,
          )
        : undefined;
    } catch (error) {
      this.fail(readError(error), true);
      return;
    }
    const petname = devicePetname();
    this.sendApplication({
      t: 'hello',
      v: APPLICATION_PROTOCOL_VERSION,
      id: this.handshakeId,
      pubkey: this.identity.publicKey,
      ...(pairProof ? { pair_proof: pairProof } : {}),
      ...(petname ? { petname } : {}),
    });
  }

  private handleNodeMessage(payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }
    if (payload.v !== APPLICATION_PROTOCOL_VERSION) {
      this.fail('This app and node use incompatible protocol versions.', true);
      return;
    }
    if (
      payload.t === 'challenge' &&
      typeof payload.id === 'string' &&
      typeof payload.nonce === 'string' &&
      typeof payload.node_pubkey === 'string'
    ) {
      // A challenge for a superseded handshake is stale, not hostile.
      if (payload.id !== this.handshakeId) {
        return;
      }
      if (payload.node_pubkey !== this.backend.nodePubkey) {
        this.fail('Node identity does not match the pairing code.', true);
        return;
      }
      let signature: string;
      try {
        signature = signChallenge(
          this.identity,
          payload.nonce,
          payload.node_pubkey,
        );
      } catch (error) {
        this.fail(readError(error), true);
        return;
      }
      this.sendApplication({
        t: 'auth',
        v: APPLICATION_PROTOCOL_VERSION,
        id: payload.id,
        sig: signature,
      });
      return;
    }
    if (payload.t === 'welcome' && payload.id === this.handshakeId) {
      const nodeInfo = parseNodeInfo(payload.node);
      if (nodeInfo === null) {
        this.fail('Node capability data is invalid.', false);
        return;
      }
      this.handshakeId = null;
      this.reconnectAttempt = 0;
      if (this.pairToken !== undefined) {
        this.pairToken = undefined;
        this.callbacks.onPairTokenConsumed();
      }
      this.callbacks.onNodeInfo(nodeInfo);
      this.setSnapshot({
        ...this.snapshot,
        phase: 'ready',
        error: null,
      });
      const statusId = this.nextRequestId('status');
      this.pendingRequests.set(statusId, { expected: 'jobs.page' });
      this.sendApplication({
        t: 'status',
        v: APPLICATION_PROTOCOL_VERSION,
        id: statusId,
      });
      if (nodeInfo.features.library_list) {
        this.startFullLibrarySync();
      }
      return;
    }
    // Unsolicited, so it carries no request id: the node sends this whenever its
    // capabilities change rather than letting a connected app show stale ones.
    if (payload.t === 'node.info') {
      const nodeInfo = parseNodeInfo(payload.node);
      if (nodeInfo !== null) {
        this.callbacks.onNodeInfo(nodeInfo);
      }
      return;
    }
    if (payload.t === 'jobs.page' && typeof payload.id === 'string') {
      if (this.pendingRequests.get(payload.id)?.expected !== 'jobs.page') {
        return;
      }
      this.pendingRequests.delete(payload.id);
      const jobs = parseJobs(payload.jobs);
      if (jobs === null) {
        this.fail('Node job status is invalid.', false);
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        jobs: mergeJobViews(this.snapshot.jobs, jobs),
      });
      return;
    }
    if (payload.t === 'job.accepted' && typeof payload.id === 'string') {
      const pending = this.pendingRequests.get(payload.id);
      if (pending?.expected !== 'job.accepted') return;
      const job = parseJob(payload.job);
      if (job === null) return;
      this.finishPending(payload.id);
      pending.resolveJob?.(job);
      this.setSnapshot({
        ...this.snapshot,
        jobs: [job, ...this.snapshot.jobs.filter(item => item.id !== job.id)],
      });
      return;
    }
    if (payload.t === 'job.controlled' && typeof payload.id === 'string') {
      const pending = this.pendingRequests.get(payload.id);
      if (pending?.expected !== 'job.controlled') return;
      const job = parseJob(payload.job);
      if (job === null) return;
      this.finishPending(payload.id);
      pending.resolveJob?.(job);
      this.mergeCanonicalJob(job);
      return;
    }
    if (payload.t === 'job.updated') {
      const updated = parseJob(payload.job);
      if (updated === null) {
        return;
      }
      const existing = this.snapshot.jobs.find(job => job.id === updated.id);
      if (existing !== undefined && existing.revision >= updated.revision) {
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        jobs: [
          updated,
          ...this.snapshot.jobs.filter(job => job.id !== updated.id),
        ],
      });
      return;
    }
    if (payload.t === 'library.page' && typeof payload.id === 'string') {
      if (this.pendingRequests.get(payload.id)?.expected !== 'library.page') {
        return;
      }
      this.finishPending(payload.id);
      const songs = parseSongs(payload.songs);
      const snapshotRevision = payload.snapshot_revision;
      const tombstones = payload.tombstones;
      if (
        songs === null ||
        !isSafeRevision(snapshotRevision) ||
        !Array.isArray(tombstones) ||
        !tombstones.every(id => typeof id === 'string') ||
        !(
          payload.next_cursor === undefined ||
          typeof payload.next_cursor === 'string'
        )
      ) {
        this.libraryRequestInFlight = false;
        this.fail('Node library page is invalid.', false);
        return;
      }
      if (this.libraryStage === null) {
        this.libraryStage = {
          snapshotRevision,
          songs: new Map(),
        };
      } else if (this.libraryStage.snapshotRevision !== snapshotRevision) {
        this.libraryRequestInFlight = false;
        this.fail(
          'Node library snapshot changed inside one page sequence.',
          false,
        );
        return;
      }
      for (const song of songs) this.libraryStage.songs.set(song.id, song);
      for (const songId of tombstones) this.libraryStage.songs.delete(songId);
      if (typeof payload.next_cursor === 'string') {
        this.requestLibraryPage(payload.next_cursor);
        return;
      }
      const completed = mergeSongHeaders(
        [],
        [...this.libraryStage.songs.values()],
      );
      this.libraryStage = null;
      this.setSnapshot({
        ...this.snapshot,
        songs: completed,
        libraryRevision: snapshotRevision,
        librarySyncing: true,
      });
      this.requestLibraryChanges(snapshotRevision);
      return;
    }
    if (payload.t === 'library.changes' && typeof payload.id === 'string') {
      if (
        this.pendingRequests.get(payload.id)?.expected !== 'library.changes'
      ) {
        return;
      }
      this.finishPending(payload.id);
      const changes = parseLibraryChanges(payload.changes);
      const throughRevision = payload.through_revision;
      if (
        changes === null ||
        !isSafeRevision(throughRevision) ||
        typeof payload.has_more !== 'boolean' ||
        (this.snapshot.libraryRevision !== null &&
          throughRevision < this.snapshot.libraryRevision)
      ) {
        this.libraryRequestInFlight = false;
        this.fail('Node library changes are invalid.', false);
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        songs: applyLibraryChanges(this.snapshot.songs, changes),
        libraryRevision: throughRevision,
        librarySyncing: payload.has_more,
      });
      if (payload.has_more) {
        this.requestLibraryChanges(throughRevision);
      } else {
        this.libraryRequestInFlight = false;
      }
      return;
    }
    if (payload.t === 'song.updated' && typeof payload.id === 'string') {
      const pending = this.pendingRequests.get(payload.id);
      if (pending?.expected !== 'song.updated') return;
      const song = parseSong(payload.song);
      if (song === null) return;
      this.finishPending(payload.id);
      pending.resolveSong?.(song);
      this.setSnapshot({
        ...this.snapshot,
        songs: mergeSongHeaders(this.snapshot.songs, [song]),
      });
      return;
    }
    if (payload.t === 'song.detail' && typeof payload.id === 'string') {
      const pending = this.pendingRequests.get(payload.id);
      if (pending?.expected !== 'song.detail') return;
      const detail = parseSongDetail(payload.detail);
      if (detail === null) return;
      this.finishPending(payload.id);
      pending.resolveDetail?.(detail);
      return;
    }
    if (payload.t === 'library.changed' && isSafeRevision(payload.revision)) {
      if (
        !this.libraryRequestInFlight &&
        (this.snapshot.libraryRevision === null ||
          payload.revision > this.snapshot.libraryRevision)
      ) {
        if (this.snapshot.libraryRevision === null) this.startFullLibrarySync();
        else this.requestLibraryChanges(this.snapshot.libraryRevision);
      }
      return;
    }
    if (
      payload.t === 'error' &&
      typeof payload.code === 'string' &&
      typeof payload.message === 'string' &&
      typeof payload.retryable === 'boolean'
    ) {
      if (typeof payload.id === 'string') {
        const pending = this.pendingRequests.get(payload.id);
        if (
          pending?.expected === 'library.changes' &&
          payload.code === 'full_sync_required'
        ) {
          this.finishPending(payload.id);
          this.libraryRequestInFlight = false;
          this.startFullLibrarySync();
          return;
        }
        if (
          pending?.expected === 'library.page' ||
          pending?.expected === 'library.changes'
        ) {
          this.finishPending(payload.id);
          this.libraryRequestInFlight = false;
          this.libraryStage = null;
          this.setSnapshot({ ...this.snapshot, librarySyncing: false });
          return;
        }
        if (
          pending?.expected === 'song.updated' &&
          payload.code === 'revision_conflict' &&
          isRecord(payload.details) &&
          payload.details.kind === 'revision_conflict'
        ) {
          const current = parseSong(payload.details.current);
          if (current !== null) {
            this.finishPending(payload.id);
            this.setSnapshot({
              ...this.snapshot,
              songs: mergeSongHeaders(this.snapshot.songs, [current]),
            });
            pending.reject?.(
              new SongRevisionConflict(payload.message, current),
            );
            return;
          }
        }
        if (
          pending?.expected === 'job.controlled' &&
          isRecord(payload.details) &&
          ['job_revision_conflict', 'job_state'].includes(
            String(payload.details.kind),
          )
        ) {
          const current = parseJob(payload.details.current);
          if (current !== null) this.mergeCanonicalJob(current);
        }
        this.finishPending(payload.id);
        pending?.reject?.(
          new NodeRequestError(
            payload.message,
            payload.code,
            payload.retryable,
          ),
        );
        if (pending !== undefined && payload.code !== 'unsupported_version') {
          return;
        }
        if (pending === undefined && payload.id !== this.handshakeId) {
          return;
        }
      }
      // Only an explicit authorization refusal is worth giving up on; retrying
      // it would just spin against a node that has already said no.
      this.fail(
        payload.message,
        payload.code === 'rejected' || payload.code === 'unsupported_version',
      );
    }
  }

  private sendApplication(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    this.socket.send(
      JSON.stringify({ v: RELAY_PROTOCOL_VERSION, t: 'tunnel', payload }),
    );
  }

  createJob(
    clientRequestId: string,
    model: string,
    generation: GenerationRequest,
  ): Promise<JobView> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    const id = this.nextRequestId('create');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Job submission timed out. It is safe to retry.'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        expected: 'job.accepted',
        resolveJob: resolve,
        reject,
        timer,
      });
      this.sendApplication({
        t: 'job.create',
        v: APPLICATION_PROTOCOL_VERSION,
        id,
        client_request_id: clientRequestId,
        model,
        generation,
      });
    });
  }

  controlJob(
    control: 'pause' | 'resume' | 'cancel' | 'retry',
    jobId: string,
    expectedRevision: number,
  ): Promise<JobView> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    const id = this.nextRequestId(`job-${control}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error('Job control timed out. Refresh before trying again.'),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        expected: 'job.controlled',
        resolveJob: resolve,
        reject,
        timer,
      });
      this.sendApplication({
        t: `job.${control}`,
        v: APPLICATION_PROTOCOL_VERSION,
        id,
        job_id: jobId,
        expected_revision: expectedRevision,
      });
    });
  }

  patchSong(
    songId: string,
    expectedRevision: number,
    patch: SongPatch,
  ): Promise<SongHeader> {
    return this.mutateSong('song.patch', songId, expectedRevision, { patch });
  }

  getSong(songId: string): Promise<SongDetail> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    const id = this.nextRequestId('song-detail');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Song detail timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        expected: 'song.detail',
        resolveDetail: resolve,
        reject,
        timer,
      });
      this.sendApplication({
        t: 'song.get',
        v: APPLICATION_PROTOCOL_VERSION,
        id,
        song_id: songId,
      });
    });
  }

  trashSong(songId: string, expectedRevision: number): Promise<SongHeader> {
    return this.mutateSong('song.trash', songId, expectedRevision, {});
  }

  restoreSong(songId: string, expectedRevision: number): Promise<SongHeader> {
    return this.mutateSong('song.restore', songId, expectedRevision, {});
  }

  refreshLibrary(): void {
    if (this.snapshot.phase !== 'ready' || this.libraryRequestInFlight) return;
    if (this.snapshot.libraryRevision === null) this.startFullLibrarySync();
    else this.requestLibraryChanges(this.snapshot.libraryRevision);
  }

  private mutateSong(
    type: 'song.patch' | 'song.trash' | 'song.restore',
    songId: string,
    expectedRevision: number,
    extra: Record<string, unknown>,
  ): Promise<SongHeader> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    const id = this.nextRequestId('song');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Song update timed out. It is safe to refresh.'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        expected: 'song.updated',
        resolveSong: resolve,
        reject,
        timer,
      });
      this.sendApplication({
        t: type,
        v: APPLICATION_PROTOCOL_VERSION,
        id,
        song_id: songId,
        expected_revision: expectedRevision,
        ...extra,
      });
    });
  }

  private startFullLibrarySync(): void {
    if (this.libraryRequestInFlight) return;
    this.libraryStage = null;
    this.libraryRequestInFlight = true;
    this.setSnapshot({ ...this.snapshot, librarySyncing: true });
    this.requestLibraryPage(null);
  }

  private mergeCanonicalJob(job: JobView): void {
    this.setSnapshot({
      ...this.snapshot,
      jobs: mergeJobViews(this.snapshot.jobs, [job]),
    });
  }

  private requestLibraryPage(cursor: string | null): void {
    this.libraryRequestInFlight = true;
    const id = this.nextRequestId('library-page');
    this.setAutomaticRequest(id, 'library.page');
    this.sendApplication({
      t: 'library.list',
      v: APPLICATION_PROTOCOL_VERSION,
      id,
      limit: 100,
      include_trashed: true,
      ...(cursor === null ? {} : { cursor }),
    });
  }

  private requestLibraryChanges(sinceRevision: number): void {
    this.libraryRequestInFlight = true;
    const id = this.nextRequestId('library-sync');
    this.setAutomaticRequest(id, 'library.changes');
    this.sendApplication({
      t: 'library.sync',
      v: APPLICATION_PROTOCOL_VERSION,
      id,
      since_revision: sinceRevision,
      limit: 100,
    });
  }

  private setAutomaticRequest(
    id: string,
    expected: 'library.page' | 'library.changes',
  ): void {
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
      this.libraryRequestInFlight = false;
      this.libraryStage = null;
      this.setSnapshot({ ...this.snapshot, librarySyncing: false });
    }, REQUEST_TIMEOUT_MS);
    this.pendingRequests.set(id, { expected, timer });
  }

  private finishPending(id: string): void {
    const pending = this.pendingRequests.get(id);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
  }

  private clearPending(message: string): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject?.(new Error(message));
      this.pendingRequests.delete(id);
    }
  }

  private fail(message: string, fatal: boolean): void {
    this.fatal = this.fatal || fatal;
    this.libraryRequestInFlight = false;
    this.libraryStage = null;
    this.setSnapshot({
      ...this.snapshot,
      phase: 'disconnected',
      error: message,
      librarySyncing: false,
    });
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(fatal ? 1008 : 1011, fatal ? 'backend-error' : 'retry');
    } else if (!fatal) {
      this.scheduleReconnect(message);
    }
  }

  private scheduleReconnect(message: string): void {
    if (this.stopped || this.fatal || this.reconnectTimer !== null) {
      return;
    }
    this.setSnapshot({
      ...this.snapshot,
      phase: 'disconnected',
      error: message,
      librarySyncing: false,
    });
    const exponential = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 15),
      RECONNECT_MAX_MS,
    );
    const delay = exponential + Math.random() * RECONNECT_JITTER_MS;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private nextRequestId(kind: string): string {
    this.requestSequence += 1;
    return `${kind}-${Date.now()}-${this.requestSequence}`;
  }

  private setSnapshot(snapshot: ConnectionSnapshot): void {
    this.snapshot = snapshot;
    this.callbacks.onSnapshot(snapshot);
  }
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * How this phone names itself in the node's pairing list. `Platform.constants`
 * already carries the Android brand and model, so this needs no dependency.
 * The node applies the same rules again and drops anything that fails them.
 */
export function devicePetname(): string | undefined {
  const constants = Platform.constants as Partial<{
    Brand: string;
    Model: string;
  }>;
  const parts = [constants.Brand, constants.Model].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  // A model that already repeats the brand ("Google Pixel 8") should not
  // become "Google Google Pixel 8".
  const name = (
    parts.length === 2 &&
    parts[1].toLowerCase().startsWith(parts[0].toLowerCase())
      ? parts[1]
      : parts.join(' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0 || /\p{Cc}/u.test(name)) {
    return undefined;
  }
  return truncateToBytes(name, MAX_PETNAME_BYTES);
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  // Trim whole code points so a truncated name never becomes invalid UTF-8.
  const codePoints = [...value];
  while (codePoints.length > 0) {
    codePoints.pop();
    const candidate = codePoints.join('').trimEnd();
    if (utf8ByteLength(candidate) <= maxBytes) {
      return candidate;
    }
  }
  return '';
}

/** The node counts bytes, so the app has to as well. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
