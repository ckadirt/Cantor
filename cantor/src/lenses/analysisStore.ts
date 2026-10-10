import { base64 } from '@scure/base';
import { createStore, type Store } from '../core/store';
import { analysisCacheKey, type SongAnalysis } from './analysis';

/** KNOBS */
export const ANALYSIS_STORE_KNOBS = {
  /** Measurements held in memory; a busy shelf fits, a whole library need not. */
  MAX_HELD: 256,
  /**
   * Rest between two background decodes.
   *
   * A decode reads the whole song and walks every sample on the JS thread:
   * about 1.5 s of a full core per song on the Xiaomi. Back to back, a shelf
   * held a core at 100% for its whole length. Resting as long as a decode
   * halves that, and a song being opened never waits for the rest.
   */
  BACKGROUND_GAP_MS: 1500,
  /** Stored measurements are one 16-bit step per value, 0..1. */
  QUANTUM: 65535,
} as const;

/** What it takes to find and measure one song's audio. */
export type AnalysisRef<Source = unknown> = Readonly<{
  /** The field's key for the song; what the published map is keyed by. */
  entityKey: string;
  nodePublicKey: string;
  songId: string;
  artifactDigest: string;
  resolution: number;
  /** Handed back to `measure` untouched: whatever it needs to decode. */
  source: Source;
}>;

/** Where measurements are kept between launches. */
export type AnalysisPersistence = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

type Priority = 'now' | 'soon';

type Pending<Source> = { ref: AnalysisRef<Source>; priority: Priority };

/** How one kind of measurement is keyed and kept: its storage key and its stored form. */
export type MeasurementCodec<Value> = Readonly<{
  /** The persisted key for an artifact: versioned, so a new measure re-measures rather than misreads. */
  key: (ref: AnalysisRef) => string;
  encode: (value: Value) => string;
  /** Null for anything it does not recognise, which is then measured again. */
  decode: (raw: string) => Value | null;
  /** Said when a song cannot be measured. */
  failure: string;
}>;

/**
 * Every song's measurement, once, for good.
 *
 * A measurement is read from disk when one was ever taken for that artifact,
 * and decoded otherwise — one song at a time, the one being opened first, the
 * rest of its shelf behind it with a rest between each. What it publishes is a
 * map from the field's song key to its value, which only ever changes when
 * a measurement lands.
 */
export class MeasurementStore<Value, Source = unknown> {
  readonly store: Store<ReadonlyMap<string, Value>> = createStore<
    ReadonlyMap<string, Value>
  >(new Map());
  /** Keyed by the codec's key: the artifact, not the placement. */
  private readonly pending = new Map<string, Pending<Source>>();
  private readonly reading = new Set<string>();
  private readonly failed = new Set<string>();
  /** Which artifact each published entity was measured from. */
  private readonly publishedFrom = new Map<string, string>();
  private working = false;
  private disposed = false;
  private rest: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly measure: (ref: AnalysisRef<Source>) => Promise<Value>,
    private readonly persistence: AnalysisPersistence,
    private readonly codec: MeasurementCodec<Value>,
    private readonly timers: Pick<
      typeof globalThis,
      'setTimeout' | 'clearTimeout'
    > = globalThis,
  ) {}

  /** Measure this song as soon as possible: it is the one being opened. */
  request(ref: AnalysisRef<Source>): void {
    this.enqueue(ref, 'now');
  }

  /**
   * Measure these in the background, replacing any earlier background list.
   *
   * The shelf you are in is the list; walking to another shelf is a new list,
   * and the songs of the one you left are not worth a decode any more.
   */
  prefetch(refs: readonly AnalysisRef<Source>[]): void {
    for (const [key, entry] of this.pending) {
      if (entry.priority === 'soon') this.pending.delete(key);
    }
    for (const ref of refs) this.enqueue(ref, 'soon');
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    if (this.rest !== null) this.timers.clearTimeout(this.rest);
  }

  private enqueue(ref: AnalysisRef<Source>, priority: Priority): void {
    if (this.disposed) return;
    const key = this.codec.key(ref);
    if (this.publishedFrom.get(ref.entityKey) === key) return;
    if (this.failed.has(key)) return;
    const queued = this.pending.get(key);
    if (queued !== undefined) {
      // Asked for now wins over asked for soon; re-inserting moves it last,
      // which is the front for `now` (newest first) — see `next`.
      if (priority === 'now') {
        this.pending.delete(key);
        this.pending.set(key, { ref, priority });
        this.pump();
      }
      return;
    }
    if (this.reading.has(key)) return;
    this.reading.add(key);
    // Disk first: cheap, and it runs beside a decode rather than behind it.
    this.persistence
      .getItem(key)
      .then(stored => {
        this.reading.delete(key);
        if (this.disposed) return;
        const analysis = stored === null ? null : this.codec.decode(stored);
        if (analysis !== null) {
          this.publish(ref.entityKey, key, analysis);
          return;
        }
        this.pending.set(key, { ref, priority });
        this.pump();
      })
      .catch(() => {
        this.reading.delete(key);
        if (this.disposed) return;
        this.pending.set(key, { ref, priority });
        this.pump();
      });
  }

  /** The next song to decode: the newest `now`, else the oldest `soon`. */
  private next(): [string, Pending<Source>] | null {
    let soon: [string, Pending<Source>] | null = null;
    let now: [string, Pending<Source>] | null = null;
    for (const entry of this.pending) {
      if (entry[1].priority === 'now') now = entry;
      else soon ??= entry;
    }
    return now ?? soon;
  }

  private pump(): void {
    if (this.working || this.disposed) return;
    const next = this.next();
    if (next === null) return;
    if (this.rest !== null) {
      // The rest is for the background; a song being opened does not wait.
      if (next[1].priority !== 'now') return;
      this.timers.clearTimeout(this.rest);
      this.rest = null;
    }
    const [key, { ref }] = next;
    this.pending.delete(key);
    this.working = true;
    this.measure(ref)
      .then(analysis => {
        if (this.disposed) return;
        this.publish(ref.entityKey, key, analysis);
        this.persistence.setItem(key, this.codec.encode(analysis)).catch(() => {
          // Losing the copy on disk costs a decode next launch, nothing more.
        });
      })
      .catch(error => {
        // A song we cannot measure keeps its skeleton, and is not retried this
        // session: a broken decoder would otherwise spin on it. Still worth
        // saying why, since a silent fallback and a broken decoder look alike.
        this.failed.add(key);
        console.warn(this.codec.failure, String(error));
      })
      .finally(() => {
        this.working = false;
        if (this.disposed) return;
        // What comes next decides: a song being opened goes at once, the
        // background waits out a rest.
        const following = this.next();
        if (following === null) return;
        if (following[1].priority === 'now') {
          this.pump();
          return;
        }
        this.rest = this.timers.setTimeout(() => {
          this.rest = null;
          this.pump();
        }, ANALYSIS_STORE_KNOBS.BACKGROUND_GAP_MS);
      });
  }

  private publish(entityKey: string, key: string, analysis: Value): void {
    this.publishedFrom.set(entityKey, key);
    this.store.set(current => {
      const next = new Map(current);
      // Re-inserted, so the map's own order is recency and the oldest go first.
      next.delete(entityKey);
      next.set(entityKey, analysis);
      while (next.size > ANALYSIS_STORE_KNOBS.MAX_HELD) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
        this.publishedFrom.delete(oldest);
      }
      return next;
    });
  }
}

/** Every song's lens analysis: the measurement lenses draw a song's sound from. */
export class AnalysisStore<Source = unknown> extends MeasurementStore<SongAnalysis, Source> {
  constructor(
    measure: (ref: AnalysisRef<Source>) => Promise<SongAnalysis>,
    persistence: AnalysisPersistence,
    timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>,
  ) {
    super(
      measure,
      persistence,
      {
        key: ref => analysisCacheKey(storeKeyOf(ref)),
        encode: encodeAnalysis,
        decode: decodeAnalysis,
        failure: 'lens analysis failed',
      },
      timers,
    );
  }
}

function storeKeyOf(ref: AnalysisRef): Parameters<typeof analysisCacheKey>[0] {
  return {
    nodePublicKey: ref.nodePublicKey,
    songId: ref.songId,
    artifactDigest: ref.artifactDigest,
    resolution: ref.resolution,
  };
}

/**
 * The stored form: version, then each array as 16-bit steps of 0..1, base64.
 *
 * Every value a measurement holds is already clamped to 0..1, so a 16-bit step
 * is a 65535th of the range — far below anything a lens can draw — at half the
 * size of the floats.
 */
type StoredAnalysis = {
  v: 1;
  measured: boolean;
  rms: string;
  peak: string;
  slices: { loudness: string; punch: string; width: string } | null;
};

export function encodeAnalysis(analysis: SongAnalysis): string {
  const stored: StoredAnalysis = {
    v: 1,
    measured: analysis.measured,
    rms: pack(analysis.rms),
    peak: pack(analysis.peak),
    slices:
      analysis.slices === null
        ? null
        : {
            loudness: pack(analysis.slices.loudness),
            punch: pack(analysis.slices.punch),
            width: pack(analysis.slices.width),
          },
  };
  return JSON.stringify(stored);
}

export function decodeAnalysis(raw: string): SongAnalysis | null {
  try {
    const stored = JSON.parse(raw) as StoredAnalysis;
    if (stored?.v !== 1) return null;
    return {
      rms: unpack(stored.rms),
      peak: unpack(stored.peak),
      measured: stored.measured === true,
      slices:
        stored.slices === null
          ? null
          : {
              loudness: unpack(stored.slices.loudness),
              punch: unpack(stored.slices.punch),
              width: unpack(stored.slices.width),
            },
    };
  } catch {
    return null;
  }
}

function pack(values: Float32Array): string {
  const steps = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const value = Math.min(Math.max(values[index], 0), 1);
    steps[index] = Math.round(value * ANALYSIS_STORE_KNOBS.QUANTUM);
  }
  return base64.encode(new Uint8Array(steps.buffer));
}

function unpack(encoded: string): Float32Array {
  // A copy, so the view starts on an even byte whatever the decoder returned.
  const bytes = base64.decode(encoded).slice();
  const steps = new Uint16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
  const values = new Float32Array(steps.length);
  for (let index = 0; index < steps.length; index++) {
    values[index] = steps[index] / ANALYSIS_STORE_KNOBS.QUANTUM;
  }
  return values;
}
