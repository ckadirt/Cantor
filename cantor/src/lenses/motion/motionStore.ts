import { base64 } from '@scure/base';
import {
  MeasurementStore,
  type AnalysisPersistence,
  type AnalysisRef,
} from '../analysisStore';
import type { MotionDrop, MotionSection, MotionTrack } from './motionTrack';

/**
 * Every played song's motion track, measured once per artifact, for good.
 *
 * Its own storage namespace with the version in the key (`motion.v1:…`):
 * storage keys and their encodings are compatibility contracts, and a change to
 * the analysis must re-measure rather than misread. Keyed by artifact digest,
 * so a replaced artifact is measured again.
 */
export class MotionStore<Source = unknown> extends MeasurementStore<MotionTrack, Source> {
  constructor(
    measure: (ref: AnalysisRef<Source>) => Promise<MotionTrack>,
    persistence: AnalysisPersistence,
    timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>,
  ) {
    super(
      measure,
      persistence,
      {
        key: motionKey,
        encode: encodeMotionTrack,
        decode: decodeMotionTrack,
        failure: 'motion track failed',
      },
      timers,
    );
  }
}

export function motionKey(ref: Pick<AnalysisRef, 'nodePublicKey' | 'songId' | 'artifactDigest'>): string {
  return `motion.v1:${ref.nodePublicKey}:${ref.songId}:${ref.artifactDigest}`;
}

/**
 * The stored form, v1.
 *
 * Beats and onsets sit on the analysis's hops, so they are stored as hop
 * indices, delta-coded as unsigned LEB128 — lossless and about a byte each.
 * Strengths and the two loudness curves are 8-bit steps of 0..1, which no
 * drawing can tell from the floats. A section's times are its first beat's
 * (or the song's end), as the analysis made them, so only its beat indices
 * are kept. Measured: ~15 KB of JSON for a 4-minute song.
 */
type StoredMotion = {
  v: 1;
  fps: number;
  duration: number;
  bpm: number;
  confidence: number;
  beats: string;
  downs: string;
  onsets: { f: string; s: string }[];
  /** a, z, label, proto, loud, low */
  sections: [number, number, number, number, number, number][];
  /** t, from, bar, strength */
  drops: [number, number, number, number][];
  loud: string;
  loudStep: number;
  intensity: string;
  intensityStep: number;
};

export function encodeMotionTrack(track: MotionTrack): string {
  const hops = (times: readonly number[]) => times.map(t => Math.round(t * track.fps));
  const round = (x: number) => Number(x.toPrecision(7));
  const stored: StoredMotion = {
    v: 1,
    fps: track.fps,
    duration: track.duration,
    bpm: round(track.bpm),
    confidence: round(track.confidence),
    beats: deltas(hops(track.beats)),
    downs: base64.encode(Uint8Array.from(track.downs)),
    onsets: track.onsets.map(band => ({ f: deltas(hops(band.t)), s: bytes(band.s) })),
    sections: track.sections.map(s => [s.a, s.z, s.label, s.proto, round(s.loud), round(s.low)]),
    drops: track.drops.map(d => [round(d.t), round(d.from), round(d.bar), round(d.strength)]),
    loud: bytes(track.loud),
    loudStep: track.loudStep,
    intensity: bytes(track.intensity),
    intensityStep: track.intensityStep,
  };
  return JSON.stringify(stored);
}

export function decodeMotionTrack(raw: string): MotionTrack | null {
  try {
    const stored = JSON.parse(raw) as StoredMotion;
    if (stored?.v !== 1) return null;
    const fps = stored.fps;
    const beats = undeltas(stored.beats).map(f => f / fps);
    const timeOf = (b: number) => (b < beats.length ? beats[b] : stored.duration);
    const sections: MotionSection[] = stored.sections.map(([a, z, label, proto, loud, low]) => ({
      t0: timeOf(a),
      t1: timeOf(z),
      label,
      loud,
      low,
      a,
      z,
      proto,
    }));
    const drops: MotionDrop[] = stored.drops.map(([t, from, bar, strength]) => ({ t, from, bar, strength }));
    return {
      version: 1,
      duration: stored.duration,
      fps,
      bpm: stored.bpm,
      confidence: stored.confidence,
      beats,
      downs: Array.from(base64.decode(stored.downs)),
      onsets: stored.onsets.map(band => ({ t: undeltas(band.f).map(f => f / fps), s: unbytes(band.s) })),
      sections,
      drops,
      loud: unbytes(stored.loud),
      loudStep: stored.loudStep,
      intensity: unbytes(stored.intensity),
      intensityStep: stored.intensityStep,
    };
  } catch {
    return null;
  }
}

/** Ascending integers as unsigned LEB128 deltas, base64. */
function deltas(values: readonly number[]): string {
  const out: number[] = [];
  let last = 0;
  for (const value of values) {
    let d = Math.max(0, value - last);
    last = value;
    do {
      const byte = d & 0x7f;
      d = Math.floor(d / 128);
      out.push(d > 0 ? byte | 0x80 : byte);
    } while (d > 0);
  }
  return base64.encode(Uint8Array.from(out));
}

function undeltas(encoded: string): number[] {
  const data = base64.decode(encoded);
  const out: number[] = [];
  let last = 0;
  let value = 0;
  let scale = 1;
  for (const byte of data) {
    value += (byte & 0x7f) * scale;
    if (byte & 0x80) {
      scale *= 128;
      continue;
    }
    last += value;
    out.push(last);
    value = 0;
    scale = 1;
  }
  return out;
}

function bytes(values: readonly number[]): string {
  return base64.encode(Uint8Array.from(values, v => Math.round(Math.min(Math.max(v, 0), 1) * 255)));
}

function unbytes(encoded: string): number[] {
  return Array.from(base64.decode(encoded), b => b / 255);
}
