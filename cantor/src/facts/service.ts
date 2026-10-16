import { createStore, withEntry } from '../core/store';
import type { FactRepository } from './repository';
import type {
  Fact,
  FactKind,
  FactReason,
  FactProvider,
  FactReading,
  FactSource,
  FactSubject,
  Lookup,
} from './types';

/** KNOBS — how long an unreachable fact rests before it is asked again. */
export const FACT_KNOBS = {
  /**
   * One step per failure in a row, then the last for good: a service that is
   * down for a minute is asked again soon, one that is gone for a day is not
   * asked on every opening. LRCLIB's own `Retry-After` wins when it sends one.
   */
  BACKOFF_MS: [60_000, 600_000, 3_600_000],
} as const;

/** Every fact asked for this session, by `factKey`. */
export type FactsState = Readonly<Record<string, FactReading>>;

export function factKey(subject: string, kind: FactKind): string {
  return `${kind} ${subject}`;
}

/** What is known of one song's fact, or null when nobody has asked. */
export function readingOf(
  state: FactsState,
  subject: string,
  kind: FactKind,
): FactReading | null {
  return state[factKey(subject, kind)] ?? null;
}

export type Facts = Readonly<{
  store: ReturnType<typeof createStore<FactsState>>;
  /**
   * Make sure a fact is known: read what the phone remembers, and ask the
   * providers when it remembers nothing final and no retry time is ahead.
   */
  ensure: (subject: FactSubject, kind: FactKind) => Promise<void>;
  /** Ask again now, for an unreachable fact (TRY AGAIN). A final one stays. */
  retry: (subject: FactSubject, kind: FactKind) => Promise<void>;
  dispose: () => void;
}>;

/**
 * The song facts service (plan D10–D12d): providers fill a fact in order, the
 * first `found` wins, `none` passes to the next, and nothing found with any
 * provider unreachable is `unreachable` with a time to ask again. Each
 * provider runs one lookup at a time; one fact is looked up once at a time.
 *
 * The repository is optional in effect: if the phone database cannot be
 * opened, facts are still looked up and shown, only not remembered.
 */
export function createFacts(deps: {
  openRepository: () => Promise<FactRepository>;
  providers: Readonly<Record<FactKind, readonly FactProvider[]>>;
  now: () => number;
  onError?: (error: unknown) => void;
}): Facts {
  const store = createStore<FactsState>({});
  const abort = new AbortController();
  const report = (error: unknown) => deps.onError?.(error);
  let repository: Promise<FactRepository | null> | null = null;
  const remembered = () =>
    (repository ??= deps.openRepository().catch(error => {
      report(error);
      return null;
    }));
  const running = new Map<string, Promise<void>>();
  const lanes = new Map<FactSource, Promise<unknown>>();

  const inLane = <T>(source: FactSource, work: () => Promise<T>) => {
    const next = (lanes.get(source) ?? Promise.resolve()).then(work, work);
    lanes.set(
      source,
      next.catch(() => undefined),
    );
    return next;
  };

  const publish = (key: string, reading: FactReading) =>
    store.set(current => withEntry(current, key, reading));

  const lookUp = async (
    subject: FactSubject,
    kind: FactKind,
    previous: Fact | null,
  ): Promise<Fact> => {
    let unreachable: {
      source: FactSource;
      reason?: FactReason;
      retryAfterMs?: number;
    } | null = null;
    // The last provider asked knows most about why there is nothing.
    let noneReason: FactReason | null = null;
    for (const provider of deps.providers[kind]) {
      const answer: Lookup = await inLane(provider.source, () =>
        provider.lookup(subject, abort.signal),
      ).catch(error => {
        report(error);
        return { status: 'unreachable' } as const;
      });
      if (answer.status === 'found') {
        return {
          subject: subject.key,
          kind,
          status: 'found',
          value: answer.value,
          source: provider.source,
          reason: null,
          checkedAtMs: deps.now(),
          retryAtMs: null,
        };
      }
      if (answer.status === 'none' && answer.reason !== undefined) {
        noneReason = answer.reason;
      }
      if (answer.status === 'unreachable' && unreachable === null) {
        unreachable = {
          source: provider.source,
          reason: answer.reason,
          retryAfterMs: answer.retryAfterMs,
        };
      }
    }
    const checkedAtMs = deps.now();
    if (unreachable === null) {
      return {
        subject: subject.key,
        kind,
        status: 'none',
        value: null,
        source: null,
        reason: noneReason,
        checkedAtMs,
        retryAtMs: null,
      };
    }
    return {
      subject: subject.key,
      kind,
      status: 'unreachable',
      value: null,
      source: unreachable.source,
      reason: unreachable.reason ?? null,
      checkedAtMs,
      retryAtMs:
        checkedAtMs + (unreachable.retryAfterMs ?? nextBackoff(previous)),
    };
  };

  const run = (subject: FactSubject, kind: FactKind, now: boolean) => {
    const key = factKey(subject.key, kind);
    const already = running.get(key);
    if (already !== undefined) return already;
    const work = (async () => {
      const current = store.get()[key];
      let known =
        current !== undefined && current.status !== 'looking' ? current : null;
      if (known === null) {
        const repo = await remembered();
        known =
          (await repo?.get(subject.key, kind).catch(error => {
            report(error);
            return null;
          })) ?? null;
      }
      if (
        known !== null &&
        (known.status !== 'unreachable' ||
          (!now && (known.retryAtMs ?? 0) > deps.now()))
      ) {
        publish(key, known);
        return;
      }
      publish(key, { status: 'looking', previous: known });
      const fact = await lookUp(subject, kind, known);
      if (abort.signal.aborted) return;
      publish(key, fact);
      await (await remembered())?.put(fact).catch(report);
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  };

  return {
    store,
    ensure: (subject, kind) => run(subject, kind, false),
    retry: (subject, kind) => run(subject, kind, true),
    dispose: () => abort.abort(),
  };
}

/** The next rest after `previous`, one step longer than the last. */
function nextBackoff(previous: Fact | null): number {
  const steps = FACT_KNOBS.BACKOFF_MS;
  if (previous?.status !== 'unreachable' || previous.retryAtMs === null) {
    return steps[0];
  }
  const rested = previous.retryAtMs - previous.checkedAtMs;
  return steps.find(step => step > rested) ?? steps[steps.length - 1];
}
