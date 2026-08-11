import { Platform } from 'react-native';
import type { AppIdentity } from '../identity/derive';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { ClientMessage } from '../../../protocol/ClientMessage';
import type { SongPatch } from '../../../protocol/SongPatch';
import type { ArtifactView } from '../../../protocol/ArtifactView';
import { readError } from '../core/errors';
import {
  APPLICATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseJob,
  parseNodeInfo,
  parseSong,
  type JobView,
  type NodeInfo,
  type SongDetail,
  type SongHeader,
} from '../core/protocol';
import { utf8ByteLength } from '../core/text';
import { isRecord } from '../core/validation';
import { mergeJobViews } from '../jobs/repository';
import { mergeSongHeaders } from '../library/repository';
import {
  createLibrarySyncState,
  reduceLibrarySync,
  type LibrarySyncEvent,
  type LibrarySyncState,
} from '../library/sync';
import { signChallenge } from '../identity/derive';
import { backendRoomUrl, createPairProof } from './pairing';
import {
  createNativeSecureChannel,
  type SecureChannelFactory,
} from '../security/native';
import type { TransportDescriptor } from '../security/types';
import { SecureTunnel } from '../security/secureTunnel';
import type { BackendRecord, ConnectionSnapshot } from './types';
import {
  decodeArtifactInfo,
  decodeArtifactPart,
  decodeJobResponse,
  decodeJobsPage,
  decodeLibraryChanges,
  decodeLibraryPage,
  decodeSongDetailResponse,
  decodeSongResponse,
  isSafeRevision,
  type ArtifactInfo,
  type ArtifactPart,
} from './applicationResponses';
import {
  RequestRegistry,
  ignoreResponse,
  rejectResponse,
  resolveResponse,
} from './requestRegistry';
import { RelaySocket } from './relaySocket';

const REQUEST_TIMEOUT_MS = 15_000;
/** Matches `MAX_PETNAME_BYTES` in the node's `config.rs`. */
const MAX_PETNAME_BYTES = 64;

type ConnectionCallbacks = {
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onNodeInfo: (nodeInfo: NodeInfo) => void;
  onPairTokenConsumed: () => void;
  onTransportConfirmed: (descriptor: TransportDescriptor) => void;
};

export type ArtifactSink = {
  offset: () => Promise<number>;
  append: (offset: number, encoded: string) => Promise<number>;
  finalize: (byteLength: number) => Promise<void>;
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
  private readonly relay: RelaySocket;
  private readonly secure: SecureTunnel;
  private pairToken: string | undefined;
  private handshakeId: string | null = null;
  private requestSequence = 0;
  private readonly requests: RequestRegistry;
  private snapshot: ConnectionSnapshot = {
    phase: 'disconnected',
    error: null,
    jobs: [],
    songs: [],
    libraryRevision: null,
    librarySyncing: false,
  };
  private librarySync: LibrarySyncState = createLibrarySyncState();

  constructor(
    private readonly backend: BackendRecord,
    private readonly identity: AppIdentity,
    pairToken: string | undefined,
    private readonly callbacks: ConnectionCallbacks,
    secureFactory: SecureChannelFactory = createNativeSecureChannel,
  ) {
    this.pairToken = pairToken;
    this.requests = new RequestRegistry(kind => this.nextRequestId(kind));
    this.secure = new SecureTunnel(
      backend.nodePubkey,
      backend.transport,
      secureFactory,
      {
        sendText: payload => this.sendSecureText(payload),
        sendBinary: frame => {
          this.relay.send(frame);
        },
        onApplicationMessage: payload => this.handleNodeMessage(payload),
        onReady: () => this.beginApplicationHandshake(),
        onTransportConfirmed: descriptor =>
          this.callbacks.onTransportConfirmed(descriptor),
        onFailure: (message, fatal) => this.fail(message, fatal),
      },
    );
    this.relay = new RelaySocket(backendRoomUrl(backend), {
      onBeforeConnect: () => {
        this.clearPending('Backend reconnected before the request completed.');
        this.resetSecure();
        this.resetLibrarySync();
        this.setSnapshot({
          ...this.snapshot,
          phase: 'connecting',
          error: null,
        });
      },
      onMessage: data => this.handleRelayMessage(data),
      onSocketClosed: () => this.resetSecure(),
      onReconnectScheduled: message => {
        this.setSnapshot({
          ...this.snapshot,
          phase: 'disconnected',
          error: message,
          librarySyncing: false,
        });
      },
    });
  }

  start(): void {
    this.relay.start();
  }

  stop(): void {
    this.relay.stop();
    this.resetSecure();
    this.clearPending('Backend connection stopped.');
  }

  // Anything this build does not understand is skipped rather than treated as
  // an error. A frame type added by a newer relay must not be able to take a
  // deployed app offline permanently.
  private handleRelayMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.secure.handleBinary(data);
      return;
    }
    if (typeof data !== 'string') {
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
        this.beginSecureHandshake();
      } else {
        this.resetSecure();
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
        this.resetSecure();
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
      this.secure.handleText(frame.payload);
    }
  }

  private beginSecureHandshake(): void {
    this.resetSecure();
    const secureHandshakeId = this.nextRequestId('secure');
    this.setSnapshot({
      ...this.snapshot,
      phase: 'handshaking',
      error: null,
    });
    this.secure.begin(secureHandshakeId);
  }

  private beginApplicationHandshake(): void {
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
      this.relay.resetReconnectAttempt();
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
      const statusId = this.requests.register(
        'status',
        {
          expected: 'jobs.page',
          decode: message => {
            const jobs = decodeJobsPage(message);
            return resolveResponse(
              jobs === null
                ? ({ kind: 'invalid' } as const)
                : ({ kind: 'valid', jobs } as const),
            );
          },
        },
        {
          resolve: result => {
            if (result.kind === 'invalid') {
              this.fail('Node job status is invalid.', false);
              return;
            }
            this.setSnapshot({
              ...this.snapshot,
              jobs: mergeJobViews(this.snapshot.jobs, result.jobs),
            });
          },
          reject: () => {},
        },
      );
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
      this.requests.deliver(payload.id, 'jobs.page', payload);
      return;
    }
    if (payload.t === 'job.accepted' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'job.accepted', payload);
      return;
    }
    if (payload.t === 'job.controlled' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'job.controlled', payload);
      return;
    }
    if (payload.t === 'job.updated') {
      const updated = decodeJobResponse(payload);
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
      this.requests.deliver(payload.id, 'library.page', payload);
      return;
    }
    if (payload.t === 'library.changes' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'library.changes', payload);
      return;
    }
    if (payload.t === 'song.updated' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'song.updated', payload);
      return;
    }
    if (payload.t === 'song.detail' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'song.detail', payload);
      return;
    }
    if (payload.t === 'artifact.info' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'artifact.info', payload);
      return;
    }
    if (payload.t === 'artifact.chunk' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'artifact.part', payload);
      return;
    }
    if (payload.t === 'artifact.complete' && typeof payload.id === 'string') {
      this.requests.deliver(payload.id, 'artifact.part', payload);
      return;
    }
    if (payload.t === 'library.changed' && isSafeRevision(payload.revision)) {
      this.transitionLibrary({ type: 'changed', revision: payload.revision });
      return;
    }
    if (
      payload.t === 'error' &&
      typeof payload.code === 'string' &&
      typeof payload.message === 'string' &&
      typeof payload.retryable === 'boolean'
    ) {
      if (typeof payload.id === 'string') {
        const registeredExpected = this.requests.expected(payload.id);
        if (
          registeredExpected === 'library.changes' &&
          payload.code === 'full_sync_required'
        ) {
          this.requests.finish(payload.id);
          this.transitionLibrary({ type: 'full-sync-required' });
          return;
        }
        if (
          registeredExpected === 'library.page' ||
          registeredExpected === 'library.changes'
        ) {
          this.requests.finish(payload.id);
          this.transitionLibrary({ type: 'request-failed' });
          return;
        }
        if (
          registeredExpected === 'song.updated' &&
          payload.code === 'revision_conflict' &&
          isRecord(payload.details) &&
          payload.details.kind === 'revision_conflict'
        ) {
          const current = parseSong(payload.details.current);
          if (current !== null) {
            this.setSnapshot({
              ...this.snapshot,
              songs: mergeSongHeaders(this.snapshot.songs, [current]),
            });
            this.requests.reject(
              payload.id,
              new SongRevisionConflict(payload.message, current),
            );
            return;
          }
        }
        if (
          registeredExpected === 'job.controlled' &&
          isRecord(payload.details) &&
          ['job_revision_conflict', 'job_state'].includes(
            String(payload.details.kind),
          )
        ) {
          const current = parseJob(payload.details.current);
          if (current !== null) this.mergeCanonicalJob(current);
        }
        const registered = this.requests.reject(
          payload.id,
          new NodeRequestError(
            payload.message,
            payload.code,
            payload.retryable,
          ),
        );
        if (registered && payload.code !== 'unsupported_version') {
          return;
        }
        if (!registered && payload.id !== this.handshakeId) {
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

  private sendApplication(payload: ClientMessage): void {
    if (!this.relay.isOpen()) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    this.secure.sendApplication(payload);
  }

  private sendSecureText(payload: Record<string, unknown>): void {
    if (!this.relay.isOpen()) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    this.relay.send(
      JSON.stringify({ v: RELAY_PROTOCOL_VERSION, t: 'tunnel', payload }),
    );
  }

  private resetSecure(): void {
    this.secure.reset();
  }

  createJob(
    clientRequestId: string,
    model: string,
    generation: GenerationRequest,
  ): Promise<JobView> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    let id = '';
    return new Promise((resolve, reject) => {
      id = this.requests.register(
        'create',
        {
          expected: 'job.accepted',
          decode: message => {
            const job = decodeJobResponse(message);
            return job === null ? ignoreResponse() : resolveResponse(job);
          },
          timeout: {
            afterMs: REQUEST_TIMEOUT_MS,
            error: () =>
              new Error('Job submission timed out. It is safe to retry.'),
          },
        },
        {
          resolve: job => {
            resolve(job);
            this.setSnapshot({
              ...this.snapshot,
              jobs: [
                job,
                ...this.snapshot.jobs.filter(item => item.id !== job.id),
              ],
            });
          },
          reject,
        },
      );
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
    let id = '';
    return new Promise((resolve, reject) => {
      id = this.requests.register(
        `job-${control}`,
        {
          expected: 'job.controlled',
          decode: message => {
            const job = decodeJobResponse(message);
            return job === null ? ignoreResponse() : resolveResponse(job);
          },
          timeout: {
            afterMs: REQUEST_TIMEOUT_MS,
            error: () =>
              new Error('Job control timed out. Refresh before trying again.'),
          },
        },
        {
          resolve: job => {
            resolve(job);
            this.mergeCanonicalJob(job);
          },
          reject,
        },
      );
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
    const request = this.requests.request('song-detail', {
      expected: 'song.detail',
      decode: message => {
        const detail = decodeSongDetailResponse(message);
        return detail === null ? ignoreResponse() : resolveResponse(detail);
      },
      timeout: {
        afterMs: REQUEST_TIMEOUT_MS,
        error: () => new Error('Song detail timed out.'),
      },
    });
    this.sendApplication({
      t: 'song.get',
      v: APPLICATION_PROTOCOL_VERSION,
      id: request.id,
      song_id: songId,
    });
    return request.promise;
  }

  async downloadArtifact(
    songId: string,
    artifact: ArtifactView,
    sink: ArtifactSink,
    onProgress?: (written: number, total: number) => void,
  ): Promise<void> {
    if (this.snapshot.phase !== 'ready') {
      throw new Error('Backend is not ready.');
    }
    let offset = await sink.offset();
    const info = await this.openArtifact(
      songId,
      artifact.profile,
      offset,
      artifact.sha256,
    );
    if (
      info.songId !== songId ||
      info.acceptedOffset !== offset ||
      info.artifact.profile !== artifact.profile ||
      info.artifact.sha256 !== artifact.sha256 ||
      info.artifact.byte_length !== artifact.byte_length
    ) {
      throw new Error('Node opened a different artifact than requested.');
    }
    onProgress?.(offset, artifact.byte_length);
    while (true) {
      const part = await this.ackArtifact(info.transferId, offset);
      if (part.transferId !== info.transferId) {
        throw new Error('Node switched artifact transfer sessions.');
      }
      if (part.kind === 'complete') {
        if (
          part.byteLength !== artifact.byte_length ||
          part.sha256 !== artifact.sha256 ||
          offset !== artifact.byte_length
        ) {
          throw new Error(
            'Node artifact completion does not match the download.',
          );
        }
        await sink.finalize(part.byteLength);
        onProgress?.(part.byteLength, part.byteLength);
        return;
      }
      if (part.offset !== offset) {
        throw new Error('Node artifact chunk is out of order.');
      }
      const next = await sink.append(offset, part.data);
      if (next <= offset || next > artifact.byte_length) {
        throw new Error('Native artifact writer returned an invalid offset.');
      }
      offset = next;
      onProgress?.(offset, artifact.byte_length);
    }
  }

  trashSong(songId: string, expectedRevision: number): Promise<SongHeader> {
    return this.mutateSong('song.trash', songId, expectedRevision, {});
  }

  restoreSong(songId: string, expectedRevision: number): Promise<SongHeader> {
    return this.mutateSong('song.restore', songId, expectedRevision, {});
  }

  refreshLibrary(): void {
    if (this.snapshot.phase !== 'ready') return;
    this.transitionLibrary({ type: 'refresh' });
  }

  private openArtifact(
    songId: string,
    profile: string,
    offset: number,
    expectedSha256: string,
  ): Promise<ArtifactInfo> {
    const request = this.requests.request('artifact-open', {
      expected: 'artifact.info',
      decode: message => {
        const info = decodeArtifactInfo(message);
        if (info === null) {
          return rejectResponse(
            new Error('Node artifact transfer limits are invalid.'),
          );
        }
        return resolveResponse(info);
      },
      timeout: {
        afterMs: REQUEST_TIMEOUT_MS,
        error: () =>
          new Error(
            'Opening the audio transfer timed out. It is safe to retry.',
          ),
      },
    });
    this.sendApplication({
      t: 'artifact.open',
      v: APPLICATION_PROTOCOL_VERSION,
      id: request.id,
      song_id: songId,
      profile,
      offset,
      expected_sha256: expectedSha256,
    });
    return request.promise;
  }

  private ackArtifact(
    transferId: string,
    nextOffset: number,
  ): Promise<ArtifactPart> {
    const request = this.requests.request<ArtifactPart>('artifact-ack', {
      expected: 'artifact.part',
      decode: message => {
        const part = decodeArtifactPart(message);
        if (part === null) {
          const invalidMessage =
            isRecord(message) && message.t === 'artifact.complete'
              ? 'Node artifact completion is invalid.'
              : 'Node artifact chunk is invalid.';
          return rejectResponse(new Error(invalidMessage));
        }
        return resolveResponse(part);
      },
      timeout: {
        afterMs: REQUEST_TIMEOUT_MS,
        error: () =>
          new Error('Audio transfer timed out. It is safe to retry.'),
      },
    });
    this.sendApplication({
      t: 'artifact.ack',
      v: APPLICATION_PROTOCOL_VERSION,
      id: request.id,
      transfer_id: transferId,
      next_offset: nextOffset,
    });
    return request.promise;
  }

  private mutateSong(
    type: 'song.patch' | 'song.trash' | 'song.restore',
    songId: string,
    expectedRevision: number,
    extra: { patch: SongPatch } | Record<string, never>,
  ): Promise<SongHeader> {
    if (this.snapshot.phase !== 'ready') {
      return Promise.reject(new Error('Backend is not ready.'));
    }
    let id = '';
    return new Promise((resolve, reject) => {
      id = this.requests.register(
        'song',
        {
          expected: 'song.updated',
          decode: message => {
            const song = decodeSongResponse(message);
            return song === null ? ignoreResponse() : resolveResponse(song);
          },
          timeout: {
            afterMs: REQUEST_TIMEOUT_MS,
            error: () =>
              new Error('Song update timed out. It is safe to refresh.'),
          },
        },
        {
          resolve: song => {
            resolve(song);
            this.setSnapshot({
              ...this.snapshot,
              songs: mergeSongHeaders(this.snapshot.songs, [song]),
            });
          },
          reject,
        },
      );
      this.sendApplication(
        type === 'song.patch'
          ? {
              t: type,
              v: APPLICATION_PROTOCOL_VERSION,
              id,
              song_id: songId,
              expected_revision: expectedRevision,
              patch: extra.patch,
            }
          : {
              t: type,
              v: APPLICATION_PROTOCOL_VERSION,
              id,
              song_id: songId,
              expected_revision: expectedRevision,
            },
      );
    });
  }

  private startFullLibrarySync(): void {
    this.transitionLibrary({ type: 'start-full' });
  }

  private mergeCanonicalJob(job: JobView): void {
    this.setSnapshot({
      ...this.snapshot,
      jobs: mergeJobViews(this.snapshot.jobs, [job]),
    });
  }

  private requestLibraryPage(cursor: string | null): void {
    const id = this.requests.register<LibrarySyncEvent | null>(
      'library-page',
      {
        expected: 'library.page',
        decode: message => {
          const page = decodeLibraryPage(message);
          if (page === null) return resolveResponse(null);
          return resolveResponse<LibrarySyncEvent>({
            type: 'page',
            ...page,
          });
        },
        timeout: {
          afterMs: REQUEST_TIMEOUT_MS,
          onTimeout: () => this.transitionLibrary({ type: 'request-failed' }),
        },
      },
      {
        resolve: event => {
          if (event === null) {
            this.fail('Node library page is invalid.', false);
          } else {
            this.transitionLibrary(event);
          }
        },
        reject: () => {},
      },
    );
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
    const id = this.requests.register<LibrarySyncEvent | null>(
      'library-sync',
      {
        expected: 'library.changes',
        decode: message => {
          const batch = decodeLibraryChanges(message);
          if (batch === null) return resolveResponse(null);
          return resolveResponse<LibrarySyncEvent>({
            type: 'changes',
            ...batch,
          });
        },
        timeout: {
          afterMs: REQUEST_TIMEOUT_MS,
          onTimeout: () => this.transitionLibrary({ type: 'request-failed' }),
        },
      },
      {
        resolve: event => {
          if (event === null) {
            this.fail('Node library changes are invalid.', false);
          } else {
            this.transitionLibrary(event);
          }
        },
        reject: () => {},
      },
    );
    this.sendApplication({
      t: 'library.sync',
      v: APPLICATION_PROTOCOL_VERSION,
      id,
      since_revision: sinceRevision,
      limit: 100,
    });
  }

  private clearPending(message: string): void {
    this.requests.clear(message);
  }

  private transitionLibrary(event: LibrarySyncEvent): void {
    const transition = reduceLibrarySync(
      {
        ...this.librarySync,
        songs: this.snapshot.songs,
        libraryRevision: this.snapshot.libraryRevision,
        librarySyncing: this.snapshot.librarySyncing,
      },
      event,
    );
    this.librarySync = transition.state;
    if (transition.publishSnapshot) {
      this.setSnapshot({
        ...this.snapshot,
        songs: transition.state.songs,
        libraryRevision: transition.state.libraryRevision,
        librarySyncing: transition.state.librarySyncing,
      });
    }
    for (const effect of transition.effects) {
      if (effect.type === 'request-page') {
        this.requestLibraryPage(effect.cursor);
      } else if (effect.type === 'request-changes') {
        this.requestLibraryChanges(effect.sinceRevision);
      } else {
        this.fail(effect.message, false);
      }
    }
  }

  private resetLibrarySync(
    librarySyncing = this.snapshot.librarySyncing,
  ): void {
    this.librarySync = createLibrarySyncState({
      songs: this.snapshot.songs,
      libraryRevision: this.snapshot.libraryRevision,
      librarySyncing,
    });
  }

  private fail(message: string, fatal: boolean): void {
    this.resetLibrarySync(false);
    this.resetSecure();
    this.setSnapshot({
      ...this.snapshot,
      phase: 'disconnected',
      error: message,
      librarySyncing: false,
    });
    this.relay.fail(message, fatal);
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
