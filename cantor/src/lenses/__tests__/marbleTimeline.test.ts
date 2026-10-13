import { faceSeed, type FaceRecipe } from '../face';
import { marbleIdentity } from '../marble';
import {
  MARBLE_TIMELINE_KNOBS,
  marbleExtAt,
  marbleLanded,
  marbleSettledAt,
  marbleTimeline,
} from '../marbleTimeline';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { beatSureOf, motionFrameAt } from '../motion/motionFrame';
import type { MotionTrack } from '../motion/motionTrack';

const RECIPE: FaceRecipe = { seed: 20261011, id: 'cantor', model: 'ace-step', durationMs: 262_000 };
const ext0 = marbleIdentity(RECIPE).reach;

/** The track's loudness averaged over [t0, t1): the one input the app reads its own way. */
function loudOver(track: MotionTrack, t0: number, t1: number): number {
  const from = Math.max(0, Math.floor(t0 / track.loudStep));
  const to = Math.min(track.loud.length - 1, Math.max(from, Math.ceil(t1 / track.loudStep) - 1));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += track.loud[i];
  return sum / (to - from + 1);
}

/*
 * The page's `timelineOf`, verbatim but for its sources: `song.beats`, the
 * structure and `env.low` are the track's (`motionFrame`'s envelope is the
 * page's, checked in its own test), and `soundAt(u).loud` — the analysis
 * buckets, which the app's marbling does not read — is the bar's mean
 * loudness from the track.
 */
function pageTimeline(track: MotionTrack, rec: FaceRecipe, e0: number) {
  const TAU = Math.PI * 2;
  const frac = (x: number) => x - Math.floor(x);
  const ang = (u: number) => -Math.PI / 2 + u * TAU;
  const dur = track.duration;
  const events: any[] = [];
  const downs = track.beats.filter((_, i) => track.downs[i] === 1);
  let bars = 0;
  downs.forEach((t, i) => events.push({ t, t1: downs[i + 1] ?? Math.min(dur, t + 2), kind: 'beat', down: bars++ % 2 === 0 }));
  track.sections.forEach((seg, i) => { if (i) events.push({ t: seg.t0, kind: 'comb', label: seg.label }); });
  for (const d of track.drops) events.push({ t: d.t, kind: 'drop', strength: d.strength });
  events.sort((a, b) => a.t - b.t);
  const seedTurn = frac(faceSeed(rec) / 2 ** 32), bar = 240 / track.bpm;
  let ext2 = e0 * e0; const ops: any[] = [];
  for (const e of events) {
    const ext = Math.sqrt(ext2);
    if (e.kind === 'beat') {
      const u = e.t / dur, a = ang(u), low = motionFrameAt(track, e.t).low;
      const r = 0.06 * (0.55 + loudOver(track, e.t, e.t1)) * (1 + 0.6 * low);
      ops.push({ drop: true, x: Math.cos(a) * 0.64 * ext, y: Math.sin(a) * 0.64 * ext, r, ink: e.down, pts: 40, t: e.t, w: 0.16, ext });
      ext2 += r * r;
    } else if (e.kind === 'comb') {
      ops.push({ tine: true, dir: TAU * frac(e.label * 0.618 + seedTurn), off: 0, z: 0.32 * ext, lam: 0.16 * ext, t: e.t, w: bar, ext });
    } else {
      const r = 0.2 * ext * (0.5 + e.strength);
      ops.push({ drop: true, x: 0, y: 0, r, ink: true, pts: 120, t: e.t, w: 0.4, ext }); ext2 += r * r;
      ops.push({ drop: true, x: 0, y: 0, r: r * 0.7, ink: false, pts: 120, t: e.t + 0.05, w: 0.4, ext }); ext2 += r * r * 0.49;
    }
  }
  return ops;
}

describe("marbling's timeline", () => {
  it.each(['edm-drop', 'form-48k', 'violin'])("is the page's for %s", name => {
    const track = trackOf(load(name));
    expect(track.confidence).toBeGreaterThanOrEqual(MARBLE_TIMELINE_KNOBS.SURE_FROM);
    const page = pageTimeline(track, RECIPE, ext0);
    const ours = marbleTimeline(RECIPE, track, ext0);
    expect(ours.ops).toHaveLength(page.length);
    page.forEach((p, i) => {
      const o = ours.ops[i];
      expect(o.t).toBeCloseTo(p.t, 9);
      expect(o.w).toBeCloseTo(p.w, 9);
      expect(o.ext).toBeCloseTo(p.ext, 6);
      if (p.drop) {
        expect(o.op.kind).toBe('drop');
        if (o.op.kind !== 'drop') return;
        expect(o.op.x).toBeCloseTo(p.x, 6);
        expect(o.op.y).toBeCloseTo(p.y, 6);
        expect(o.op.r).toBeCloseTo(p.r, 6);
        expect(o.op.ink).toBe(p.ink);
      } else {
        expect(o.op.kind).toBe('tine');
        if (o.op.kind !== 'tine') return;
        expect(o.op.mx).toBeCloseTo(Math.cos(p.dir), 9);
        expect(o.op.my).toBeCloseTo(Math.sin(p.dir), 9);
        expect(o.op.z).toBeCloseTo(p.z, 6);
        expect(o.op.lambda).toBeCloseTo(p.lam, 6);
      }
    });
  });

  it('combs a returning letter the same way', () => {
    const track = trackOf(load('form-48k'));
    const ours = marbleTimeline(RECIPE, track, ext0);
    const byLabel = new Map<number, number>();
    for (const o of ours.ops) {
      if (o.op.kind !== 'tine') continue;
      const label = track.sections.find(s => Math.abs(s.t0 - o.t) < 1e-9)!.label;
      const seen = byLabel.get(label);
      if (seen !== undefined) expect(o.op.mx).toBeCloseTo(seen, 12);
      byLabel.set(label, o.op.mx);
    }
    expect(byLabel.size).toBeGreaterThan(1);
  });

  it('drops on a steady pulse where there is no beat to trust', () => {
    const track = trackOf(load('drone-48k'));
    const sure = beatSureOf(track) > 0 && track.confidence >= MARBLE_TIMELINE_KNOBS.SURE_FROM;
    const ours = marbleTimeline(RECIPE, track, ext0);
    const drops = ours.ops.filter(o => o.op.kind === 'drop' && o.w === MARBLE_TIMELINE_KNOBS.BAR_LANDS_S);
    if (!sure) {
      expect(drops.length).toBe(Math.ceil(track.duration / MARBLE_TIMELINE_KNOBS.AMBIENT_S));
      expect(drops[1].t - drops[0].t).toBeCloseTo(MARBLE_TIMELINE_KNOBS.AMBIENT_S, 9);
    } else {
      expect(drops.length).toBeGreaterThan(10);
    }
  });

  it('never combs a song too short to have a form', () => {
    const track = trackOf(load('short-20s'));
    const ours = marbleTimeline(RECIPE, track, ext0);
    expect(ours.ops.some(o => o.op.kind === 'tine')).toBe(track.sections.length > 1);
    expect(ours.ops.length).toBeGreaterThan(3);
  });

  it('drops every second bar in a very long song', () => {
    const base = trackOf(load('edm-drop'));
    // The song four times over: far more bars than the bath may hold.
    const n = base.beats.length;
    const beats: number[] = [];
    const downs: number[] = [];
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < n; i++) {
        beats.push(base.beats[i] + k * base.duration);
        downs.push(base.downs[i]);
      }
    }
    const long: MotionTrack = { ...base, duration: base.duration * 4, beats, downs, sections: [], drops: [] };
    const bars = downs.filter(d => d === 1).length;
    expect(bars).toBeGreaterThan(MARBLE_TIMELINE_KNOBS.MAX_BARS);
    const ours = marbleTimeline(RECIPE, long, ext0);
    expect(ours.ops).toHaveLength(Math.ceil(bars / 2));
  });

  it('settles a prefix, and grows its extent continuously', () => {
    const track = trackOf(load('edm-drop'));
    const tl = marbleTimeline(RECIPE, track, ext0);
    expect(marbleSettledAt(tl, 0)).toBe(0);
    expect(marbleSettledAt(tl, track.duration + 10)).toBe(tl.ops.length);
    expect(marbleExtAt(tl, 0)).toBeCloseTo(ext0, 12);
    expect(marbleExtAt(tl, track.duration + 10)).toBeCloseTo(tl.extEnd, 12);
    // The prefix sum and a full sum agree, and the extent never shrinks.
    let last = 0;
    let worst = 0;
    let prefix = true;
    for (let t = 0; t < track.duration; t += 0.173) {
      let ext2 = ext0 * ext0;
      for (const o of tl.ops) if (o.op.kind === 'drop' && o.t <= t) ext2 += o.op.r * o.op.r * marbleLanded(o, t);
      const ext = marbleExtAt(tl, t);
      worst = Math.max(worst, Math.abs(ext - Math.sqrt(ext2)));
      if (ext < last - 1e-12) prefix = false;
      last = ext;
      const k = marbleSettledAt(tl, t);
      for (let i = 0; i < k; i++) if (tl.ops[i].t + tl.ops[i].w > t) prefix = false;
      if (k < tl.ops.length && tl.ops[k].t + tl.ops[k].w <= t) prefix = false;
    }
    expect(worst).toBeLessThan(1e-9);
    expect(prefix).toBe(true);
  });
});
