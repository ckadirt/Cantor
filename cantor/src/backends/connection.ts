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
  parseArtifact,
  parseJob,
  parseJobs,
  parseLibraryChanges,
  parseNodeInfo,
  parseSong,
  parseSongDetail,
  parseSongs,
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
  buildHandshakePrologue,
  decodeChannelNonce,
  descriptorsEqual,
  TRANSPORT_SUITE,
  verifyTransportDescriptor,
} from '../security/descriptor';
import {
  createNativeSecureChannel,
  type SecureChannel,
  type SecureChannelFactory,
} from '../security/native';
import {
  decodeNodeInner,
  encodeClientCarrier,
  encodeControlInner,
  parseClientCarrier,
} from '../security/wire';
import type { TransportDescriptor } from '../security/types';
import type { BackendRecord, ConnectionSnapshot } from './types';
import {
  RequestRegistry,
  ignoreResponse,
  rejectResponse,
  resolveResponse,
} from './requestRegistry';

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
  onTransportConfirmed: (descriptor: TransportDescriptor) => void;
};

type ArtifactInfo = {
  transferId: string;
  songId: string;
  artifact: ArtifactView;
  acceptedOffset: number;
  chunkBytes: number;
  windowChunks: number;
};

type ArtifactPart =
  | { kind: 'chunk'; transferId: string; offset: number; data: string }
  | {
      kind: 'complete';
      transferId: string;
      byteLength: number;
      sha256: string;
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
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fatal = false;
  private reconnectAttempt = 0;
  private pairToken: string | undefined;
  private secureChannel: SecureChannel | null = null;
  private secureHandshakeId: string | null = null;
  private pendingTransport: TransportDescriptor | null = null;
  private confirmedTransport: TransportDescriptor | undefined;
  private secureReady = false;
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
    private readonly secureFactory: SecureChannelFactory = createNativeSecureChannel,
  ) {
    this.pairToken = pairToken;
    this.confirmedTransport = backend.transport;
    this.requests = new RequestRegistry(kind => this.nextRequestId(kind));
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.resetSecure();
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
    this.resetSecure();
    this.resetLibrarySync();
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
    (socket as WebSocket & { binaryType: string }).binaryType = 'arraybuffer';
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
        this.resetSecure();
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
    if (data instanceof ArrayBuffer) {
      this.handleSecureBinary(data);
      return;
    }
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
      this.handleSecureText(frame.payload);
    }
  }

  private beginSecureHandshake(): void {
    this.resetSecure();
    const secureHandshakeId = this.nextRequestId('secure');
    this.secureHandshakeId = secureHandshakeId;
    this.setSnapshot({
      ...this.snapshot,
      phase: 'handshaking',
      error: null,
    });
    this.sendSecureText({
      v: 1,
      t: 'secure.init',
      id: secureHandshakeId,
      suite: TRANSPORT_SUITE,
    });
  }

  private handleSecureText(payload: unknown): void {
    if (!isRecord(payload)) {
      this.fail('Node secure handshake response is invalid.', false);
      return;
    }
    if (payload.t === 'secure.error') {
      this.fail(
        typeof payload.message === 'string'
          ? payload.message
          : 'Node refused the secure channel.',
        false,
      );
      return;
    }
    if (
      payload.t === 'secure.offer' &&
      payload.v === 1 &&
      payload.id === this.secureHandshakeId
    ) {
      if (this.secureChannel !== null || this.secureReady) {
        this.fail('Node repeated the secure channel offer.', true);
        return;
      }
      try {
        const descriptor = verifyTransportDescriptor(
          payload.descriptor,
          this.backend.nodePubkey,
        );
        if (
          this.confirmedTransport !== undefined &&
          !descriptorsEqual(this.confirmedTransport, descriptor)
        ) {
          throw new Error(
            'The node transport key changed. Remove and pair this node again.',
          );
        }
        const channelNonce = decodeChannelNonce(payload.channel_nonce);
        const secureHandshakeId = this.secureHandshakeId;
        if (secureHandshakeId === null) {
          throw new Error('Secure handshake id is missing.');
        }
        const channel = this.secureFactory(secureHandshakeId);
        const firstMessage = channel.begin(
          descriptor.transport_x25519,
          buildHandshakePrologue(descriptor, channelNonce),
        );
        this.secureChannel = channel;
        this.pendingTransport = descriptor;
        this.sendSecureText({
          v: 1,
          t: 'secure.handshake',
          id: this.secureHandshakeId,
          step: 1,
          data: firstMessage,
        });
      } catch (error) {
        this.fail(readError(error), true);
      }
      return;
    }
    if (
      payload.t === 'secure.handshake' &&
      payload.v === 1 &&
      payload.id === this.secureHandshakeId &&
      payload.step === 2 &&
      typeof payload.data === 'string' &&
      this.secureChannel !== null &&
      this.pendingTransport !== null
    ) {
      try {
        this.secureChannel.finish(payload.data);
        this.secureReady = true;
        const descriptor = this.pendingTransport;
        this.pendingTransport = null;
        if (
          this.confirmedTransport === undefined ||
          !descriptorsEqual(this.confirmedTransport, descriptor)
        ) {
          this.confirmedTransport = descriptor;
          this.callbacks.onTransportConfirmed(descriptor);
        }
        this.beginApplicationHandshake();
      } catch (error) {
        this.fail(`Secure handshake failed: ${readError(error)}`, true);
      }
      return;
    }
    this.fail(
      this.secureReady
        ? 'Node attempted to send plaintext after the secure channel opened.'
        : 'Node did not complete the required secure handshake.',
      true,
    );
  }

  private handleSecureBinary(frame: ArrayBuffer): void {
    if (!this.secureReady || this.secureChannel === null) {
      this.fail(
        'Node sent encrypted data before the secure channel opened.',
        false,
      );
      return;
    }
    try {
      const ciphertext = parseClientCarrier(frame);
      const inner = this.secureChannel.decrypt(ciphertext);
      if (inner !== null) this.handleNodeMessage(decodeNodeInner(inner));
    } catch (error) {
      this.fail(`Secure channel failed: ${readError(error)}`, false);
    }
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
      const statusId = this.requests.register(
        'status',
        {
          expected: 'jobs.page',
          decode: message => {
            const jobs = isRecord(message) ? parseJobs(message.jobs) : null;
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
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    if (!this.secureReady || this.secureChannel === null) {
      this.fail('Secure transport is not ready.', false);
      return;
    }
    try {
      for (const ciphertext of this.secureChannel.encrypt(
        encodeControlInner(payload),
      )) {
        this.socket.send(encodeClientCarrier(ciphertext));
      }
    } catch (error) {
      this.fail(`Secure channel failed: ${readError(error)}`, false);
    }
  }

  private sendSecureText(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    this.socket.send(
      JSON.stringify({ v: RELAY_PROTOCOL_VERSION, t: 'tunnel', payload }),
    );
  }

  private resetSecure(): void {
    const channel = this.secureChannel;
    this.secureChannel = null;
    this.secureReady = false;
    this.secureHandshakeId = null;
    this.pendingTransport = null;
    try {
      channel?.destroy();
    } catch {
      // The native channel is already unusable; local references are cleared.
    }
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
            if (!isRecord(message)) return ignoreResponse();
            const job = parseJob(message.job);
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
            if (!isRecord(message)) return ignoreResponse();
            const job = parseJob(message.job);
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
        if (!isRecord(message)) return ignoreResponse();
        const detail = parseSongDetail(message.detail);
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
        if (!isRecord(message)) {
          return rejectResponse(
            new Error('Node artifact transfer limits are invalid.'),
          );
        }
        const artifact = parseArtifact(message.artifact);
        if (
          artifact === null ||
          typeof message.transfer_id !== 'string' ||
          typeof message.song_id !== 'string' ||
          !isSafeRevision(message.accepted_offset) ||
          !isPositiveSafeInteger(message.chunk_bytes) ||
          !isPositiveSafeInteger(message.window_chunks) ||
          message.chunk_bytes > 64 * 1024 ||
          message.window_chunks !== 1
        ) {
          return rejectResponse(
            new Error('Node artifact transfer limits are invalid.'),
          );
        }
        return resolveResponse({
          transferId: message.transfer_id,
          songId: message.song_id,
          artifact,
          acceptedOffset: message.accepted_offset,
          chunkBytes: message.chunk_bytes,
          windowChunks: message.window_chunks,
        });
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
        if (!isRecord(message)) {
          return rejectResponse(new Error('Node artifact chunk is invalid.'));
        }
        if (message.t === 'artifact.chunk') {
          if (
            typeof message.transfer_id !== 'string' ||
            !isSafeRevision(message.offset) ||
            typeof message.data !== 'string' ||
            message.data.length === 0 ||
            message.data.length > 88_000
          ) {
            return rejectResponse(new Error('Node artifact chunk is invalid.'));
          }
          return resolveResponse({
            kind: 'chunk' as const,
            transferId: message.transfer_id,
            offset: message.offset,
            data: message.data,
          });
        }
        if (
          message.t !== 'artifact.complete' ||
          typeof message.transfer_id !== 'string' ||
          !isSafeRevision(message.byte_length) ||
          typeof message.sha256 !== 'string'
        ) {
          return rejectResponse(
            new Error('Node artifact completion is invalid.'),
          );
        }
        return resolveResponse({
          kind: 'complete' as const,
          transferId: message.transfer_id,
          byteLength: message.byte_length,
          sha256: message.sha256,
        });
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
            if (!isRecord(message)) return ignoreResponse();
            const song = parseSong(message.song);
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
          if (!isRecord(message)) return resolveResponse(null);
          const songs = parseSongs(message.songs);
          const snapshotRevision = message.snapshot_revision;
          const tombstones = message.tombstones;
          if (
            songs === null ||
            !isSafeRevision(snapshotRevision) ||
            !Array.isArray(tombstones) ||
            !tombstones.every(songId => typeof songId === 'string') ||
            !(
              message.next_cursor === undefined ||
              typeof message.next_cursor === 'string'
            )
          ) {
            return resolveResponse(null);
          }
          return resolveResponse<LibrarySyncEvent>({
            type: 'page',
            snapshotRevision,
            songs,
            tombstones,
            ...(message.next_cursor === undefined
              ? {}
              : { nextCursor: message.next_cursor }),
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
          if (!isRecord(message)) return resolveResponse(null);
          const changes = parseLibraryChanges(message.changes);
          if (
            changes === null ||
            !isSafeRevision(message.through_revision) ||
            typeof message.has_more !== 'boolean'
          ) {
            return resolveResponse(null);
          }
          return resolveResponse<LibrarySyncEvent>({
            type: 'changes',
            changes,
            throughRevision: message.through_revision,
            hasMore: message.has_more,
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
    this.fatal = this.fatal || fatal;
    this.resetLibrarySync(false);
    this.resetSecure();
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

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeRevision(value) && value > 0;
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
