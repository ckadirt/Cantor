import {
  RELAY_KEEPALIVE_INTERVAL_MS,
  RelaySocket,
  type RelaySocketCallbacks,
  type RelaySocketTimers,
  type RelayWebSocket,
} from '../relaySocket';

class FakeSocket implements RelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  remoteClose(code: number, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

type Harness = {
  lifecycle: RelaySocket;
  sockets: FakeSocket[];
  events: string[];
  messages: unknown[];
  timeoutDelays: number[];
};

function harness(
  options: { random?: number; throwOnCreate?: Error } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const messages: unknown[] = [];
  const timeoutDelays: number[] = [];
  const callbacks: RelaySocketCallbacks = {
    onBeforeConnect: () => events.push('before-connect'),
    onMessage: message => messages.push(message),
    onSocketClosed: () => events.push('socket-closed'),
    onReconnectScheduled: message => events.push(`reconnect:${message}`),
  };
  const timers: RelaySocketTimers = {
    setTimeout: ((callback: () => void, delay?: number) => {
      timeoutDelays.push(delay ?? 0);
      return setTimeout(callback, delay);
    }) as typeof setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const lifecycle = new RelaySocket('wss://relay.test/room', callbacks, {
    createSocket: url => {
      events.push('construct');
      if (options.throwOnCreate !== undefined) throw options.throwOnCreate;
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => options.random ?? 0,
  });
  return { lifecycle, sockets, events, messages, timeoutDelays };
}

describe('RelaySocket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs before-connect before construction and configures binary frames', () => {
    const subject = harness();

    subject.lifecycle.start();

    expect(subject.events).toEqual(['before-connect', 'construct']);
    expect(subject.sockets[0]).toMatchObject({
      url: 'wss://relay.test/room',
      binaryType: 'arraybuffer',
    });
  });

  it('owns the 25-second ping and consumes the pong', () => {
    const subject = harness();
    subject.lifecycle.start();
    const socket = subject.sockets[0];
    socket.open();

    jest.advanceTimersByTime(RELAY_KEEPALIVE_INTERVAL_MS - 1);
    expect(socket.sent).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(socket.sent).toEqual(['ping']);

    socket.receive('pong');
    socket.receive('application-frame');
    expect(subject.messages).toEqual(['application-frame']);

    jest.advanceTimersByTime(RELAY_KEEPALIVE_INTERVAL_MS);
    expect(socket.sent).toEqual(['ping', 'ping']);
  });

  it('guards every event and keepalive from a superseded socket', () => {
    const subject = harness();
    subject.lifecycle.start();
    const stale = subject.sockets[0];
    subject.lifecycle.start();
    const current = subject.sockets[1];

    stale.open();
    stale.receive('stale-message');
    stale.remoteClose(1006, 'stale-close');
    jest.advanceTimersByTime(60_000);

    expect(subject.messages).toEqual([]);
    expect(subject.events).toEqual([
      'before-connect',
      'construct',
      'before-connect',
      'construct',
    ]);
    expect(stale.sent).toEqual([]);

    current.open();
    jest.advanceTimersByTime(RELAY_KEEPALIVE_INTERVAL_MS);
    expect(current.sent).toEqual(['ping']);
  });

  it('reports constructor failure and retries with the exact first delay', () => {
    const subject = harness({
      random: 0.5,
      throwOnCreate: new Error('constructor failed'),
    });

    subject.lifecycle.start();

    expect(subject.events).toEqual([
      'before-connect',
      'construct',
      'reconnect:constructor failed',
    ]);
    expect(subject.timeoutDelays).toEqual([1_125]);

    jest.advanceTimersByTime(1_124);
    expect(subject.events).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(subject.events.slice(-3)).toEqual([
      'before-connect',
      'construct',
      'reconnect:constructor failed',
    ]);
    expect(subject.timeoutDelays).toEqual([1_125, 2_125]);
  });

  it('uses close reasons, the fallback text, and one reconnect timer', () => {
    const subject = harness();
    subject.lifecycle.start();
    subject.sockets[0].open();

    subject.sockets[0].remoteClose(1006, 'network changed');

    expect(subject.events.slice(-2)).toEqual([
      'socket-closed',
      'reconnect:network changed',
    ]);
    expect(subject.timeoutDelays).toEqual([1_000]);

    jest.advanceTimersByTime(1_000);
    subject.sockets[1].open();
    subject.sockets[1].remoteClose(1006);
    expect(subject.events.slice(-2)).toEqual([
      'socket-closed',
      'reconnect:Relay connection closed (1006).',
    ]);
    expect(subject.timeoutDelays).toEqual([1_000, 2_000]);
  });

  it('caps exponential retry at 30 seconds plus the injected jitter', () => {
    const subject = harness({ random: 0.5 });
    subject.lifecycle.start();

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const socket = subject.sockets.at(-1);
      if (socket === undefined) throw new Error('socket was not constructed');
      socket.open();
      socket.remoteClose(1006, 'retry');
      const delay = subject.timeoutDelays.at(-1);
      if (delay === undefined) throw new Error('retry was not scheduled');
      jest.advanceTimersByTime(delay);
    }

    expect(subject.timeoutDelays).toEqual([
      1_125, 2_125, 4_125, 8_125, 16_125, 30_125, 30_125,
    ]);
  });

  it('resets the reconnect backoff after application welcome', () => {
    const subject = harness({ random: 0.5 });
    subject.lifecycle.start();
    subject.sockets[0].open();
    subject.sockets[0].remoteClose(1006, 'first');
    jest.advanceTimersByTime(1_125);
    subject.sockets[1].open();
    subject.sockets[1].remoteClose(1006, 'second');
    jest.advanceTimersByTime(2_125);

    subject.lifecycle.resetReconnectAttempt();
    subject.sockets[2].open();
    subject.sockets[2].remoteClose(1006, 'after-welcome');

    expect(subject.timeoutDelays).toEqual([1_125, 2_125, 1_125]);
  });

  it('stops keepalive/reconnect and closes an open socket explicitly', () => {
    const subject = harness();
    subject.lifecycle.start();
    const socket = subject.sockets[0];
    socket.open();

    subject.lifecycle.stop();
    jest.advanceTimersByTime(60_000);
    subject.lifecycle.start();

    expect(socket.closes).toEqual([{ code: 1000, reason: 'backend-stopped' }]);
    expect(socket.sent).toEqual([]);
    expect(subject.sockets).toHaveLength(1);
    expect(subject.timeoutDelays).toEqual([]);
  });

  it('uses retry and backend-error close codes for nonfatal and fatal failure', () => {
    const transient = harness();
    transient.lifecycle.start();
    transient.sockets[0].open();
    transient.lifecycle.fail('transport failed', false);

    expect(transient.sockets[0].closes).toEqual([
      { code: 1011, reason: 'retry' },
    ]);
    expect(transient.events.slice(-2)).toEqual([
      'socket-closed',
      'reconnect:retry',
    ]);

    const fatal = harness();
    fatal.lifecycle.start();
    fatal.sockets[0].open();
    fatal.lifecycle.fail('identity changed', true);
    jest.advanceTimersByTime(60_000);

    expect(fatal.sockets[0].closes).toEqual([
      { code: 1008, reason: 'backend-error' },
    ]);
    expect(fatal.timeoutDelays).toEqual([]);
    fatal.lifecycle.start();
    expect(fatal.sockets).toHaveLength(1);
  });

  it('schedules the original failure when there is no open socket', () => {
    const subject = harness({ random: 0.5 });
    subject.lifecycle.start();

    subject.lifecycle.fail('relay is not open', false);

    expect(subject.events.at(-1)).toBe('reconnect:relay is not open');
    expect(subject.timeoutDelays).toEqual([1_125]);
  });

  it('sends only while the current socket is open', () => {
    const subject = harness();
    subject.lifecycle.start();
    const socket = subject.sockets[0];

    expect(subject.lifecycle.send('early')).toBe(false);
    socket.open();
    expect(subject.lifecycle.isOpen()).toBe(true);
    expect(subject.lifecycle.send('frame')).toBe(true);
    expect(socket.sent).toEqual(['frame']);
  });
});
