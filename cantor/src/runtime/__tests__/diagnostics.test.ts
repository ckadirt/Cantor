import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { createStore } from '../../core/store';
import {
  DIAGNOSTICS_KNOBS,
  diagnosticsReport,
  followFailures,
  recordFailure,
  redact,
  type Failure,
} from '../diagnostics';

const failure = (raw: string, atMs = 0) => ({
  code: 'queue_full',
  node: 'h100',
  sentence: 'h100 is busy.',
  raw,
  atMs,
});

describe('diagnostics', () => {
  it('keeps the last twenty, newest first, and no repeat of the newest', () => {
    const store = createStore<readonly Failure[]>([]);
    for (let index = 0; index < 25; index += 1)
      recordFailure(failure(`try ${index}`, index), store);
    recordFailure(failure('try 24', 99), store);
    const kept = store.get();
    expect(kept).toHaveLength(DIAGNOSTICS_KNOBS.KEEP);
    expect(kept[0].raw).toBe('try 24');
    expect(kept[kept.length - 1].raw).toBe('try 5');
  });

  it('never copies a key whole', () => {
    const key = 'Zm9vYmFyYmF6cXV4cXV1eGZvb2Jhcg';
    expect(redact(`pair failed for ${key}`)).not.toContain(key);
    expect(redact('short words stay')).toBe('short words stay');
    const report = diagnosticsReport([
      { ...failure(`token ${key}`), atMs: Date.UTC(2026, 9, 1) },
    ]);
    expect(report).toContain('queue_full | h100 | h100 is busy.');
    expect(report).not.toContain(key);
  });
});

describe('following the runtime', () => {
  it('records a new connection error and a newly failed job, not old ones', () => {
    const snapshot = (
      error: string | null,
      failed: string[],
      running: string[] = [],
    ): ConnectionSnapshot =>
      ({
        phase: 'ready',
        error,
        jobs: [
          ...failed.map(id => ({
            id,
            state: 'failed',
            error: {
              code: 'queue_full',
              message: `raw ${id}`,
              retryable: true,
            },
          })),
          ...running.map(id => ({ id, state: 'running' })),
        ],
        songs: [],
        libraryRevision: null,
        librarySyncing: false,
      } as unknown as ConnectionSnapshot);
    const runtime = createStore<{
      backends: BackendRecord[];
      snapshots: Record<string, ConnectionSnapshot>;
    }>({
      backends: [
        { nodePubkey: 'k', petname: 'h100', relayUrl: '', lastNodeInfo: null },
      ],
      snapshots: { k: snapshot('old', ['a']) },
    });
    const into = createStore<readonly Failure[]>([]);
    const stop = followFailures(runtime, into);
    runtime.set(state => ({
      ...state,
      // `c` arrives already failed (hydration): not news. `b` is running.
      snapshots: { k: snapshot('old', ['a', 'c'], ['b']) },
    }));
    expect(into.get()).toHaveLength(0);
    runtime.set(state => ({
      ...state,
      snapshots: { k: snapshot('socket closed', ['a', 'b', 'c']) },
    }));
    const codes = into.get().map(entry => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['connection', 'queue_full']));
    expect(into.get().find(f => f.code === 'queue_full')?.raw).toBe('raw b');
    expect(into.get().find(f => f.code === 'queue_full')?.node).toBe('h100');
    expect(into.get().filter(f => f.code === 'queue_full')).toHaveLength(1);
    stop();
  });
});
