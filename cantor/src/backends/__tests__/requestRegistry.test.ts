import {
  RequestRegistry,
  ignoreResponse,
  rejectResponse,
  resolveResponse,
  type RequestSpec,
} from '../requestRegistry';

function ids(): (kind: string) => string {
  let sequence = 0;
  return kind => `${kind}-fixed-${++sequence}`;
}

function stringSpec(
  timeoutMessage = 'Request timed out.',
): RequestSpec<string> {
  return {
    expected: 'song.detail',
    decode: message =>
      typeof message === 'string'
        ? resolveResponse(message.toUpperCase())
        : ignoreResponse(),
    timeout: {
      afterMs: 15_000,
      error: () => new Error(timeoutMessage),
    },
  };
}

describe('RequestRegistry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the existing timestamp-and-sequence id format by default', () => {
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    const registry = new RequestRegistry();
    const first = registry.request('create', stringSpec());
    const second = registry.request('song', stringSpec());

    expect(first.id).toBe(`create-${Date.now()}-1`);
    expect(second.id).toBe(`song-${Date.now()}-2`);

    first.promise.catch(() => {});
    second.promise.catch(() => {});
    registry.clear('test complete');
  });

  it('atomically correlates, converts, resolves, and cancels the timeout', async () => {
    const registry = new RequestRegistry(ids());
    const request = registry.request('song-detail', stringSpec());

    expect(request.id).toBe('song-detail-fixed-1');
    expect(registry.expected(request.id)).toBe('song.detail');
    expect(registry.deliver(request.id, 'song.detail', 'decoded')).toBe(
      'resolved',
    );
    expect(registry.expected(request.id)).toBeUndefined();
    await expect(request.promise).resolves.toBe('DECODED');

    jest.advanceTimersByTime(15_000);
    await expect(request.promise).resolves.toBe('DECODED');
  });

  it('ignores stale ids and mismatched response kinds without decoding', async () => {
    const registry = new RequestRegistry(ids());
    const decode = jest.fn((message: unknown) => resolveResponse(message));
    const request = registry.request('create', {
      expected: 'job.accepted',
      decode,
    });

    expect(registry.deliver('stale-id', 'job.accepted', 'old')).toBe('stale');
    expect(registry.deliver(request.id, 'job.controlled', 'wrong')).toBe(
      'stale',
    );
    expect(decode).not.toHaveBeenCalled();
    expect(registry.expected(request.id)).toBe('job.accepted');

    expect(registry.deliver(request.id, 'job.accepted', 'current')).toBe(
      'resolved',
    );
    await expect(request.promise).resolves.toBe('current');
  });

  it('keeps an ignored malformed response pending until its exact timeout', async () => {
    const registry = new RequestRegistry(ids());
    const request = registry.request(
      'song-detail',
      stringSpec('Song detail timed out.'),
    );

    expect(registry.deliver(request.id, 'song.detail', { invalid: true })).toBe(
      'ignored',
    );
    expect(registry.expected(request.id)).toBe('song.detail');

    jest.advanceTimersByTime(14_999);
    expect(registry.expected(request.id)).toBe('song.detail');
    jest.advanceTimersByTime(1);
    expect(registry.expected(request.id)).toBeUndefined();
    await expect(request.promise).rejects.toThrow('Song detail timed out.');

    expect(registry.deliver(request.id, 'song.detail', 'late')).toBe('stale');
  });

  it('supports immediate conversion rejection and prevents a later timeout', async () => {
    const registry = new RequestRegistry(ids());
    const error = new Error('Node artifact chunk is invalid.');
    const request = registry.request('artifact-ack', {
      expected: 'artifact.part',
      decode: () => rejectResponse(error),
      timeout: {
        afterMs: 15_000,
        error: () =>
          new Error('Audio transfer timed out. It is safe to retry.'),
      },
    });

    expect(registry.deliver(request.id, 'artifact.part', {})).toBe('rejected');
    await expect(request.promise).rejects.toBe(error);
    jest.advanceTimersByTime(15_000);
    await expect(request.promise).rejects.toBe(error);
  });

  it('settles callback requests synchronously for automatic response handlers', () => {
    const registry = new RequestRegistry(ids());
    const resolved: string[] = [];
    const id = registry.register('library-page', stringSpec(), {
      resolve: value => resolved.push(value),
      reject: () => {},
    });

    expect(registry.deliver(id, 'song.detail', 'page')).toBe('resolved');
    expect(resolved).toEqual(['PAGE']);
  });

  it('runs automatic timeout cleanup after removing the correlation', () => {
    const registry = new RequestRegistry(ids());
    const observations: Array<string | undefined> = [];
    let id = '';
    id = registry.register(
      'library-sync',
      {
        expected: 'library.changes',
        decode: value => resolveResponse(value),
        timeout: {
          afterMs: 15_000,
          onTimeout: () => observations.push(registry.expected(id)),
        },
      },
      { resolve: () => {}, reject: () => {} },
    );

    jest.advanceTimersByTime(15_000);

    expect(observations).toEqual([undefined]);
  });

  it('rejects every promise and cancels every timer on disconnect cleanup', async () => {
    const registry = new RequestRegistry(ids());
    const first = registry.request('create', {
      ...stringSpec('first timeout'),
      expected: 'job.accepted',
    });
    const second = registry.request('song', {
      ...stringSpec('second timeout'),
      expected: 'song.updated',
    });

    registry.clear('Backend connection stopped.');

    expect(registry.expected(first.id)).toBeUndefined();
    expect(registry.expected(second.id)).toBeUndefined();
    await expect(first.promise).rejects.toThrow('Backend connection stopped.');
    await expect(second.promise).rejects.toThrow('Backend connection stopped.');

    jest.advanceTimersByTime(15_000);
    await expect(first.promise).rejects.toThrow('Backend connection stopped.');
    await expect(second.promise).rejects.toThrow('Backend connection stopped.');
  });

  it('can finish fire-and-forget correlations without invoking handlers', () => {
    const registry = new RequestRegistry(ids());
    const handlers = { resolve: jest.fn(), reject: jest.fn() };
    const id = registry.register('status', stringSpec(), handlers);

    expect(registry.finish(id)).toBe(true);
    expect(registry.finish(id)).toBe(false);
    jest.advanceTimersByTime(15_000);

    expect(handlers.resolve).not.toHaveBeenCalled();
    expect(handlers.reject).not.toHaveBeenCalled();
  });
});
