import { base58 } from '@scure/base';
import { Platform } from 'react-native';
import { BackendConnection, devicePetname } from '../connection';
import { deriveIdentity } from '../../identity/derive';
import type { BackendRecord, ConnectionSnapshot, NodeInfo } from '../types';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NODE_PUBKEY = base58.encode(new Uint8Array(32).fill(3));

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
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
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame),
    });
  }

  send(data: string): void {
    this.sent.push(data);
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
};

function nodeInfoFixture(name: string): Record<string, unknown> {
  return {
    name,
    device_type: 'linux-x86_64',
    engine_version: 'ace-step-1.5-stub',
    models: ['ace-step-1.5'],
    limits: { max_concurrent_jobs: 0, max_song_seconds: 0 },
    load: { active_jobs: 0, queued_jobs: 0 },
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
    },
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

    socket.receive({ v: 1, t: 'relay.somethingNew', detail: 'from a newer relay' });
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
        v: 1,
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

  it('applies an unsolicited node.info push after welcome', () => {
    const { socket, snapshots, nodeInfos } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    const hello = JSON.parse(socket.sent.at(-1) ?? '{}');
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 1,
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
        v: 1,
        t: 'welcome',
        id: hello.payload.id,
        node: nodeInfoFixture('first-name'),
      },
    });
    expect(nodeInfos.at(-1)?.name).toBe('first-name');

    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {v: 1, t: 'node.info', node: nodeInfoFixture('renamed-node')},
    });

    expect(nodeInfos.at(-1)?.name).toBe('renamed-node');
    // A push is not a failure and must not disturb the connection.
    expect(snapshots.at(-1)?.phase).toBe('ready');
  });

  // The one case that should still give up: an explicit authorization refusal.
  it('stops retrying once the node rejects the key', () => {
    const { socket, snapshots } = connect();
    socket.receive({ v: 1, t: 'relay.presence', online: true });
    socket.receive({
      v: 1,
      t: 'tunnel',
      payload: {
        v: 1,
        t: 'error',
        id: 'hello-1',
        code: 'rejected',
        msg: 'This client key is not authorized.',
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
