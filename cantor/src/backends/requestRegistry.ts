export type ExpectedResponse =
  | 'jobs.page'
  | 'job.accepted'
  | 'job.controlled'
  | 'job.forgotten'
  | 'library.page'
  | 'library.changes'
  | 'song.updated'
  | 'song.detail'
  | 'artifact.info'
  | 'artifact.part';

export type RequestDecodeResult<T> =
  | { kind: 'resolve'; value: T }
  | { kind: 'ignore' }
  | { kind: 'reject'; error: Error };

export type RequestTimeout = {
  readonly afterMs: number;
  readonly error?: () => Error;
  readonly onTimeout?: () => void;
};

export type RequestSpec<T> = {
  readonly expected: ExpectedResponse;
  readonly decode: (message: unknown) => RequestDecodeResult<T>;
  readonly timeout?: RequestTimeout;
};

export type RequestHandlers<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
};

export type RegisteredRequest<T> = {
  id: string;
  promise: Promise<T>;
};

export type DeliveryResult = 'resolved' | 'rejected' | 'ignored' | 'stale';

export type RequestIdFactory = (kind: string) => string;

type DecodedResponse =
  | { kind: 'resolve'; settle: () => void }
  | { kind: 'ignore' }
  | { kind: 'reject'; error: Error };

type PendingRequest = {
  expected: ExpectedResponse;
  decode: (message: unknown) => DecodedResponse;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

function defaultIdFactory(): RequestIdFactory {
  let sequence = 0;
  return kind => {
    sequence += 1;
    return `${kind}-${Date.now()}-${sequence}`;
  };
}

export function resolveResponse<T>(value: T): RequestDecodeResult<T> {
  return { kind: 'resolve', value };
}

export function ignoreResponse(): RequestDecodeResult<never> {
  return { kind: 'ignore' };
}

export function rejectResponse(error: Error): RequestDecodeResult<never> {
  return { kind: 'reject', error };
}

/**
 * Owns one request's correlation, conversion, settlement, and timer as a single
 * registration. A response with an unknown id or the wrong expected kind is
 * stale and cannot disturb the live request occupying another id.
 */
export class RequestRegistry {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly createId: RequestIdFactory = defaultIdFactory(),
  ) {}

  request<T>(kind: string, spec: RequestSpec<T>): RegisteredRequest<T> {
    let handlers: RequestHandlers<T> | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      handlers = { resolve, reject };
    });
    if (handlers === undefined) {
      throw new Error('Promise handlers were not initialized synchronously.');
    }
    const id = this.register(kind, spec, handlers);
    return { id, promise };
  }

  register<T>(
    kind: string,
    spec: RequestSpec<T>,
    handlers: RequestHandlers<T>,
  ): string {
    const id = this.createId(kind);
    if (this.pending.has(id)) {
      throw new Error(`Request id ${id} is already registered.`);
    }
    const { decode, expected, timeout } = spec;
    const { reject, resolve } = handlers;
    const pending: PendingRequest = {
      expected,
      decode: message => {
        const result = decode(message);
        if (result.kind === 'resolve') {
          return {
            kind: 'resolve',
            settle: () => resolve(result.value),
          };
        }
        return result;
      },
      reject,
    };
    if (timeout !== undefined) {
      pending.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        timeout.onTimeout?.();
        const error = timeout.error?.();
        if (error !== undefined) reject(error);
      }, timeout.afterMs);
    }
    this.pending.set(id, pending);
    return id;
  }

  expected(id: string): ExpectedResponse | undefined {
    return this.pending.get(id)?.expected;
  }

  deliver(
    id: string,
    expected: ExpectedResponse,
    message: unknown,
  ): DeliveryResult {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.expected !== expected) return 'stale';

    const decoded = pending.decode(message);
    if (decoded.kind === 'ignore') return 'ignored';

    this.finish(id);
    if (decoded.kind === 'reject') {
      pending.reject(decoded.error);
      return 'rejected';
    }
    decoded.settle();
    return 'resolved';
  }

  reject(id: string, error: Error): boolean {
    const pending = this.pending.get(id);
    if (pending === undefined) return false;
    this.finish(id);
    pending.reject(error);
    return true;
  }

  finish(id: string): boolean {
    const pending = this.pending.get(id);
    if (pending === undefined) return false;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(id);
    return true;
  }

  clear(message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(message));
    }
  }
}
