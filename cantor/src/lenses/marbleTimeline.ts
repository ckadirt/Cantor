/**
 * Marbling's sound: the song's strokes in time, from its motion track — the
 * page's `timelineOf` (`docs/interfacealpha/lenses-four.html`, `MARBLE`).
 *
 * - **A drop on every bar**, at the playhead's place round the dial, sized by
 *   the bar's loudness and its kick, ink and clear water by turns, so the bars
 *   are laid down as bands.
 * - **A comb at every section start** after the first, over its first bar, in
 *   its letter's direction: a chorus that returns combs the same way.
 * - **A bullseye on a drop**: ink, then clear water inside it, pushing the
 *   whole song so far outward.
 *
 * Plain arrays and numbers, built once on the JS thread for the song the
 * camera is in. Each op carries the bath's extent when it starts, because its
 * size is a share of it: a song's later strokes are as big, on screen, as its
 * first.
 */

import { faceSeed, type FaceRecipe } from './face';
import type { MarbleDrop, MarbleOp } from './marble';
import { MARBLE_KNOBS } from './marble';
import { beatSureOf, motionFrameAt } from './motion/motionFrame';
import { MOTION_KNOBS } from './motion/motionFrame';
import type { MotionTrack } from './motion/motionTrack';

/** KNOBS — the page's numbers (the plan's "Things that must match"). */
export const MARBLE_TIMELINE_KNOBS = {
  /** A bar's drop: r = BAR_R · (BAR_LOUD + loud) · (1 + BAR_LOW · low). */
  BAR_R: 0.06,
  BAR_LOUD: 0.55,
  BAR_LOW: 0.6,
  /** Where it falls, from the centre, over the bath's extent. */
  BAR_AT: 0.64,
  /** How long it takes to land, seconds. */
  BAR_LANDS_S: 0.16,
  BAR_POINTS: 40,
  /** A comb: its pull and its reach, over the extent; it takes a bar. */
  COMB_Z: 0.32,
  COMB_LAMBDA: 0.16,
  /** Each letter's direction: a turn of frac(label · this + seed). */
  COMB_TURN: 0.618,
  /** A bullseye: r = BULL_R · ext · (BULL_BASE + strength), then clear water inside. */
  BULL_R: 0.2,
  BULL_BASE: 0.5,
  BULL_CLEAR: 0.7,
  BULL_CLEAR_AFTER_S: 0.05,
  BULL_LANDS_S: 0.4,
  /*
   * Not the page's: the edges (marbling-plan.md, M6).
   */
  /** Below this beat confidence, a drop every `AMBIENT_S` instead of every bar. */
  SURE_FROM: MOTION_KNOBS.SURE_FROM,
  AMBIENT_S: 2,
  /** Above this many bars, a drop every second bar: the bath and its cost stay bounded. */
  MAX_BARS: 160,
  /** A bar with no tempo to say how long it is. */
  BAR_FALLBACK_S: 2,
} as const;

/** One stroke in time: it starts at `t` and has landed `w` seconds later. */
export type MarbleTimedOp = Readonly<{
  op: MarbleOp;
  t: number;
  w: number;
  /** The bath's extent as it starts. */
  ext: number;
}>;

export type MarbleTimeline = Readonly<{
  ops: readonly MarbleTimedOp[];
  /** The identity's extent: its furthest point, where the bath starts. */
  ext0: number;
  /** The extent once every op has landed. */
  extEnd: number;
}>;

const frac = (x: number) => x - Math.floor(x);

/** Where a moment stands round the dial: twelve o'clock, clockwise. */
function dialAngle(u: number): number {
  return -Math.PI / 2 + u * Math.PI * 2;
}

/** A bar's loudness: the track's 80 ms loudness, averaged over the bar. */
function barLoudness(track: MotionTrack, t0: number, t1: number): number {
  const step = track.loudStep;
  const loud = track.loud;
  if (loud.length === 0 || step <= 0) return 0.5;
  const from = Math.max(0, Math.floor(t0 / step));
  const to = Math.min(loud.length - 1, Math.max(from, Math.ceil(t1 / step) - 1));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += loud[i];
  return sum / (to - from + 1);
}

type Event = Readonly<
  | { kind: 'bar'; t: number; t1: number; ink: boolean }
  | { kind: 'comb'; t: number; label: number }
  | { kind: 'drop'; t: number; strength: number }
>;

/** The bars a drop falls on: every downbeat, or a steady pulse where the grid is a guess. */
function barTimes(track: MotionTrack): number[] {
  const K = MARBLE_TIMELINE_KNOBS;
  const times: number[] = [];
  if (beatSureOf(track) > 0 && track.confidence >= K.SURE_FROM) {
    track.beats.forEach((t, i) => {
      if (track.downs[i] === 1) times.push(t);
    });
  }
  if (times.length < 2) {
    times.length = 0;
    for (let t = 0; t < track.duration; t += K.AMBIENT_S) times.push(t);
  }
  if (times.length > K.MAX_BARS) return times.filter((_, i) => i % 2 === 0);
  return times;
}

/**
 * The song's strokes, from its track. `ext0` is the identity's furthest
 * point (`MarbleIdentity.reach`), where the bath's extent starts.
 */
export function marbleTimeline(
  recipe: FaceRecipe,
  track: MotionTrack,
  ext0: number,
): MarbleTimeline {
  const K = MARBLE_TIMELINE_KNOBS;
  const duration = Math.max(1e-6, track.duration);
  const events: Event[] = [];
  const bars = barTimes(track);
  bars.forEach((t, i) => {
    const t1 = i + 1 < bars.length ? bars[i + 1] : Math.min(duration, t + K.BAR_FALLBACK_S);
    events.push({ kind: 'bar', t, t1, ink: i % 2 === 0 });
  });
  track.sections.forEach((section, i) => {
    if (i > 0) events.push({ kind: 'comb', t: section.t0, label: section.label });
  });
  for (const drop of track.drops) {
    events.push({ kind: 'drop', t: drop.t, strength: drop.strength });
  }
  // Stable: at one moment a bar's drop, then the comb, then the bullseye.
  events.sort((a, b) => a.t - b.t);

  const seedTurn = frac(faceSeed(recipe) / 2 ** 32);
  const bar = track.bpm > 0 ? 240 / track.bpm : K.BAR_FALLBACK_S;
  let ext2 = ext0 * ext0;
  const ops: MarbleTimedOp[] = [];
  for (const e of events) {
    const ext = Math.sqrt(ext2);
    if (e.kind === 'bar') {
      const a = dialAngle(e.t / duration);
      const loud = barLoudness(track, e.t, e.t1);
      const low = motionFrameAt(track, e.t).low;
      const r = K.BAR_R * (K.BAR_LOUD + loud) * (1 + K.BAR_LOW * low);
      const op: MarbleDrop = {
        kind: 'drop',
        x: Math.cos(a) * K.BAR_AT * ext,
        y: Math.sin(a) * K.BAR_AT * ext,
        r,
        ink: e.ink,
        points: K.BAR_POINTS,
      };
      ops.push({ op, t: e.t, w: K.BAR_LANDS_S, ext });
      ext2 += r * r;
    } else if (e.kind === 'comb') {
      const dir = Math.PI * 2 * frac(e.label * K.COMB_TURN + seedTurn);
      ops.push({
        op: {
          kind: 'tine',
          mx: Math.cos(dir),
          my: Math.sin(dir),
          off: 0,
          z: K.COMB_Z * ext,
          lambda: K.COMB_LAMBDA * ext,
        },
        t: e.t,
        w: bar,
        ext,
      });
    } else {
      const r = K.BULL_R * ext * (K.BULL_BASE + e.strength);
      const points = MARBLE_KNOBS.PLAYER_POINTS;
      ops.push({ op: { kind: 'drop', x: 0, y: 0, r, ink: true, points }, t: e.t, w: K.BULL_LANDS_S, ext });
      ext2 += r * r;
      const clear = r * K.BULL_CLEAR;
      ops.push({
        op: { kind: 'drop', x: 0, y: 0, r: clear, ink: false, points },
        t: e.t + K.BULL_CLEAR_AFTER_S,
        w: K.BULL_LANDS_S,
        ext,
      });
      ext2 += clear * clear;
    }
  }
  return { ops, ext0, extEnd: Math.sqrt(ext2) };
}

/** How far an op has landed at `t`, eased: the page's smootherstep. */
export function marbleLanded(op: MarbleTimedOp, t: number): number {
  'worklet';
  const x = (t - op.t) / op.w;
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * c * (c * (6 * c - 15) + 10);
}

/**
 * How many ops have *settled* by `t`: the longest run from the first in which
 * every one has finished landing. Ops overlap — a comb takes a bar, the bar's
 * own drop lands inside it — and they do not commute, so the settled bath is
 * always a prefix, and what is past it is still landing.
 */
export function marbleSettledAt(timeline: MarbleTimeline, t: number): number {
  'worklet';
  const ops = timeline.ops;
  let k = 0;
  while (k < ops.length && ops[k].t + ops[k].w <= t) k += 1;
  return k;
}

/**
 * The bath's extent at `t`: its area grows with every drop as it lands, so
 * the view zooms out continuously rather than a bar at a time.
 */
export function marbleExtAt(
  timeline: MarbleTimeline,
  t: number,
  settled: number = marbleSettledAt(timeline, t),
): number {
  'worklet';
  const ops = timeline.ops;
  if (settled >= ops.length) return timeline.extEnd;
  // Everything before `settled` has landed: the extent before it is its own.
  let ext2 = ops[settled].ext * ops[settled].ext;
  for (let i = settled; i < ops.length && ops[i].t <= t; i += 1) {
    const op = ops[i].op;
    if (op.kind === 'drop') ext2 += op.r * op.r * marbleLanded(ops[i], t);
  }
  return Math.sqrt(ext2);
}
