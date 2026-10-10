import type { MotionTrack } from '../motionTrack';

/**
 * The reference page's analysis of a fixture song
 * (`scripts/motion-reference.mjs`), and that analysis as a `MotionTrack`.
 */
export type Reference = {
  fps: number;
  F: number;
  bpm: number;
  face: { lobes: number };
  source: { duration: number };
  beats: [number, number, number][];
  onsets: [number, number, number][][];
  curves: { step: number; loud: number[]; sections: number[] };
  structure: null | {
    segments: { a: number; z: number; t0: number; t1: number; label: number; proto: number; loud: number; low: number }[];
    drops: { t: number; from: number; bar: number; strength: number }[];
  };
  probes: {
    t: number;
    g: number;
    low: number;
    mid: number;
    high: number;
    beat: number;
    down: number;
    loud: number;
    head: number;
    beatIndex: number;
    beatPhase: number;
    beatPeriod: number;
    structure: null | {
      seg: number;
      label: number;
      into: number;
      turn: number;
      echo: number | null;
      tension: number;
      release: number;
    };
  }[];
};

const REFERENCES: Record<string, Reference> = {
  'form-48k': require('./form-48k.motion.json'),
  'drone-48k': require('./drone-48k.motion.json'),
  'edm-drop': require('./edm-drop.motion.json'),
  violin: require('./violin.motion.json'),
  'short-20s': require('./short-20s.motion.json'),
};
export const FIXTURES = Object.keys(REFERENCES);

export function load(name: string): Reference {
  return REFERENCES[name];
}

export function trackOf(ref: Reference): MotionTrack {
  const step = ref.curves.step / ref.fps;
  return {
    version: 1,
    duration: ref.source.duration,
    fps: ref.fps,
    bpm: ref.bpm,
    // The page has no confidence; full, so its numbers are compared as they are.
    confidence: 1,
    beats: ref.beats.map(b => b[1]),
    downs: ref.beats.map(b => b[2]),
    onsets: ref.onsets.map(list => {
      const sorted = [...list].sort((x, y) => x[1] - y[1]);
      return { t: sorted.map(o => o[1]), s: sorted.map(o => o[2]) };
    }),
    sections: ref.structure ? ref.structure.segments.map(s => ({ ...s })) : [],
    drops: ref.structure ? ref.structure.drops : [],
    loud: ref.curves.loud,
    loudStep: step,
    intensity: ref.curves.sections,
    intensityStep: step,
  };
}

