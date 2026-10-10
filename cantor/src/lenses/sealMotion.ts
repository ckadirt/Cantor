import { PointMode, StrokeCap, type SkCanvas, type SkPaint, type SkPoint } from '@shopify/react-native-skia';
import { smoothstep, smootherstep, type MotionFrame } from './motion/motionFrame';

/**
 * The seal in time with its song (reactive-player-plan.md, M5; the reference
 * page's `drawSeal(…, 'weave')`): **dots are sound, the thread is form.**
 *
 * The meter sounds on the seal's own levels — the bar on every dot, the beat
 * on the bead's ninth, the kick and the snare on the bead's cluster, a hat on
 * a few dots just ahead. A section heard before sounds again where it first
 * played, under a ghost bead. A drop gathers each ninth toward its centre and
 * lets it go. The form itself is never dot motion: it is the thread, where
 * entering a section writes its run on over a bar and every run with its
 * letter is drawn bold with it.
 *
 * Everything here is scaled by `amount` (the frame's presence times how far
 * the sound has risen), so at 0 the seal is exactly the still player.
 */

// knobs — the page's shipping values (reactive-player-plan.md, "The shipping numbers")
export const SEAL_MOTION_KNOBS = {
  /** The bar on every dot, the beat on the bead's ninth. */
  DOWN: 0.22,
  BEAT: 0.3,
  /** The kick swells the bead's cluster, the snare hollows it. */
  KICK: 0.65,
  SNARE: 0.9,
  /** A hat: this many dots within the next `HAT_REACH`, lifted and split, fading over `HAT_LIFE_S`. */
  HATS: 4,
  HAT_REACH: 40,
  HAT_LIFT: 0.9,
  HAT_SPLIT: 0.5,
  HAT_ATTACK_S: 0.015,
  HAT_LIFE_S: 0.45,
  /** A drop gathers each ninth toward its centre, at most this far; its release swells every dot. */
  GATHER: 0.45,
  GATHER_CAP: 0.7,
  RELEASE: 0.7,
  /** An echo's cluster takes the kick and the snare at these shares. */
  ECHO_KICK: 0.55,
  ECHO_SNARE: 0.75,
  /** A dot never grows past this share of its cell. */
  DOT_CAP: 0.72,
  /** The thread's runs: a letter's other runs at this weight; width and ink per weight. */
  SAME_LETTER: 0.8,
  RUN_WIDTH: 2.2,
  RUN_HEARD_FROM: 0.4,
  RUN_AHEAD: 0.5,
  /** The ghost bead's ink. */
  GHOST_ALPHA: 0.55,
  GHOST_STROKE_PX: 1,
} as const;

/**
 * What the music does to the seal this frame, per dot in time order: how much
 * bigger (`mul`, 1 is as measured), how much hollower and how much wider
 * (`hollow`, `split`, added to the slice's own punch and width), how far each
 * dot is gathered toward its ninth's centre (`pull`), and where the ghost
 * beads stand (`ghosts`, in dots along the thread).
 */
export type SealMotion = {
  amount: number;
  mul: number[];
  hollow: number[];
  split: number[];
  pull: number;
  ghosts: number[];
};

/**
 * The seal's motion at `frame`. `cluster[k]` and `ninth[k]` are the mark dot
 * and the depth-1 cell the `k`-th dot (in time order) belongs to; `head` is
 * the playhead in dots, or −1 for none.
 */
export function sealMotionOf(
  frame: MotionFrame,
  amount: number,
  cluster: readonly number[],
  ninth: readonly number[],
  head: number,
): SealMotion {
  'worklet';
  const K = SEAL_MOTION_KNOBS;
  const count = cluster.length;
  const m = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const g = frame.g * m;
  const mul: number[] = [];
  const hollow: number[] = [];
  const split: number[] = [];
  for (let k = 0; k < count; k++) {
    mul.push(1);
    hollow.push(0);
    split.push(0);
  }
  const ghosts: number[] = [];
  if (m <= 0 || count === 0) return { amount: 0, mul, hollow, split, pull: 0, ghosts };

  const tension = Math.max(frame.tension, frame.lift);
  const release = Math.max(frame.release, frame.lifted);
  const bar = g * K.DOWN * frame.down + g * K.RELEASE * release;
  const k0 = head < 0 ? -1 : Math.min(count - 1, Math.floor(head));
  const hereNinth = k0 < 0 ? -1 : ninth[k0];
  const hereCluster = k0 < 0 ? -1 : cluster[k0];
  for (let k = 0; k < count; k++) {
    let lift = bar;
    if (ninth[k] === hereNinth) lift += g * K.BEAT * frame.beat;
    if (cluster[k] === hereCluster) {
      lift += g * K.KICK * frame.low;
      hollow[k] += g * K.SNARE * frame.mid;
    }
    mul[k] += lift;
  }

  // Hats: single dots just ahead of the bead, the same ones for the same hat.
  if (k0 >= 0) {
    const hats = frame.hats;
    for (let i = 0; i < hats.length; i++) {
      const o = hats[i];
      const s =
        o.s *
        (o.age < 0 ? smoothstep(1 + o.age / K.HAT_ATTACK_S) : 1 - smootherstep(Math.max(0, o.age) / K.HAT_LIFE_S));
      if (s <= 0) continue;
      // The page's `mulberry32(index · 7919 + 13)`, inline: a worklet holds no closures.
      /* eslint-disable no-bitwise -- a hash is bit arithmetic, as in `face.ts`. */
      let state = (o.index * 7919 + 13) >>> 0;
      for (let j = 0; j < K.HATS; j++) {
        state = (state + 0x6d2b79f5) | 0;
        let r = Math.imul(state ^ (state >>> 15), 1 | state);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        const random = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        const k = Math.min(count - 1, k0 + 1 + Math.floor(random * K.HAT_REACH));
        mul[k] += g * K.HAT_LIFT * s;
        split[k] = Math.max(split[k], g * K.HAT_SPLIT * s);
      }
      /* eslint-enable no-bitwise */
    }
  }

  // Echoes: where this section first played, its cluster sounds too.
  if (frame.duration > 0) {
    for (let i = 0; i < frame.echoes.length; i++) {
      const at = Math.min(Math.max(frame.echoes[i] / frame.duration, 0), 1) * count;
      const echo = cluster[Math.min(count - 1, Math.floor(at))];
      for (let k = 0; k < count; k++) {
        if (cluster[k] !== echo) continue;
        mul[k] += g * K.ECHO_KICK * frame.low;
        hollow[k] += g * K.ECHO_SNARE * frame.mid;
      }
      ghosts.push(at);
    }
  }

  return {
    amount: m,
    mul,
    hollow,
    split,
    pull: Math.min(K.GATHER_CAP, K.GATHER * g * tension),
    ghosts,
  };
}

/** A dot's radius under the music: the measured one times `mul`, never past `DOT_CAP` of its cell. */
export function sealMotionRadius(measured: number, mul: number, cell: number): number {
  'worklet';
  if (mul === 1) return measured;
  return Math.min(cell * SEAL_MOTION_KNOBS.DOT_CAP, measured * mul);
}

/**
 * The form on the thread: each section's run weighted — the current one 1,
 * every run with its letter `SAME_LETTER`, the rest nothing — the weights
 * crossing over the section's first bar while its own run is written on, start
 * to end, so entering a section shows how long it is. Heard thread inked, the
 * thread ahead half. Over the seal's own quiet thread, under its dots.
 *
 * `xs`/`ys` are the dots' centres as the player draws them, in time order.
 * Each run is straight segments with round ends, which the GPU draws by
 * itself; its ink is mixed with the paper rather than laid on at an alpha, so
 * where two segments' ends overlap at a joint the ink does not double.
 */
export function drawSealWeave(
  canvas: SkCanvas,
  frame: MotionFrame,
  amount: number,
  count: number,
  head: number,
  xs: readonly number[],
  ys: readonly number[],
  stroke: SkPaint,
  paper: SkPaint,
  ink: number,
): void {
  'worklet';
  const K = SEAL_MOTION_KNOBS;
  const sections = frame.sections;
  const si = frame.section;
  if (amount <= 0 || ink <= 0 || si < 0 || frame.duration <= 0 || count < 2) return;
  const written = si > 0 ? smootherstep(frame.into / 4) : 1;
  const weightOf = (j: number, around: number): number => {
    if (around < 0) return 0;
    if (j === around) return 1;
    return sections[j].label === sections[around].label ? K.SAME_LETTER : 0;
  };
  /** The thread from dot `a` to dot `z`, fractional ends on its segments. */
  const run = (a: number, z: number): SkPoint[] => {
    const pointAt = (f: number) => {
      const i = Math.min(count - 1, Math.floor(f));
      const n = Math.min(count - 1, i + 1);
      const u = f - i;
      return { x: xs[i] + (xs[n] - xs[i]) * u, y: ys[i] + (ys[n] - ys[i]) * u } as SkPoint;
    };
    const points: SkPoint[] = [pointAt(a)];
    for (let k = Math.ceil(a); k < z; k++) points.push({ x: xs[k], y: ys[k] } as SkPoint);
    points.push(pointAt(z));
    return points;
  };
  const inkColour = stroke.getColor();
  const paperColour = paper.getColor();
  const r0 = inkColour[0];
  const g0 = inkColour[1];
  const b0 = inkColour[2];
  /** The ink at `alpha` over the paper, as one opaque colour. */
  const mixed = (alpha: number) => {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    stroke.setColor(
      Float32Array.of(
        paperColour[0] + (r0 - paperColour[0]) * a,
        paperColour[1] + (g0 - paperColour[1]) * a,
        paperColour[2] + (b0 - paperColour[2]) * a,
        1,
      ),
    );
  };
  const heard = head < 0 ? 0 : head;
  stroke.setStrokeCap(StrokeCap.Round);
  for (let j = 0; j < sections.length; j++) {
    const before = weightOf(j, si - 1);
    const w = (before + (weightOf(j, si) - before) * written) * amount;
    if (w <= 0.01) continue;
    const a = (sections[j].t0 / frame.duration) * count;
    const full = Math.min(count - 1, (sections[j].t1 / frame.duration) * count);
    const z = j === si ? a + (full - a) * written : full;
    if (z <= a) continue;
    stroke.setStrokeWidth(1 + K.RUN_WIDTH * w);
    const from = Math.max(a, heard);
    if (z > from) {
      mixed(ink * K.RUN_AHEAD * w);
      canvas.drawPoints(PointMode.Polygon, run(from, z), stroke);
    }
    const to = Math.min(z, heard);
    if (to > a) {
      mixed(ink * (K.RUN_HEARD_FROM + (1 - K.RUN_HEARD_FROM) * w) * amount);
      canvas.drawPoints(PointMode.Polygon, run(a, to), stroke);
    }
  }
  stroke.setStrokeCap(StrokeCap.Butt);
  stroke.setColor(inkColour);
}
