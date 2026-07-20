import type { AppIdentity } from '../identity/derive';
import { signChallenge } from '../identity/derive';
import { backendRoomUrl } from './pairing';
import {
  isRecord,
  parseJobs,
  parseNodeInfo,
  type BackendRecord,
  type ConnectionSnapshot,
  type NodeInfo,
} from './types';

const PROTOCOL_VERSION = 1;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 250;

type ConnectionCallbacks = {
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onNodeInfo: (nodeInfo: NodeInfo) => void;
  onPairTokenConsumed: () => void;
};

export class BackendConnection {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fatal = false;
  private reconnectAttempt = 0;
  private pairToken: string | undefined;
  private handshakeId: string | null = null;
  private requestSequence = 0;
  private snapshot: ConnectionSnapshot = {
    phase: 'disconnected',
    error: null,
    jobs: [],
  };

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
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    this.setSnapshot({ phase: 'connecting', error: null, jobs: [] });
    let socket: WebSocket;
    try {
      socket = new WebSocket(backendRoomUrl(this.backend));
    } catch (error) {
      this.scheduleReconnect(readError(error));
      return;
    }
    this.socket = socket;
    socket.onmessage = event => this.handleRelayMessage(event.data);
    socket.onerror = () => {
      // React Native follows this with onclose; that event owns retry timing.
    };
    socket.onclose = event => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (!this.stopped && !this.fatal) {
        this.scheduleReconnect(
          event.reason || `Relay connection closed (${event.code}).`,
        );
      }
    };
  }

  private handleRelayMessage(data: unknown): void {
    if (typeof data !== 'string') {
      this.fail('Relay sent a binary frame.', true);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      this.fail('Relay sent invalid JSON.', true);
      return;
    }
    if (!isRecord(frame) || frame.v !== PROTOCOL_VERSION) {
      this.fail('Relay protocol version is not supported.', true);
      return;
    }
    if (frame.t === 'relay.presence' && typeof frame.online === 'boolean') {
      if (frame.online) {
        this.beginHandshake();
      } else {
        this.handshakeId = null;
        this.setSnapshot({ phase: 'attached', error: null, jobs: [] });
      }
      return;
    }
    if (frame.t === 'relay.error') {
      if (frame.code === 'node-offline') {
        this.setSnapshot({ phase: 'attached', error: null, jobs: [] });
      } else {
        this.fail(
          typeof frame.msg === 'string'
            ? frame.msg
            : 'Relay rejected the connection.',
          true,
        );
      }
      return;
    }
    if (frame.t === 'tunnel' && 'payload' in frame) {
      this.handleNodeMessage(frame.payload);
      return;
    }
    this.fail('Relay sent an unexpected frame.', true);
  }

  private beginHandshake(): void {
    this.handshakeId = this.nextRequestId('hello');
    this.setSnapshot({ phase: 'handshaking', error: null, jobs: [] });
    this.sendApplication({
      t: 'hello',
      v: PROTOCOL_VERSION,
      id: this.handshakeId,
      pubkey: this.identity.publicKey,
      ...(this.pairToken ? { pair_token: this.pairToken } : {}),
    });
  }

  private handleNodeMessage(payload: unknown): void {
    if (!isRecord(payload) || payload.v !== PROTOCOL_VERSION) {
      this.fail('Node sent an invalid application message.', true);
      return;
    }
    if (
      payload.t === 'challenge' &&
      typeof payload.id === 'string' &&
      typeof payload.nonce === 'string' &&
      typeof payload.node_pubkey === 'string'
    ) {
      if (payload.id !== this.handshakeId) {
        this.fail('Node challenge does not match this handshake.', true);
        return;
      }
      if (payload.node_pubkey !== this.backend.nodePubkey) {
        this.fail('Node identity does not match the pairing code.', true);
        return;
      }
      let signature: string;
      try {
        signature = signChallenge(this.identity, payload.nonce);
      } catch (error) {
        this.fail(readError(error), true);
        return;
      }
      this.sendApplication({
        t: 'auth',
        v: PROTOCOL_VERSION,
        id: payload.id,
        sig: signature,
      });
      return;
    }
    if (payload.t === 'welcome' && payload.id === this.handshakeId) {
      const nodeInfo = parseNodeInfo(payload.node);
      if (nodeInfo === null) {
        this.fail('Node capability data is invalid.', true);
        return;
      }
      this.handshakeId = null;
      this.reconnectAttempt = 0;
      if (this.pairToken !== undefined) {
        this.pairToken = undefined;
        this.callbacks.onPairTokenConsumed();
      }
      this.callbacks.onNodeInfo(nodeInfo);
      this.setSnapshot({ phase: 'ready', error: null, jobs: [] });
      this.sendApplication({
        t: 'status',
        v: PROTOCOL_VERSION,
        id: this.nextRequestId('status'),
      });
      return;
    }
    if (payload.t === 'jobs') {
      const jobs = parseJobs(payload.jobs);
      if (jobs === null) {
        this.fail('Node job status is invalid.', true);
        return;
      }
      this.setSnapshot({ ...this.snapshot, jobs });
      return;
    }
    if (
      payload.t === 'error' &&
      typeof payload.code === 'string' &&
      typeof payload.msg === 'string'
    ) {
      this.fail(payload.msg, payload.code === 'rejected');
      return;
    }
    this.fail('Node sent an unexpected application message.', true);
  }

  private sendApplication(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.fail('Relay connection is not open.', false);
      return;
    }
    this.socket.send(
      JSON.stringify({ v: PROTOCOL_VERSION, t: 'tunnel', payload }),
    );
  }

  private fail(message: string, fatal: boolean): void {
    this.fatal = this.fatal || fatal;
    this.setSnapshot({ phase: 'disconnected', error: message, jobs: [] });
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
    this.setSnapshot({ phase: 'disconnected', error: message, jobs: [] });
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
