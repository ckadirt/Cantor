/* eslint-disable no-bitwise -- a ring is pairs of numbers; halving a length is a shift. */

import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import type { PlayerPaints } from './contract';

/**
 * Marbling's morphs: one drawing becoming another, ring by ring.
 *
 * The motion engine's silhouette morph (`motion/silhouette.ts`), on the UI
 * thread: both drawings as compound rings, paired, resampled to one count per
 * pair, aligned by the rotation that travels least, built once, and lerped
 * per frame — each ring through a window of its own, so a ring with no partner
 * is gone before the end rather than lingering as a speck. A ring with no
 * partner grows from a point, or shrinks to one, where it stands. Nothing is
 * faded over anything: the ink itself moves from one shape to the other.
 *
 * **Winding, not even-odd.** Both drawings are even-odd at rest, but mid-morph
 * rings cross, and under even-odd two inks crossing make paper — the morph
 * churned in ink and paper patches. So every ring is wound by its depth (an
 * ink ring one way, a hole inside it the other), which at rest fills exactly
 * as even-odd does, and the morph is filled nonzero: ink over ink stays ink.
 * Pairs prefer a partner of the same role, ink with ink, hole with hole, so a
 * ring is never turned inside out on the way.
 *
 * Its ends are not quite either lens's own drawing — a bath's thinnest bands,
 * marbling's live ink, the seal's sound-sized dots — so each end dissolves
 * into the real drawing while the morph has barely moved (`morphShares`).
 */

/** KNOBS — the morph. */
export const MARBLE_MORPH_KNOBS = {
  /** How long each end dissolves between the real drawing and the morph, of the clock. */
  HAND_OVER: 0.22,
  /** About how far apart a ring's points stand, px. */
  SEG_PX: 5,
  /** Points per ring, at least and at most; a stroke (the cover's) needs fewer. */
  MIN_POINTS: 8,
  MIN_LINE_POINTS: 4,
  MAX_POINTS: 320,
  /** The most points a morph holds, all rings together: its cost per frame. */
  BUDGET: 6000,
  /** Rings smaller than this, px², shrink to a point rather than pair (strokes always pair). */
  MIN_AREA_PX2: 2,
  /** How much of the clock a ring with no partner takes to go, or to come. */
  ALONE_WINDOW: 0.85,
  /** What pairing an ink ring with a hole costs, against size and distance. */
  ROLE_COST: 3,
  /** How many of the rings left each ring looks at for a partner. */
  LOOK: 24,
  /** Points along a curve when a path is read as rings. */
  CURVE_STEPS: 4,
} as const;

/** A drawing as rings in px about the player's centre, interleaved x, y. */
export type MorphSide = Readonly<{
  rings: readonly (readonly number[])[];
  /** Each ring's alpha (the seal's dots still to come are grey), or one for all. */
  alpha: readonly number[] | number;
  /**
   * How deep each ring is nested among the others: an even ring is ink, an
   * odd one a hole in it. All 0 when absent (the seal's dots, the cover's
   * strokes).
   */
  depth?: readonly number[];
  /**
   * Each ring's identity across moments of one bath (its place in the order
   * the rings fell): rings with the same id on both sides are the same ink.
   */
  ids?: readonly number[];
  /**
   * Whether this side is strokes, not filled shapes (the cover): drawn as
   * hairlines at its own end of the morph, and filled toward the other.
   */
  lines?: boolean;
  /**
   * Each ring's place in time (the seal's dots, in their thread's order), so
   * its alpha follows the playhead when the morph is drawn rather than when it
   * was built: heard in ink, still to come grey. −1 or absent: `alpha` holds.
   */
  order?: readonly number[];
  /**
   * A ring kept as it is, never resampled — its partner is resampled to it —
   * so the drawing can hand the morph that ring's points live each frame (the
   * circle's face, singing). Index into `rings`; only on the `from` side.
   */
  fixed?: number;
}>;

/**
 * A built morph: every ring's points at both ends, interleaved x, y, in one
 * pair of arrays, with where each ring starts, its window of the clock and its
 * alpha at both ends.
 */
export type MarbleMorph = Readonly<{
  /*
   * Typed arrays: a morph built on the bath's runtime crosses to the JS and
   * the UI thread as one copied buffer each, where thousands of boxed numbers
   * took most of a bake's round trip on the phone.
   */
  from: Float32Array;
  to: Float32Array;
  /** Ring `i` is points `starts[i]` up to `starts[i + 1]`. */
  starts: Int32Array;
  w0: Float32Array;
  w1: Float32Array;
  aFrom: Float32Array;
  aTo: Float32Array;
  /** Where in `from.rings` each ring came from, or -1 for one grown from a point. */
  fromRing: Int32Array;
  /** Each ring's place in time on the `from` side (`MorphSide.order`), or −1. */
  fromOrder: Int32Array;
  /** Each side's ink as fill (1) or as hairlines (0). */
  fillFrom: number;
  fillTo: number;
}>;

function signedArea(r: readonly number[]): number {
  'worklet';
  let twice = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    twice += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  }
  return twice / 2;
}

function ringLength(r: readonly number[]): number {
  'worklet';
  let length = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    length += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]);
  }
  return length;
}

function ringCentre(r: readonly number[]): [number, number] {
  'worklet';
  let x = 0;
  let y = 0;
  const n = r.length >> 1;
  for (let i = 0; i < n; i++) {
    x += r[2 * i];
    y += r[2 * i + 1];
  }
  return [x / Math.max(1, n), y / Math.max(1, n)];
}

/** The ring the other way round. */
function reversed(r: readonly number[]): number[] {
  'worklet';
  const out: number[] = [];
  for (let i = (r.length >> 1) - 1; i >= 0; i--) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}

/** A closed ring resampled to `n` points evenly along its length. */
export function resampleRing(r: readonly number[], n: number): number[] {
  'worklet';
  const m = r.length >> 1;
  const out: number[] = [];
  if (m === 0) {
    for (let i = 0; i < n; i++) out.push(0, 0);
    return out;
  }
  const total = ringLength(r);
  if (total <= 0 || m === 1) {
    for (let i = 0; i < n; i++) out.push(r[0], r[1]);
    return out;
  }
  const step = total / n;
  let seg = 0;
  let segStart = 0;
  let ax = r[0];
  let ay = r[1];
  let bx = r[2 % (2 * m)];
  let by = r[3 % (2 * m)];
  let segLength = Math.hypot(bx - ax, by - ay);
  for (let i = 0; i < n; i++) {
    const at = i * step;
    while (segStart + segLength < at && seg < m - 1) {
      segStart += segLength;
      seg += 1;
      ax = r[2 * seg];
      ay = r[2 * seg + 1];
      const next = (seg + 1) % m;
      bx = r[2 * next];
      by = r[2 * next + 1];
      segLength = Math.hypot(bx - ax, by - ay);
    }
    const f = segLength > 0 ? Math.min(1, Math.max(0, (at - segStart) / segLength)) : 0;
    out.push(ax + (bx - ax) * f, ay + (by - ay) * f);
  }
  return out;
}

/**
 * `b` turned to correspond with `a` (both `n` points) with the least total
 * travel — the engine's `alignSampled`, rotations only: both rings are already
 * wound the way their role asks, and reversing one would turn it inside out.
 * Long rings try every fourth rotation, then the three either side of the best.
 */
export function alignRing(a: readonly number[], b: readonly number[]): number[] {
  'worklet';
  const n = a.length >> 1;
  if (n === 0) return b.slice();
  const score = (k: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (k + i) % n;
      const dx = a[2 * i] - b[2 * j];
      const dy = a[2 * i + 1] - b[2 * j + 1];
      s += dx * dx + dy * dy;
    }
    return s;
  };
  const stride = n > 64 ? 4 : 1;
  let best = Infinity;
  let bestK = 0;
  for (let k = 0; k < n; k += stride) {
    const s = score(k);
    if (s < best) {
      best = s;
      bestK = k;
    }
  }
  if (stride > 1) {
    const around = bestK;
    for (let d = -stride + 1; d < stride; d++) {
      const k = (around + d + n) % n;
      const s = score(k);
      if (s < best) {
        best = s;
        bestK = k;
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (bestK + i) % n;
    out.push(b[2 * j], b[2 * j + 1]);
  }
  return out;
}

function alphaOf(side: MorphSide, index: number): number {
  'worklet';
  return typeof side.alpha === 'number' ? side.alpha : side.alpha[index] ?? 1;
}

/**
 * Pair two drawings' rings and build the points between them, once.
 *
 * Rings that are the same ink at two moments (`MorphSide.ids`: one bath at
 * two places in a song) pair with each other, so a band slides back to where
 * it was and a bar not yet fallen un-falls. The rest pair largest first, each
 * taking the partner nearest it in size and place and of its own role, so ink
 * flows to the shape beside it rather than across the disc. A ring left with
 * no partner flows into (or out of) the nearest shape on the other side,
 * shrinking to a point as it gets there.
 */
export function buildMarbleMorph(from: MorphSide, to: MorphSide, reach: number): MarbleMorph {
  'worklet';
  const K = MARBLE_MORPH_KNOBS;
  const order = (side: MorphSide) =>
    side.rings
      .map((ring, index) => {
        const role = (side.depth === undefined ? 0 : side.depth[index] ?? 0) & 1;
        // Wound by role: ink anticlockwise in the drawing's own sense, holes the other way.
        const area = signedArea(ring);
        const wound = (area >= 0) === (role === 0) ? ring.slice() : reversed(ring);
        const id = side.ids === undefined ? -1 : side.ids[index] ?? -1;
        return { ring: wound, index, role, id, area: Math.abs(area), centre: ringCentre(ring) };
      })
      .filter(entry => entry.ring.length >= 4)
      .sort((x, y) => y.area - x.area);
  const a = order(from);
  const b = order(to);
  const small = (entry: { area: number }, side: MorphSide) =>
    side.lines !== true && entry.area < K.MIN_AREA_PX2;
  const taken = new Array<boolean>(b.length).fill(false);
  type Pair = {
    a: number[] | null;
    b: number[] | null;
    aAlpha: number;
    bAlpha: number;
    want: number;
    fromRing: number;
    order: number;
    /** Where a ring with no partner goes to, or comes from. */
    toward: [number, number] | null;
  };
  const pairs: Pair[] = [];
  // The same ink at two moments: by id, when both sides are one bath.
  const sameBath = from.ids !== undefined && to.ids !== undefined;
  const byId = new Map<number, number>();
  if (sameBath) {
    b.forEach((entry, j) => {
      if (entry.id >= 0) byId.set(entry.id, j);
    });
  }
  const nearestCentre = (x: number, y: number, side: { centre: [number, number] }[]): [number, number] => {
    let best: [number, number] = [x, y];
    let far = Infinity;
    for (const entry of side) {
      const d = (entry.centre[0] - x) ** 2 + (entry.centre[1] - y) ** 2;
      if (d < far) {
        far = d;
        best = entry.centre;
      }
    }
    return best;
  };
  let next = 0;
  for (const entry of a) {
    let pick = entry.id >= 0 ? byId.get(entry.id) ?? -1 : -1;
    if (pick >= 0 && taken[pick]) pick = -1;
    if (pick < 0 && !sameBath && !small(entry, from)) {
      let best = Infinity;
      let looked = 0;
      while (next < b.length && taken[next]) next += 1;
      for (let j = next; j < b.length && looked < K.LOOK; j++) {
        if (taken[j] || small(b[j], to)) continue;
        looked += 1;
        const size = Math.abs(Math.log((b[j].area + 1) / (entry.area + 1)));
        const far = Math.hypot(b[j].centre[0] - entry.centre[0], b[j].centre[1] - entry.centre[1]) / reach;
        const cost = size + 2 * far + (b[j].role === entry.role ? 0 : K.ROLE_COST);
        if (cost < best) {
          best = cost;
          pick = j;
        }
      }
    }
    const length = Math.max(ringLength(entry.ring), pick >= 0 ? ringLength(b[pick].ring) : 0);
    if (pick >= 0) taken[pick] = true;
    pairs.push({
      a: entry.ring,
      b: pick >= 0 ? b[pick].ring : null,
      aAlpha: alphaOf(from, entry.index),
      bAlpha: pick >= 0 ? alphaOf(to, b[pick].index) : alphaOf(from, entry.index),
      want: length / K.SEG_PX,
      fromRing: entry.index,
      order: from.order === undefined ? -1 : from.order[entry.index] ?? -1,
      toward: pick >= 0 ? null : nearestCentre(entry.centre[0], entry.centre[1], b),
    });
  }
  for (let j = 0; j < b.length; j++) {
    if (taken[j]) continue;
    pairs.push({
      a: null,
      b: b[j].ring,
      aAlpha: alphaOf(to, b[j].index),
      bAlpha: alphaOf(to, b[j].index),
      want: ringLength(b[j].ring) / K.SEG_PX,
      fromRing: -1,
      order: -1,
      toward: nearestCentre(b[j].centre[0], b[j].centre[1], a),
    });
  }
  // Points per pair, by length, within the budget; a ring that is only
  // shrinking away or growing in needs fewer than one you watch travel.
  const least = from.lines === true || to.lines === true ? K.MIN_LINE_POINTS : K.MIN_POINTS;
  const wantOf = (pair: Pair) =>
    Math.max(least, Math.min(K.MAX_POINTS, pair.a !== null && pair.b !== null ? pair.want : pair.want / 2));
  let wanted = 0;
  for (const pair of pairs) wanted += wantOf(pair);
  const squeeze = wanted > K.BUDGET ? K.BUDGET / wanted : 1;
  const point = (x: number, y: number, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(x, y);
    return out;
  };
  const morph = {
    from: [] as number[],
    to: [] as number[],
    starts: [] as number[],
    w0: [] as number[],
    w1: [] as number[],
    aFrom: [] as number[],
    aTo: [] as number[],
    fromRing: [] as number[],
    fromOrder: [] as number[],
    fillFrom: from.lines === true ? 0 : 1,
    fillTo: to.lines === true ? 0 : 1,
  };
  for (const pair of pairs) {
    const fixed = pair.a !== null && from.fixed !== undefined && pair.fromRing === from.fixed;
    const n = fixed ? pair.a!.length >> 1 : Math.max(least, Math.round(wantOf(pair) * squeeze));
    const ra = fixed ? pair.a! : pair.a !== null ? resampleRing(pair.a, n) : point(pair.toward![0], pair.toward![1], n);
    let rb = pair.b !== null ? resampleRing(pair.b, n) : point(pair.toward![0], pair.toward![1], n);
    if (pair.a !== null && pair.b !== null) rb = alignRing(ra, rb);
    morph.starts.push(morph.from.length);
    for (let i = 0; i < ra.length; i++) {
      morph.from.push(ra[i]);
      morph.to.push(rb[i]);
    }
    // Alone: gone over most of the clock, or come over most of it, travelling as it does.
    morph.w0.push(pair.a === null ? 1 - K.ALONE_WINDOW : 0);
    morph.w1.push(pair.b === null ? K.ALONE_WINDOW : 1);
    morph.aFrom.push(pair.aAlpha);
    morph.aTo.push(pair.bAlpha);
    morph.fromRing.push(pair.fromRing);
    morph.fromOrder.push(pair.order);
  }
  morph.starts.push(morph.from.length);
  return {
    from: Float32Array.from(morph.from),
    to: Float32Array.from(morph.to),
    starts: Int32Array.from(morph.starts),
    w0: Float32Array.from(morph.w0),
    w1: Float32Array.from(morph.w1),
    aFrom: Float32Array.from(morph.aFrom),
    aTo: Float32Array.from(morph.aTo),
    fromRing: Int32Array.from(morph.fromRing),
    fromOrder: Int32Array.from(morph.fromOrder),
    fillFrom: morph.fillFrom,
    fillTo: morph.fillTo,
  };
}

/**
 * How much of each layer is drawn at `t`: the leaving lens's own drawing,
 * the arriving lens's, and the morph between them.
 *
 * The morph is a lighter drawing than either end — a bath's thin bands are
 * thousands of points, far more than a frame can redraw — so each end
 * dissolves into it while it has barely moved, rather than being covered by
 * it: covered, the bath's stripes filled in at once. Two versions of one still
 * shape, not two shapes moving, so it reads as detail settling, not a ghost.
 */
export function morphShares(t: number): { from: number; to: number; morph: number } {
  'worklet';
  const h = MARBLE_MORPH_KNOBS.HAND_OVER;
  const ss = (x: number) => {
    const c = x < 0 ? 0 : x > 1 ? 1 : x;
    return c * c * (3 - 2 * c);
  };
  const into = ss(t / h);
  const out = ss((t - (1 - h)) / h);
  return {
    from: 1 - into,
    to: out,
    morph: t <= 0 || t >= 1 ? 0 : into * (1 - out),
  };
}

/**
 * The morph at `t` (0..1, linear), in the ink at `alpha`: each ring eased
 * through its own window, one nonzero path per alpha it stands at — filled,
 * or stroked at a hairline where a side is strokes (the cover), the one
 * becoming the other on the same moving rings.
 */
export function drawMarbleMorphPaths(
  canvas: SkCanvas,
  morph: MarbleMorph,
  t: number,
  alpha: number,
  paints: PlayerPaints,
  /** The `from` side's fixed ring as drawn this frame (`MorphSide.fixed`), in px, or null. */
  live: readonly number[] | null = null,
  liveRing = -1,
  hairlinePx = 1,
  /** px per the morph's own unit: 1 for one built in px, the bath's reach for one built by the bath runtime. */
  scale = 1,
  /**
   * The `from` side's rings with a place in time (`fromOrder`) heard before
   * this one are ink, the rest `quiet`; −1 leaves the built alphas.
   */
  head = -1,
  quiet = 1,
): void {
  'worklet';
  if (alpha <= 0) return;
  const rings = morph.starts.length - 1;
  const builders: { a: number; path: ReturnType<typeof Skia.PathBuilder.Make> }[] = [];
  for (let r = 0; r < rings; r++) {
    const span = morph.w1[r] - morph.w0[r];
    const x = span > 0 ? (t - morph.w0[r]) / span : 1;
    const c = x < 0 ? 0 : x > 1 ? 1 : x;
    const e = c * c * c * (c * (6 * c - 15) + 10);
    // A ring gone to a point draws nothing.
    if ((morph.w1[r] < 1 && e >= 1) || (morph.w0[r] > 0 && e <= 0)) continue;
    const order = morph.fromOrder[r];
    const aFrom = head < 0 || order < 0 ? morph.aFrom[r] : order < head ? 1 : quiet;
    const a = aFrom + (morph.aTo[r] - aFrom) * e;
    const key = Math.round(a * 50) / 50;
    let builder = null;
    for (const b of builders) if (b.a === key) builder = b.path;
    if (builder === null) {
      builder = Skia.PathBuilder.Make();
      builders.push({ a: key, path: builder });
    }
    const start = morph.starts[r];
    const end = morph.starts[r + 1];
    const own = live !== null && liveRing >= 0 && morph.fromRing[r] === liveRing && live.length === end - start;
    for (let i = start; i < end; i += 2) {
      const fx = own ? live![i - start] / scale : morph.from[i];
      const fy = own ? live![i - start + 1] / scale : morph.from[i + 1];
      const px = (fx + (morph.to[i] - fx) * e) * scale;
      const py = (fy + (morph.to[i + 1] - fy) * e) * scale;
      if (i === start) builder.moveTo(px, py);
      else builder.lineTo(px, py);
    }
    builder.close();
  }
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const fill = morph.fillFrom + (morph.fillTo - morph.fillFrom) * (c * c * (3 - 2 * c));
  if (fill < 1) paints.stroke.setStrokeWidth(hairlinePx);
  for (const b of builders) {
    const path = b.path.detach();
    if (fill > 0) {
      paints.fill.setAlphaf(alpha * b.a * fill);
      canvas.drawPath(path, paints.fill);
    }
    if (fill < 1) {
      paints.stroke.setAlphaf(alpha * b.a * (1 - fill));
      canvas.drawPath(path, paints.stroke);
    }
  }
}

/** Morphs kept between frames on the UI thread, by a key the caller makes. */
export function cachedMarbleMorph(key: string, build: () => MarbleMorph): MarbleMorph {
  'worklet';
  const g = globalThis as unknown as { __marbleMorphs?: { key: string; morph: MarbleMorph }[] };
  if (g.__marbleMorphs === undefined) g.__marbleMorphs = [];
  const list = g.__marbleMorphs;
  for (const entry of list) if (entry.key === key) return entry.morph;
  const morph = build();
  list.push({ key, morph });
  if (list.length > 4) list.shift();
  return morph;
}

/**
 * A path's contours as rings, interleaved x, y, scaled: curves flattened in
 * `CURVE_STEPS`, and an open stroke kept as a ring of its own points (read
 * there and back, as a hairline is).
 */
export function pathRings(path: SkPath, scale: number): number[][] {
  'worklet';
  const steps = MARBLE_MORPH_KNOBS.CURVE_STEPS;
  const rings: number[][] = [];
  let ring: number[] = [];
  let x = 0;
  let y = 0;
  const cmds = path.toCmds();
  for (const cmd of cmds) {
    const verb = cmd[0];
    if (verb === 0) {
      if (ring.length >= 4) rings.push(ring);
      x = cmd[1];
      y = cmd[2];
      ring = [x * scale, y * scale];
    } else if (verb === 1) {
      x = cmd[1];
      y = cmd[2];
      ring.push(x * scale, y * scale);
    } else if (verb === 2 || verb === 3) {
      // A quad, or a conic read as its quad: near enough at a few steps.
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const v = 1 - u;
        ring.push(
          (v * v * x + 2 * v * u * cmd[1] + u * u * cmd[3]) * scale,
          (v * v * y + 2 * v * u * cmd[2] + u * u * cmd[4]) * scale,
        );
      }
      x = cmd[3];
      y = cmd[4];
    } else if (verb === 4) {
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const v = 1 - u;
        ring.push(
          (v * v * v * x + 3 * v * v * u * cmd[1] + 3 * v * u * u * cmd[3] + u * u * u * cmd[5]) * scale,
          (v * v * v * y + 3 * v * v * u * cmd[2] + 3 * v * u * u * cmd[4] + u * u * u * cmd[6]) * scale,
        );
      }
      x = cmd[5];
      y = cmd[6];
    }
  }
  if (ring.length >= 4) rings.push(ring);
  return rings;
}

/** A circle as a ring. */
export function circleRing(x: number, y: number, r: number, n: number): number[] {
  'worklet';
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return out;
}

/**
 * How deep each ring nests among the others: how many contain its first
 * point (outlines never cross, so any point of it says the same).
 */
export function ringDepths(rings: readonly (readonly number[])[]): number[] {
  'worklet';
  const depths: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    const px = rings[i][0];
    const py = rings[i][1];
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j === i) continue;
      const r = rings[j];
      const n = r.length >> 1;
      let inside = false;
      for (let p = 0, q = n - 1; p < n; q = p++) {
        const xi = r[2 * p];
        const yi = r[2 * p + 1];
        const xj = r[2 * q];
        const yj = r[2 * q + 1];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) depth += 1;
    }
    depths.push(depth);
  }
  return depths;
}
