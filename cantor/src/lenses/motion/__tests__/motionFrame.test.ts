import { motionFrameAt, smootherstep } from '../motionFrame';
import type { MotionTrack } from '../motionTrack';

/**
 * The frame against the reference page's own numbers.
 *
 * Each fixture is the page's analysis of a song (`scripts/motion-reference.mjs`)
 * with probes: `features()`, `beatAt()` and `structureAt()` at fixed times.
 * The track is built from the page's events, so what is tested here is the
 * frame — the port of the page's per-moment evaluation — not the analysis,
 * which `scripts/motion-check.mjs` holds against the page natively.
 */
type Reference = {
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
  'form-48k': require('../__fixtures__/form-48k.motion.json'),
  'drone-48k': require('../__fixtures__/drone-48k.motion.json'),
  'edm-drop': require('../__fixtures__/edm-drop.motion.json'),
  violin: require('../__fixtures__/violin.motion.json'),
  'short-20s': require('../__fixtures__/short-20s.motion.json'),
};
const FIXTURES = Object.keys(REFERENCES);

function load(name: string): Reference {
  return REFERENCES[name];
}

function trackOf(ref: Reference): MotionTrack {
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

/**
 * The circle's section pose from the frame: the page's `structureAt().turn`,
 * which the circle lens will compute from these numbers and its face's lobes.
 */
function poseOf(frame: ReturnType<typeof motionFrameAt>, lobes: number): number {
  const step = (Math.PI * 2) / (lobes * 8);
  const eased = (x: number) => Math.floor(x) + smootherstep((x - Math.floor(x)) / 0.35);
  const turnOf = (label: number, x: number) => label * ((Math.PI * 2) / (lobes * 3)) + (eased(x) / 4) * step * 2;
  let turn = turnOf(frame.label, frame.into);
  if (frame.prevLabel >= 0 && frame.into < 4) {
    const a = smootherstep(frame.into / 4);
    const from = turnOf(frame.prevLabel, frame.prevLength);
    const whole = Math.round((turnOf(frame.label, 0) - from) / (Math.PI * 2)) * Math.PI * 2;
    turn = from + (turn - whole - from) * a;
  }
  return turn;
}

describe.each(FIXTURES)('the frame of %s', name => {
  const ref = load(name);
  const track = trackOf(ref);

  it('has the page’s envelopes, beat and form at every probe', () => {
    for (const p of ref.probes) {
      const f = motionFrameAt(track, p.t);
      const at = `t=${p.t}`;
      expect([at, f.low]).toEqual([at, expect.closeTo(p.low, 5)]);
      expect([at, f.mid]).toEqual([at, expect.closeTo(p.mid, 5)]);
      expect([at, f.high]).toEqual([at, expect.closeTo(p.high, 5)]);
      expect([at, f.beat]).toEqual([at, expect.closeTo(p.beat, 5)]);
      expect([at, f.down]).toEqual([at, expect.closeTo(p.down, 5)]);
      expect([at, f.head]).toEqual([at, expect.closeTo(p.head, 5)]);
      expect([at, f.beatIndex]).toEqual([at, p.beatIndex]);
      expect([at, f.beatPhase]).toEqual([at, expect.closeTo(p.beatPhase, 4)]);
      expect([at, f.beatPeriod]).toEqual([at, expect.closeTo(p.beatPeriod, 4)]);
      if (p.structure === null) {
        expect([at, f.section]).toEqual([at, -1]);
        continue;
      }
      const s = p.structure;
      expect([at, f.section, f.label]).toEqual([at, s.seg, s.label]);
      expect([at, f.into]).toEqual([at, expect.closeTo(s.into, 4)]);
      expect([at, f.tension]).toEqual([at, expect.closeTo(s.tension, 5)]);
      expect([at, f.release]).toEqual([at, expect.closeTo(s.release, 5)]);
      // The page's `structureAt().echo` is the first run of this letter only;
      // the frame carries every earlier run (the shipping seal, 'weave',
      // sounds them all), which is the same when the page has one.
      if (s.echo !== null) expect([at, f.echoes[0]]).toEqual([at, expect.closeTo(s.echo, 4)]);
      expect([at, poseOf(f, ref.face.lobes)]).toEqual([at, expect.closeTo(s.turn, 4)]);
    }
  });

  it('reads the loudness curves at their samples, and the intensity between them', () => {
    // The page reads both curves 100 times a second; these fixtures carry
    // every 10th value (the app's track: 20 and 4 a second). The frame must
    // read a sample exactly where one is. Between samples the 4 s intensity
    // barely moves; the 80 ms loudness can move a third of its range, which
    // is a sampling choice for the phone (log, M3), not a port error.
    const step = ref.curves.step / ref.fps;
    ref.curves.loud.forEach((v, k) => {
      if (k % 7 !== 0) return;
      expect(motionFrameAt(track, k * step).loud).toBeCloseTo(v, 5);
    });
    for (const p of ref.probes) expect(Math.abs(motionFrameAt(track, p.t).g - p.g)).toBeLessThan(0.02);
  });
});

describe('what the frame adds to the page', () => {
  const track = trackOf(load('edm-drop'));
  const t = track.beats[40] + 0.01;

  it('lets the transients settle on a pause and keeps the form', () => {
    const on = motionFrameAt(track, t, 1);
    const off = motionFrameAt(track, t, 0);
    expect(on.low + on.beat).toBeGreaterThan(0);
    expect([off.low, off.mid, off.high, off.beat, off.down]).toEqual([0, 0, 0, 0, 0]);
    expect(off.ripples).toEqual([]);
    expect(off.hats).toEqual([]);
    expect([off.section, off.label, off.into, off.tension]).toEqual([on.section, on.label, on.into, on.tension]);
  });

  it('turns beat-locked motion off for a grid it is not sure of, and keeps the onsets', () => {
    const sure = motionFrameAt(track, t);
    const unsure = motionFrameAt({ ...track, confidence: 0.1 }, t);
    expect(sure.beat).toBeGreaterThan(0);
    expect(unsure.beat).toBe(0);
    expect(unsure.down).toBe(0);
    expect(unsure.low).toBe(sure.low);
    expect(unsure.beatSure).toBe(0);
  });

  it('carries every earlier run of a repeated section, up to four', () => {
    const sections = track.sections;
    const repeat = sections.findIndex((s, i) => sections.slice(0, i).some(o => o.label === s.label));
    expect(repeat).toBeGreaterThan(0);
    const f = motionFrameAt(track, sections[repeat].t0 + 0.5);
    const earlier = sections.slice(0, repeat).filter(s => s.label === sections[repeat].label);
    expect(f.echoes.length).toBe(Math.min(4, earlier.length));
    f.echoes.forEach((e, i) => expect(e).toBeGreaterThanOrEqual(earlier[i].t0));
  });
});
