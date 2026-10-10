import { base64 } from '@scure/base';

/**
 * What moves a player in time with its song: the song's beats, onsets,
 * sections and drops, measured natively from the file the player plays
 * (`android/app/src/main/cpp/motion/`, a port of the reference page
 * docs/interfacealpha/reactive-player.html).
 *
 * Events, not curves: a worklet cannot hold a typed array, and a long plain
 * array is copied into every closure that reads it, so the frame is evaluated
 * from these lists (`motionFrame.ts`) rather than read from 100 fps arrays.
 * Plain arrays and objects throughout, so the whole track can sit in one
 * shared value.
 */
export type MotionSection = Readonly<{
  t0: number;
  t1: number;
  /** Same letter, same section: 0 is A. */
  label: number;
  /** Loudness on the song's own scale, ~0..1.2. */
  loud: number;
  low: number;
  /** First beat, by index into `beats`; `z` is one past the last. */
  a: number;
  z: number;
  /** The first section with this letter: where an echo sounds. */
  proto: number;
}>;

export type MotionDrop = Readonly<{
  /** Where it lands: a section's start. */
  t: number;
  /** Where the build begins, up to 16 beats before. */
  from: number;
  /** One bar at the song's tempo: the release. */
  bar: number;
  strength: number;
}>;

export type MotionTrack = Readonly<{
  version: 1;
  duration: number;
  /** Analysis hops per second: 100 at 44.1 and 48 kHz (`sampleRate / round(sampleRate / 100)`). */
  fps: number;
  bpm: number;
  /** How sure the beat grid is, 0..1; beat-locked gestures fade out below it. */
  confidence: number;
  /** Beat times, ascending. */
  beats: readonly number[];
  /** 1 where the beat at the same index is a downbeat. */
  downs: readonly number[];
  /** Low (kick, bass), mid (snare, voice) and high (hats, air) onsets: times and strengths. */
  onsets: readonly Readonly<{ t: readonly number[]; s: readonly number[] }>[];
  sections: readonly MotionSection[];
  drops: readonly MotionDrop[];
  /** Loudness over ~80 ms, 0..1, every `loudStep` seconds from 0. */
  loud: readonly number[];
  loudStep: number;
  /** Loudness over ~4 s, 0..1, every `sectionsStep` seconds from 0. */
  intensity: readonly number[];
  intensityStep: number;
}>;

/** What measuring cost, for the bench; not part of the track. */
export type MotionCost = Readonly<{
  sampleRate: number;
  decodeMs: number;
  featuresMs: number;
  songMs: number;
  peakBytes: number;
}>;

const HEADER = 20;

/**
 * Read the native module's answer: base64 of little-endian doubles, laid out
 * as `MotionTrackJni.cpp` describes. Throws on anything else.
 */
export function unpackMotionTrack(encoded: string): { track: MotionTrack; cost: MotionCost } {
  const bytes = base64.decode(encoded);
  if (bytes.byteLength % 8 !== 0 || bytes.byteLength < HEADER * 8) {
    throw new Error('The motion track is truncated.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength / 8;
  let at = 0;
  const next = () => {
    if (at >= count) throw new Error('The motion track is truncated.');
    return view.getFloat64(8 * at++, true);
  };
  const version = next();
  if (version !== 1) throw new Error(`Unknown motion track version ${version}.`);
  const sampleRate = next();
  const duration = next();
  const bpm = next();
  const confidence = next();
  next(); // periodicity: the confidence's input, for the bench
  const decodeMs = next();
  const featuresMs = next();
  const songMs = next();
  const peakBytes = next();
  const counts = [next(), next(), next(), next(), next(), next()];
  const loudStep = next();
  const loudCount = next();
  const intensityStep = next();
  const intensityCount = next();
  const [beatCount, low, mid, high, sectionCount, dropCount] = counts;

  const beats: number[] = [];
  const downs: number[] = [];
  for (let i = 0; i < beatCount; i++) {
    beats.push(next());
    downs.push(next());
  }
  const onsets = [low, mid, high].map(n => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++) pairs.push([next(), next()]);
    // Each onset is moved to the steepest rise near it, which can, rarely,
    // put one a hop before its predecessor; the frame searches by time.
    pairs.sort((x, y) => x[0] - y[0]);
    return { t: pairs.map(p => p[0]), s: pairs.map(p => p[1]) };
  });
  const sections: MotionSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    sections.push({
      t0: next(),
      t1: next(),
      label: next(),
      loud: next(),
      low: next(),
      a: next(),
      z: next(),
      proto: next(),
    });
  }
  const drops: MotionDrop[] = [];
  for (let i = 0; i < dropCount; i++) {
    drops.push({ t: next(), from: next(), bar: next(), strength: next() });
  }
  const loud: number[] = [];
  for (let i = 0; i < loudCount; i++) loud.push(next());
  const intensity: number[] = [];
  for (let i = 0; i < intensityCount; i++) intensity.push(next());
  if (at !== count) throw new Error('The motion track has trailing data.');

  return {
    track: {
      version: 1,
      duration,
      fps: sampleRate / Math.round(sampleRate / 100),
      bpm,
      confidence,
      beats,
      downs,
      onsets,
      sections,
      drops,
      loud,
      loudStep,
      intensity,
      intensityStep,
    },
    cost: { sampleRate, decodeMs, featuresMs, songMs, peakBytes },
  };
}
