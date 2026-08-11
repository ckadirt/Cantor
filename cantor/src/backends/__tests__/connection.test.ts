import { base58, base64urlnopad } from '@scure/base';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Platform } from 'react-native';
import {
  BackendConnection,
  NodeRequestError,
  SongRevisionConflict,
  devicePetname,
} from '../connection';
import { deriveIdentity } from '../../identity/derive';
import type { BackendRecord, ConnectionSnapshot, NodeInfo } from '../types';
import type { SecureChannel } from '../../security/native';
import {
  encodeClientCarrier,
  parseClientCarrier,
} from '../../security/carrier';
import { decodeNodeInner, encodeControlInner } from '../../security/inner';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NODE_SECRET = new Uint8Array(32).fill(3);
const NODE_KEY_BYTES = ed.getPublicKey(NODE_SECRET);
const NODE_PUBKEY = base58.encode(NODE_KEY_BYTES);
const TRANSPORT_KEY = new Uint8Array(32).fill(4);
const TRANSPORT_KEY_ID = [...sha256(TRANSPORT_KEY)]
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');
const TRANSPORT_DESCRIPTOR = {
  schema: 1 as const,
  node_ed25519: NODE_PUBKEY,
  transport_suite: 'noise-nk-25519-chachapoly-sha256-v1' as const,
  transport_key_id: TRANSPORT_KEY_ID,
  transport_x25519: base64urlnopad.encode(TRANSPORT_KEY),
  signature_ed25519: base64urlnopad.encode(
    ed.sign(
      concatBytes(
        utf8ToBytes('cantor-transport-binding-v1'),
        NODE_KEY_BYTES,
        TRANSPORT_KEY,
      ),
      NODE_SECRET,
    ),
  ),
};

function fakeSecureChannel(): SecureChannel {
  let live = true;
  return {
    begin: () => {
      if (!live) throw new Error('destroyed');
      return 'first-message';
    },
    finish: message => {
      if (!live || message !== 'second-message') {
        throw new Error('bad fake handshake');
      }
    },
    encrypt: inner => {
      if (!live) throw new Error('destroyed');
      return [Uint8Array.from(inner)];
    },
    decrypt: ciphertext => {
      if (!live) throw new Error('destroyed');
      return Uint8Array.from(ciphertext);
    },
    destroy: () => {
      live = false;
    },
  };
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  rawSent: (string | ArrayBuffer)[] = [];
  secureEstablished = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    if (
      this.secureEstablished &&
      typeof frame === 'object' &&
      frame !== null &&
      (frame as { t?: unknown }).t === 'tunnel' &&
      'payload' in frame
    ) {
      this.receiveInner(
        encodeControlInner(
          (frame as { payload: Record<string, unknown> }).payload,
        ),
      );
      return;
    }
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame),
    });
  }

  receiveInner(inner: Uint8Array): void {
    this.onmessage?.({ data: encodeClientCarrier(inner) });
  }

  receivePlainTunnel(payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ v: 1, t: 'tunnel', payload }),
    });
  }

  send(data: string | ArrayBuffer): void {
    this.rawSent.push(data);
    if (data instanceof ArrayBuffer) {
      const inner = parseClientCarrier(data);
      this.sent.push(JSON.stringify({ payload: decodeNodeInner(inner) }));
      return;
    }
    this.sent.push(data);
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (
      typeof frame === 'object' &&
      frame !== null &&
      'payload' in frame &&
      (frame as { payload?: { t?: unknown } }).payload?.t === 'secure.init'
    ) {
      const id = (frame as { payload: { id: string } }).payload.id;
      this.receivePlainTunnel({
        v: 1,
        t: 'secure.offer',
        id,
        descriptor: TRANSPORT_DESCRIPTOR,
        channel_nonce: base64urlnopad.encode(new Uint8Array(32).fill(7)),
      });
    } else if (
      typeof frame === 'object' &&
      frame !== null &&
      'payload' in frame &&
      (frame as { payload?: { t?: unknown } }).payload?.t ===
        'secure.handshake'
    ) {
      const id = (frame as { payload: { id: string } }).payload.id;
      this.secureEstablished = true;
      this.receivePlainTunnel({
        v: 1,
        t: 'secure.handshake',
        id,
        step: 2,
        data: 'second-message',
      });
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const backend: BackendRecord = {
  nodePubkey: NODE_PUBKEY,
  relayUrl: 'wss://relay.test',
  petname: 'Test node',
  lastNodeInfo: null,
  transport: TRANSPORT_DESCRIPTOR,
};

function nodeInfoFixture(
  name: string,
  library = false,
): Record<string, unknown> {
  return {
    name,
    device_type: 'linux-x86_64',
    engine_version: 'ace-step-1.5-stub',
    models: [
      {
        selector: 'acestep:1.5-fast',
        family: 'acestep',
        engine: 'acestep',
      },
    ],
    limits: {
      max_concurrent_jobs: 0,
      max_queued_jobs_per_principal: 32,
      min_song_seconds: 15,
      max_song_seconds: 600,
      max_caption_bytes: 1024,
      max_lyrics_bytes: 65536,
      max_page_limit: 100,
    },
    load: { active_jobs: 0, queued_jobs: 0, accepting_jobs: false },
    features: {
      jobs_create: false,
      library_list: library,
      artifacts_transfer: false,
      secure_tunnel: true,
      job_controls: false,
    },
  };
}

function songFixture(id: string, revision = 1): Record<string, unknown> {
  return {
    id,
    revision,
    title: `Song ${id}`,
    caption_summary: `Caption ${id}`,
    created_at: `2026-08-0${id === 'a' ? 8 : 7}T00:00:00Z`,
    duration_ms: 14_240,
    model: 'acestep:1.5-fast',
    favorite: revision > 1,
    tags: [],
    trashed: false,
    artifacts: [
      {
        kind: 'master',
        media_type: 'audio/wav',
        byte_length: 100,
        sha256: 'a'.repeat(64),
        sample_rate: 48_000,
        channels: 2,
      },
    ],
  };
}

function jobFixture(
  state: string,
  revision: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
    revision,
    state,
    model: 'acestep:1.5-fast',
    created_at: '2026-08-07T00:00:00Z',
    updated_at: `2026-08-07T00:00:0${revision}Z`,
    ...extra,
  };
}

function connect(): {
  socket: FakeSocket;
  snapshots: ConnectionSnapshot[];
  nodeInfos: NodeInfo[];
  connection: BackendConnection;
} {
  const snapshots: ConnectionSnapshot[] = [];
  const nodeInfos: NodeInfo[] = [];
  const connection = new BackendConnection(
    backend,
    deriveIdentity(PHRASE),
    undefined,
    {
      onSnapshot: snapshot => snapshots.push(snapshot),
      onNodeInfo: nodeInfo => nodeInfos.push(nodeInfo),
      onPairTokenConsumed: () => {},
      onTransportConfirmed: () => {},
    },
    () => fakeSecureChannel(),
  );
  connection.start();
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error('BackendConnection did not open a socket.');
  }
  socket.open();
  return { socket, snapshots, nodeInfos, connection };
}

describe('BackendConnection', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    jest.useRealTimers();
  });

  it('keeps the relay socket warm while it is open', () => {
    const { socket, connection } = connect();

    jest.advanceTimersByTime(26_000);
    expect(socket.sent).toEqual(['ping']);

    jest.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual(['ping', 'ping']);

    connection.stop();
    jest.advanceTimersByTime(60_000);
    expect(socket.sent).toEqual(['ping', 'ping']);
  });

  it('ignores the relay keepalive reply', () => {
    const { socket, snapshots } = connect();
    const before = snapshots.length;

    socket.receive('pong');

    expect(snapshots).toHaveLength(before);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
  });

  // A relay that ships a new frame type must not be able to brick a build that
  // predates it: unknown frames are skipped, and the connection stays usable.
  it('survives frames it does not understand', () => {
    const { socket, snapshots } = connect();

    socket.receive({
      v: 1,
      t: 'relay.somethingNew',
      detail: 'from a newer relay',
    });
    socket.receive({ v: 99, t: 'relay.presence', online: true });
    socket.receive('not json at all');

    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(snapshots.at(-1)?.phase).toBe('connecting');

    // The connection still works afterwards.
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    expect(snapshots.at(-1)?.phase).toBe('handshaking');
  });

  it('signs the node challenge over a preimage bound to the node key', () => {
    const { socket } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });

    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(hello.payload.t).toBe('hello');

    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });

    const auth = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(auth.payload.t).toBe('auth');
    expect(auth.payload.sig).toEqual(expect.any(String));
  });

  it('sends no application identity before Noise and uses binary afterwards', () => {
    const { socket } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });

    expect(socket.rawSent).toHaveLength(3);
    expect(socket.rawSent[0]).toEqual(
      expect.stringContaining('"t":"secure.init"'),
    );
    expect(socket.rawSent[1]).toEqual(
      expect.stringContaining('"t":"secure.handshake"'),
    );
    expect(socket.rawSent[0]).not.toEqual(
      expect.stringContaining(deriveIdentity(PHRASE).publicKey),
    );
    expect(socket.rawSent[2]).toBeInstanceOf(ArrayBuffer);
  });

  it('rejects plaintext application data after the secure channel opens', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    socket.receivePlainTunnel({
      v: 2,
      t: 'node.info',
      node: nodeInfoFixture('plaintext'),
    });
    expect(snapshots.at(-1)?.error).toContain('plaintext');
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });

  it('applies an unsolicited node.info push after welcome', () => {
    const { socket, snapshots, nodeInfos } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('first-name'),
      },
    });
    expect(nodeInfos.at(-1)?.name).toBe('first-name');

    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: { v: 2, t: 'node.info', node: nodeInfoFixture('renamed-node') },
    });

    expect(nodeInfos.at(-1)?.name).toBe('renamed-node');
    // A push is not a failure and must not disturb the connection.
    expect(snapshots.at(-1)?.phase).toBe('ready');
  });

  it('does not let a stale response resolve a newer request', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('node'),
      },
    });
    const status = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'jobs.page',
        id: 'stale-status',
        jobs: [],
      },
    });
    expect(snapshots.at(-1)?.jobs).toEqual([]);
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'jobs.page',
        id: status.payload.id,
        jobs: [],
      },
    });
    expect(snapshots.at(-1)?.phase).toBe('ready');
  });

  it('correlates job acceptance and keeps terminal request errors local', async () => {
    const { socket, snapshots, connection } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('node'),
      },
    });

    const rejected = connection.createJob(
      '11111111-1111-4111-8111-111111111111',
      'acestep:1.5-fast',
      { caption: 'one' },
    );
    const rejectedFrame = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'error',
        id: rejectedFrame.payload.id,
        code: 'invalid_request',
        message: 'Bad caption.',
        retryable: false,
      },
    });
    const rejection = await rejected.catch(error => error);
    expect(rejection).toBeInstanceOf(NodeRequestError);
    expect(rejection).toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
    expect(snapshots.at(-1)?.phase).toBe('ready');

    const accepted = connection.createJob(
      '22222222-2222-4222-8222-222222222222',
      'acestep:1.5-fast',
      { caption: 'two' },
    );
    const acceptedFrame = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'job.accepted',
        id: acceptedFrame.payload.id,
        job: {
          id: '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
          revision: 1,
          state: 'queued',
          model: 'acestep:1.5-fast',
          created_at: '2026-08-07T00:00:00Z',
          updated_at: '2026-08-07T00:00:00Z',
        },
      },
    });
    await expect(accepted).resolves.toMatchObject({ state: 'queued' });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'job.updated',
        job: {
          id: '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
          revision: 3,
          state: 'running',
          stage: 'diffuse',
          progress: { completed: 2, total: 10, unit: 'steps' },
          model: 'acestep:1.5-fast',
          created_at: '2026-08-07T00:00:00Z',
          updated_at: '2026-08-07T00:00:02Z',
        },
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'job.updated',
        job: {
          id: '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
          revision: 2,
          state: 'queued',
          model: 'acestep:1.5-fast',
          created_at: '2026-08-07T00:00:00Z',
          updated_at: '2026-08-07T00:00:01Z',
        },
      },
    });
    expect(snapshots.at(-1)?.jobs[0]).toMatchObject({
      revision: 3,
      state: 'running',
    });
    socket.receive({ v: 1, t: 'relay.presence', online: false });
    expect(snapshots.at(-1)).toMatchObject({
      phase: 'attached',
      jobs: [{ revision: 3, state: 'running' }],
    });
  });

  it('stages full pages, catches incremental changes, and retains the cache offline', () => {
    const { socket, snapshots, connection } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('library-node', true),
      },
    });
    const firstRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(firstRequest.payload.t).toBe('library.list');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'library.page',
        id: firstRequest.payload.id,
        snapshot_revision: 2,
        songs: [songFixture('a')],
        tombstones: [],
        next_cursor: 'signed-next',
      },
    });
    expect(snapshots.at(-1)?.songs).toEqual([]);
    const secondRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(secondRequest.payload).toMatchObject({
      t: 'library.list',
      cursor: 'signed-next',
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'library.page',
        id: secondRequest.payload.id,
        snapshot_revision: 2,
        songs: [songFixture('b')],
        tombstones: [],
      },
    });
    expect(snapshots.at(-1)).toMatchObject({
      libraryRevision: 2,
      librarySyncing: true,
      songs: [{ id: 'a' }, { id: 'b' }],
    });
    const syncRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(syncRequest.payload).toMatchObject({
      t: 'library.sync',
      since_revision: 2,
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'library.changes',
        id: syncRequest.payload.id,
        through_revision: 3,
        changes: [
          {
            revision: 3,
            song_id: 'b',
            kind: 'upsert',
            changed_at: '2026-08-08T00:00:01Z',
            song: songFixture('b', 2),
          },
        ],
        has_more: false,
      },
    });
    expect(snapshots.at(-1)).toMatchObject({
      libraryRevision: 3,
      librarySyncing: false,
      songs: [{ id: 'a' }, { id: 'b', revision: 2, favorite: true }],
    });
    connection.refreshLibrary();
    const refreshRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(refreshRequest.payload).toMatchObject({
      t: 'library.sync',
      since_revision: 3,
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'library.changes',
        id: refreshRequest.payload.id,
        through_revision: 3,
        changes: [],
        has_more: false,
      },
    });
    socket.receive({ v: 1, t: 'relay.presence', online: false });
    expect(snapshots.at(-1)).toMatchObject({
      phase: 'attached',
      libraryRevision: 3,
      songs: [{ id: 'a' }, { id: 'b' }],
    });
  });

  it('returns the current song on an optimistic revision conflict', async () => {
    const { socket, connection, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('node'),
      },
    });
    const update = connection.patchSong('a', 1, { title: 'Mine' });
    const request = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'error',
        id: request.payload.id,
        code: 'revision_conflict',
        message: 'Changed elsewhere.',
        retryable: false,
        details: { kind: 'revision_conflict', current: songFixture('a', 2) },
      },
    });
    await expect(update).rejects.toBeInstanceOf(SongRevisionConflict);
    expect(snapshots.at(-1)?.songs[0]).toMatchObject({ id: 'a', revision: 2 });
  });

  it('waits for canonical job control responses and adopts race winners', async () => {
    const { socket, connection, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('node'),
      },
    });

    const pause = connection.controlJob(
      'pause',
      '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
      1,
    );
    const pauseRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(pauseRequest.payload).toMatchObject({
      t: 'job.pause',
      expected_revision: 1,
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'job.controlled',
        id: pauseRequest.payload.id,
        job: jobFixture('pause_requested', 2, { stage: 'codes' }),
      },
    });
    await expect(pause).resolves.toMatchObject({ state: 'pause_requested' });
    expect(snapshots.at(-1)?.jobs[0]).toMatchObject({
      state: 'pause_requested',
      revision: 2,
    });

    const cancel = connection.controlJob(
      'cancel',
      '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
      2,
    );
    const cancelRequest = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'error',
        id: cancelRequest.payload.id,
        code: 'revision_conflict',
        message: 'The job completed first.',
        retryable: false,
        details: {
          kind: 'job_revision_conflict',
          current: jobFixture('completed', 3),
        },
      },
    });
    await expect(cancel).rejects.toBeInstanceOf(NodeRequestError);
    expect(snapshots.at(-1)?.jobs[0]).toMatchObject({
      state: 'completed',
      revision: 3,
    });
  });

  it('rejects a plaintext application frame before the secure handshake', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'tunnel', payload: { v: 1, t: 'challenge' } });
    expect(snapshots.at(-1)?.error).toBe(
      'Node did not complete the required secure handshake.',
    );
  });

  it('surfaces an application protocol mismatch inside ciphertext', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    socket.receive({ v: 1, t: 'tunnel', payload: { v: 1, t: 'challenge' } });
    expect(snapshots.at(-1)?.error).toBe(
      'This app and node use incompatible protocol versions.',
    );
  });

  it('advances an artifact only after the durable sink acknowledges each chunk', async () => {
    const { socket, connection } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'challenge',
        id: hello.payload.id,
        nonce: 'A'.repeat(43),
        node_pubkey: NODE_PUBKEY,
      },
    });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('node'),
      },
    });
    const digest = 'd'.repeat(64);
    const append = jest.fn(async () => 3);
    const finalize = jest.fn(async () => undefined);
    const download = connection.downloadArtifact(
      '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
      {
        kind: 'delivery',
        profile: 'opus-stereo-160k-v1',
        media_type: 'audio/ogg; codecs=opus',
        byte_length: 3,
        sha256: digest,
        sample_rate: 48_000,
        channels: 2,
      },
      { offset: async () => 0, append, finalize },
    );
    await Promise.resolve();
    const open = JSON.parse(socket.sent.at(-1) ?? '{}').payload;
    expect(open).toMatchObject({ t: 'artifact.open', offset: 0 });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'artifact.info',
        id: open.id,
        transfer_id: 'transfer-1',
        song_id: open.song_id,
        artifact: {
          kind: 'delivery',
          profile: 'opus-stereo-160k-v1',
          media_type: 'audio/ogg; codecs=opus',
          byte_length: 3,
          sha256: digest,
          sample_rate: 48_000,
          channels: 2,
        },
        accepted_offset: 0,
        chunk_bytes: 65_536,
        window_chunks: 1,
      },
    });
    await Promise.resolve();
    const firstAck = JSON.parse(socket.sent.at(-1) ?? '{}').payload;
    expect(firstAck).toMatchObject({ t: 'artifact.ack', next_offset: 0 });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'artifact.chunk',
        id: firstAck.id,
        transfer_id: 'transfer-1',
        offset: 0,
        data: 'YWJj',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(append).toHaveBeenCalledWith(0, 'YWJj');
    const finalAck = JSON.parse(socket.sent.at(-1) ?? '{}').payload;
    expect(finalAck).toMatchObject({ t: 'artifact.ack', next_offset: 3 });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'artifact.complete',
        id: finalAck.id,
        transfer_id: 'transfer-1',
        byte_length: 3,
        sha256: digest,
      },
    });
    await expect(download).resolves.toBeUndefined();
    expect(finalize).toHaveBeenCalledWith(3);
  });

  // The one case that should still give up: an explicit authorization refusal.
  it('stops retrying once the node rejects the key', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 2,
        t: 'error',
        id: hello.payload.id,
        code: 'rejected',
        message: 'This client key is not authorized.',
        retryable: false,
      },
    });

    expect(snapshots.at(-1)?.error).toBe('This client key is not authorized.');

    const socketCount = FakeSocket.instances.length;
    jest.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(socketCount);
  });
});

describe('devicePetname', () => {
  const constants = Platform.constants as Record<string, unknown>;
  const original = { ...constants };

  afterEach(() => {
    for (const key of Object.keys(constants)) delete constants[key];
    Object.assign(constants, original);
  });

  function setConstants(next: Record<string, unknown>): void {
    for (const key of ['Brand', 'Model']) delete constants[key];
    Object.assign(constants, next);
  }

  it('joins the brand and model this phone reports', () => {
    setConstants({ Brand: 'Xiaomi', Model: 'Redmi Note 11' });
    expect(devicePetname()).toBe('Xiaomi Redmi Note 11');
  });

  it('does not repeat a brand the model already carries', () => {
    setConstants({ Brand: 'Google', Model: 'Google Pixel 8' });
    expect(devicePetname()).toBe('Google Pixel 8');
  });

  it('yields nothing when the platform reports no device name', () => {
    setConstants({});
    expect(devicePetname()).toBeUndefined();
  });

  // The node caps petnames at 64 bytes and drops anything longer, so a long
  // name has to be shortened here rather than silently discarded there.
  it('truncates to the byte budget the node enforces', () => {
    setConstants({ Brand: 'B'.repeat(40), Model: 'M'.repeat(40) });
    const petname = devicePetname() ?? '';
    expect(petname).toMatch(/^[ -~]+$/);
    expect(petname.length).toBeLessThanOrEqual(64);
    expect(petname.startsWith('B'.repeat(40))).toBe(true);
  });
});
