import { createStore, type Store } from '../core/store';
import {
  describeConnection,
  describeError,
} from '../core/protocol/describeError';
import type { BackendRecord, ConnectionSnapshot } from '../backends/types';

/** KNOBS — what Diagnostics keeps. */
export const DIAGNOSTICS_KNOBS = {
  /** The last this many failures, newest first; older ones fall off. */
  KEEP: 20,
  /**
   * A run of key-like characters this long is redacted from a copy: public
   * keys, tokens and digests are base64 or hex, and a bug report never needs
   * them whole.
   */
  SECRET_RUN: 24,
} as const;

/** One failure as it happened, and as the screen said it. */
export type Failure = Readonly<{
  atMs: number;
  /** The protocol's `ErrorCode`, or what kind of failure the phone had. */
  code: string;
  /** The node it was about, by name. */
  node: string;
  /** The sentence the interface showed. */
  sentence: string;
  /** The raw message: never on screen except here, behind a tap. */
  raw: string;
}>;

/**
 * The last failures, in memory. Not persisted: a store key would be a new
 * storage contract, and a bug report is made while the trouble is fresh.
 */
export const diagnostics: Store<readonly Failure[]> = createStore<
  readonly Failure[]
>([]);

/** Keep a failure, newest first. A repeat of the newest one is not kept twice. */
export function recordFailure(
  failure: Omit<Failure, 'atMs'> & { atMs?: number },
  store: Store<readonly Failure[]> = diagnostics,
): void {
  const entry: Failure = { ...failure, atMs: failure.atMs ?? Date.now() };
  store.set(current => {
    const last = current[0];
    if (
      last !== undefined &&
      last.code === entry.code &&
      last.node === entry.node &&
      last.raw === entry.raw
    )
      return current;
    return [entry, ...current].slice(0, DIAGNOSTICS_KNOBS.KEEP);
  });
}

/** What a thrown value calls itself: its code if it has one, its kind if not. */
export function codeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  )
    return (error as { code: string }).code;
  return 'phone';
}

/** The raw message of anything thrown. */
export function rawOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Anything key-like taken out: long runs of base64 or hex. Recovery words
 * never reach a failure — they are read only by the recovery row — so there
 * is nothing of theirs to take out.
 */
export function redact(text: string): string {
  const run = DIAGNOSTICS_KNOBS.SECRET_RUN;
  return text.replace(
    new RegExp(`[A-Za-z0-9+/=_-]{${run},}`, 'g'),
    match => `${match.slice(0, 4)}…[${match.length}]`,
  );
}

/** Every failure as plain text for a bug report, newest first. */
export function diagnosticsReport(failures: readonly Failure[]): string {
  if (failures.length === 0) return 'Cantor diagnostics: nothing went wrong.';
  const lines = failures.map(failure =>
    [
      new Date(failure.atMs).toISOString(),
      failure.code,
      failure.node,
      failure.sentence,
      redact(failure.raw),
    ].join(' | '),
  );
  return ['Cantor diagnostics, newest first', ...lines].join('\n');
}

/** What `followFailures` reads of the runtime: its nodes and their snapshots. */
type FollowedState = Readonly<{
  backends: readonly BackendRecord[] | null;
  snapshots: Readonly<Record<string, ConnectionSnapshot>>;
}>;

function nameIn(state: FollowedState, nodePublicKey: string): string {
  const backend = state.backends?.find(
    candidate => candidate.nodePubkey === nodePublicKey,
  );
  return backend?.petname || backend?.lastNodeInfo?.name || 'a node';
}

/**
 * Record the failures that arrive as state rather than as a throw: a node's
 * connection error when it changes, and a job seen turning failed. What was
 * already failed when first seen is not news, so it is not recorded.
 */
export function followFailures(
  store: Pick<Store<FollowedState>, 'get' | 'subscribe'>,
  into: Store<readonly Failure[]> = diagnostics,
): () => void {
  const errors = new Map<string, string | null>();
  const states = new Map<string, string>();
  const read = (state: FollowedState, record: boolean) => {
    for (const [key, snapshot] of Object.entries(state.snapshots)) {
      const node = nameIn(state, key);
      const before = errors.get(key) ?? null;
      if (record && snapshot.error !== null && snapshot.error !== before) {
        recordFailure(
          {
            code: 'connection',
            node,
            sentence: describeConnection(snapshot.error, node).sentence,
            raw: snapshot.error,
          },
          into,
        );
      }
      errors.set(key, snapshot.error);
      for (const job of snapshot.jobs) {
        const id = `${key}:${job.id}`;
        const before = states.get(id);
        states.set(id, job.state);
        // Only a job seen turning failed is news. One that is already failed
        // the first time it is seen failed before now — while the app was
        // closed, or before the runtime had hydrated — and its sheet says so.
        if (
          !record ||
          job.state !== 'failed' ||
          job.error === undefined ||
          before === undefined ||
          before === 'failed'
        )
          continue;
        recordFailure(
          {
            code: job.error.code,
            node,
            sentence: describeError(job.error.code, node, job.error.retryable)
              .sentence,
            raw: job.error.message,
          },
          into,
        );
      }
    }
  };
  read(store.get(), false);
  return store.subscribe(() => read(store.get(), true));
}
