import type { SampleWindow } from '../player';
import { LENS_INTERVALS, type Interval } from './cantorIntervals';

/** KNOBS */
const ANALYSIS_KNOBS = {
  MAX_CACHED_SONGS: 64, // enough for a shelf; bounded so a long session cannot grow without limit
} as const;

/**
 * What a lens draws a song from.
 *
 * `rms` and `peak` are one value per Cantor interval, already in 0..1. Lenses
 * receive this and nothing else: no buffers, no decoding, no file paths.
 */
export type SongAnalysis = Readonly<{
  rms: Float32Array;
  peak: Float32Array;
  /** False when no audio was available and the values are a neutral skeleton. */
  measured: boolean;
}>;

/**
 * Identity of one analysable artifact.
 *
 * The digest is part of it on purpose: a song whose delivery artifact is
 * replaced is a different sound, and must not be drawn from the old one's
 * analysis.
 */
export type AnalysisKey = Readonly<{
  nodePublicKey: string;
  songId: string;
  artifactDigest: string;
  resolution: number;
}>;

export function analysisCacheKey(key: AnalysisKey): string {
  return `${key.nodePublicKey}:${key.songId}:${key.artifactDigest}:${key.resolution}`;
}

/**
 * The shape a song draws before its audio is on the phone.
 *
 * Equal-height bars: the structure of the set with nothing claimed about the
 * sound. Cantor never downloads audio to decorate a mark, so most of a large
 * field is drawn from this.
 */
export function skeletonAnalysis(
  intervals: readonly Interval[] = LENS_INTERVALS,
): SongAnalysis {
  const rms = new Float32Array(intervals.length).fill(0.5);
  const peak = new Float32Array(intervals.length).fill(0.5);
  return { rms, peak, measured: false };
}

const SKELETON = skeletonAnalysis();

/** The neutral shape, shared. Callers must not mutate it. */
export function neutralAnalysis(): SongAnalysis {
  return SKELETON;
}

/**
 * Reduce a decoded window to one RMS and one peak per interval.
 *
 * The window is treated as the whole song: interval positions are fractions of
 * it. Channels are averaged, because a mark is one bar per interval and a
 * stereo image is not what this lens is showing.
 */
export function analyseWindow(
  window: SampleWindow,
  intervals: readonly Interval[] = LENS_INTERVALS,
): SongAnalysis {
  const buckets = window.buckets;
  const rms = new Float32Array(intervals.length);
  const peak = new Float32Array(intervals.length);
  if (buckets <= 0 || window.channels.length === 0) {
    return { ...skeletonAnalysis(intervals), measured: false };
  }

  for (let index = 0; index < intervals.length; index += 1) {
    const { start, end } = intervals[index];
    const from = Math.min(buckets - 1, Math.max(0, Math.floor(start * buckets)));
    const to = Math.min(buckets, Math.max(from + 1, Math.ceil(end * buckets)));

    let energy = 0;
    let loudest = 0;
    let counted = 0;
    for (const channel of window.channels) {
      for (let bucket = from; bucket < to; bucket += 1) {
        const value = channel.rms[bucket] ?? 0;
        energy += value * value;
        counted += 1;
        const extreme = Math.max(
          Math.abs(channel.max[bucket] ?? 0),
          Math.abs(channel.min[bucket] ?? 0),
        );
        if (extreme > loudest) loudest = extreme;
      }
    }
    rms[index] = counted === 0 ? 0 : clamp01(Math.sqrt(energy / counted));
    peak[index] = clamp01(loudest);
  }

  return { rms, peak, measured: true };
}

/**
 * Analysis already computed, keyed by artifact.
 *
 * Bounded and insertion-ordered: the oldest entry goes when the cache is full,
 * so browsing a large library cannot grow this without limit.
 */
export class AnalysisCache {
  private entries = new Map<string, SongAnalysis>();

  get(key: AnalysisKey): SongAnalysis | null {
    return this.entries.get(analysisCacheKey(key)) ?? null;
  }

  put(key: AnalysisKey, analysis: SongAnalysis): void {
    const id = analysisCacheKey(key);
    // Re-insert so recency is the map's own order.
    this.entries.delete(id);
    this.entries.set(id, analysis);
    while (this.entries.size > ANALYSIS_KNOBS.MAX_CACHED_SONGS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
