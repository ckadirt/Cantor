import { readError } from '../core/errors';

export const RELAY_KEEPALIVE_INTERVAL_MS = 25_000;
export const RELAY_KEEPALIVE_PING = 'ping';
export const RELAY_KEEPALIVE_PONG = 'pong';
export const RELAY_RECONNECT_BASE_MS = 1_000;
export const RELAY_RECONNECT_MAX_MS = 30_000;
export const RELAY_RECONNECT_JITTER_MS = 250;

const SOCKET_OPEN = 1;

export type RelayWebSocket = {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send: (data: string | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
};

export type RelaySocketCallbacks = {
  onBeforeConnect: () => void;
  onMessage: (data: unknown) => void;
  onSocketClosed: () => void;
  onReconnectScheduled: (message: string) => void;
};

export type RelaySocketTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type RelaySocketDependencies = {
  createSocket?: (url: string) => RelayWebSocket;
  timers?: RelaySocketTimers;
  random?: () => number;
};

function createDefaultTimers(): RelaySocketTimers {
  return { setTimeout, clearTimeout, setInterval, clearInterval };
}

function createDefaultSocket(url: string): RelayWebSocket {
  return new WebSocket(url) as unknown as RelayWebSocket;
}

/** Owns only the raw relay socket, keepalive, and reconnect lifecycle. */
export class RelaySocket {
  private socket: RelayWebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private fatal = false;
  private reconnectAttempt = 0;

  private readonly createSocket: (url: string) => RelayWebSocket;
  private readonly timers: RelaySocketTimers;
  private readonly random: () => number;

  constructor(
    private readonly url: string,
    private readonly callbacks: RelaySocketCallbacks,
    dependencies: RelaySocketDependencies = {},
  ) {
    this.createSocket = dependencies.createSocket ?? createDefaultSocket;
    this.timers = dependencies.timers ?? createDefaultTimers();
    this.random = dependencies.random ?? Math.random;
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === SOCKET_OPEN) {
      socket.close(1000, 'backend-stopped');
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  send(data: string | ArrayBuffer): boolean {
    if (!this.isOpen() || this.socket === null) return false;
    this.socket.send(data);
    return true;
  }

  fail(message: string, fatal: boolean): void {
    this.fatal = this.fatal || fatal;
    const socket = this.socket;
    if (socket?.readyState === SOCKET_OPEN) {
      socket.close(fatal ? 1008 : 1011, fatal ? 'backend-error' : 'retry');
    } else if (!fatal) {
      this.scheduleReconnect(message);
    }
  }

  resetReconnectAttempt(): void {
    this.reconnectAttempt = 0;
  }

  private connect(): void {
    if (this.stopped || this.fatal) return;
    this.callbacks.onBeforeConnect();

    let socket: RelayWebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      this.scheduleReconnect(readError(error));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.startKeepalive();
    };
    socket.onmessage = event => {
      if (this.socket !== socket || event.data === RELAY_KEEPALIVE_PONG) return;
      this.callbacks.onMessage(event.data);
    };
    socket.onerror = () => {
      // React Native follows this with onclose; that event owns retry timing.
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopKeepalive();
      this.callbacks.onSocketClosed();
      if (!this.stopped && !this.fatal) {
        this.scheduleReconnect(
          event.reason || `Relay connection closed (${event.code}).`,
        );
      }
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = this.timers.setInterval(() => {
      if (this.socket?.readyState === SOCKET_OPEN) {
        this.socket.send(RELAY_KEEPALIVE_PING);
      }
    }, RELAY_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer === null) return;
    this.timers.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private scheduleReconnect(message: string): void {
    if (this.stopped || this.fatal || this.reconnectTimer !== null) return;
    this.callbacks.onReconnectScheduled(message);
    const exponential = Math.min(
      RELAY_RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 15),
      RELAY_RECONNECT_MAX_MS,
    );
    const delay = exponential + this.random() * RELAY_RECONNECT_JITTER_MS;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
