/* eslint-disable no-bitwise -- a ring is pairs of numbers; halving a length is a shift. */

import { FillType, Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import type { PlayerPaints } from './contract';

/**
 * Marbling's morphs: one drawing becoming another, ring by ring.
 *
 * The motion engine's silhouette morph (`motion/silhouette.ts`), on the UI
 * thread: both drawings as compound even-odd rings, paired, resampled to one
 * count per pair, aligned by the rotation and direction that travel least,
 * and built once into two paths with identical verbs that Skia interpolates
 * natively every frame. A ring with no partner grows from a point, or shrinks
 * to one, where it stands. Nothing is faded over anything: the ink itself
 * moves from one shape to the other.
 *
 * Its ends are not quite either lens's own drawing — marbling's live ink, the
 * seal's sound-sized dots, the circle's hand — so each end hands over to the
 * real drawing under it (`morphShares`): the real one fades out under the
 * morph over its first `HAND_OVER` of the clock and back in over its last,
 * while the morph itself is opaque, so there is no dip in the ink and no
 * moving ghost.
 */

/** KNOBS — the morph. */
export const MARBLE_MORPH_KNOBS = {
  /** How long each end hands over to the real drawing, of the clock. */
  HAND_OVER: 0.16,
  /** About how far apart a ring's points stand, px. */
  SEG_PX: 4,
  /** Points per ring, at least and at most. */
  MIN_POINTS: 8,
  MAX_POINTS: 192,
  /** The most points a morph holds, all rings together: its cost per frame. */
  BUDGET: 6000,
  /** Rings smaller than this, px², shrink to a point rather than pair. */
  MIN_AREA_PX2: 2,
  /** How much of the clock a ring with no partner takes to go, or to come. */
  ALONE_WINDOW: 0.65,
} as const;

/** A drawing as rings in px about the player's centre, interleaved x, y, each with its ink. */
export type MorphSide = Readonly<{
  rings: readonly (readonly number[])[];
  /** Each ring's alpha (the seal's dots still to come are grey), or one for all. */
  alpha: readonly number[] | number;
}>;

/**
 * A built morph: every ring's points at both ends, interleaved x, y, in one
 * pair of arrays, with where each ring starts, its window of the clock and its
 * alpha at both ends. Lerped per frame on the UI thread (a few thousand
 * points), so each ring can keep a window of its own — a ring with no partner
 * is gone before the end, rather than lingering as a speck until the last
 * frame — and rings of one alpha share one even-odd path, so holes stay holes.
 */
export type MarbleMorph = Readonly<{
  from: number[];
  to: number[];
  /** Ring `i` is points `starts[i]` up to `starts[i + 1]`. */
  starts: number[];
  w0: number[];
  w1: number[];
  aFrom: number[];
  aTo: number[];
}>;

function ringArea(r: readonly number[]): number {
  'worklet';
  let twice = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    twice += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  }
  return Math.abs(twice) / 2;
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
 * `b` reordered to correspond with `a` (both `n` points) with the least total
 * travel: every rotation, both directions — the engine's `alignSampled`. Long
 * rings try every fourth rotation, then the three either side of the best.
 */
export function alignRing(a: readonly number[], b: readonly number[]): number[] {
  'worklet';
  const n = a.length >> 1;
  if (n === 0) return b.slice();
  const score = (k: number, rev: boolean): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = rev ? (n + k - i) % n : (k + i) % n;
      const dx = a[2 * i] - b[2 * j];
      const dy = a[2 * i + 1] - b[2 * j + 1];
      s += dx * dx + dy * dy;
    }
    return s;
  };
  const stride = n > 64 ? 4 : 1;
  let best = Infinity;
  let bestK = 0;
  let bestRev = false;
  for (let k = 0; k < n; k += stride) {
    for (const rev of [false, true]) {
      const s = score(k, rev);
      if (s < best) {
        best = s;
        bestK = k;
        bestRev = rev;
      }
    }
  }
  if (stride > 1) {
    const around = bestK;
    for (let d = -stride + 1; d < stride; d++) {
      const k = (around + d + n) % n;
      const s = score(k, bestRev);
      if (s < best) {
        best = s;
        bestK = k;
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = bestRev ? (n + bestK - i) % n : (bestK + i) % n;
    out.push(b[2 * j], b[2 * j + 1]);
  }
  return out;
}

function alphaOf(side: MorphSide, index: number): number {
  'worklet';
  return typeof side.alpha === 'number' ? side.alpha : side.alpha[index] ?? 1;
}

/**
 * Pair two drawings' rings and build the paths between them, once.
 *
 * Largest first; among the rings left, each takes the partner nearest it in
 * size and place, so ink flows to the shape beside it rather than across the
 * disc. A ring with no partner, or too small to bother, grows from (or
 * shrinks to) its own centre.
 */
export function buildMarbleMorph(from: MorphSide, to: MorphSide, reach: number): MarbleMorph {
  'worklet';
  const K = MARBLE_MORPH_KNOBS;
  const order = (side: MorphSide) =>
    side.rings
      .map((ring, index) => ({ ring, index, area: ringArea(ring), centre: ringCentre(ring) }))
      .filter(entry => entry.ring.length >= 6)
      .sort((x, y) => y.area - x.area);
  const a = order(from);
  const b = order(to);
  const taken = new Array<boolean>(b.length).fill(false);
  type Pair = { a: number[] | null; b: number[] | null; aAlpha: number; bAlpha: number; centre: [number, number]; want: number };
  const pairs: Pair[] = [];
  for (const entry of a) {
    let pick = -1;
    if (entry.area >= K.MIN_AREA_PX2) {
      let best = Infinity;
      // The largest few left, by how alike they are in size and how near.
      let looked = 0;
      for (let j = 0; j < b.length && looked < 24; j++) {
        if (taken[j] || b[j].area < K.MIN_AREA_PX2) continue;
        looked += 1;
        const size = Math.abs(Math.log((b[j].area + 1) / (entry.area + 1)));
        const far = Math.hypot(b[j].centre[0] - entry.centre[0], b[j].centre[1] - entry.centre[1]) / reach;
        const cost = size + 2 * far;
        if (cost < best) {
          best = cost;
          pick = j;
        }
      }
    }
    const length = Math.max(ringLength(entry.ring), pick >= 0 ? ringLength(b[pick].ring) : 0);
    if (pick >= 0) taken[pick] = true;
    pairs.push({
      a: entry.ring.slice(),
      b: pick >= 0 ? b[pick].ring.slice() : null,
      aAlpha: alphaOf(from, entry.index),
      bAlpha: pick >= 0 ? alphaOf(to, b[pick].index) : alphaOf(from, entry.index),
      centre: entry.centre,
      want: length / K.SEG_PX,
    });
  }
  for (let j = 0; j < b.length; j++) {
    if (taken[j]) continue;
    pairs.push({
      a: null,
      b: b[j].ring.slice(),
      aAlpha: alphaOf(to, b[j].index),
      bAlpha: alphaOf(to, b[j].index),
      centre: b[j].centre,
      want: ringLength(b[j].ring) / K.SEG_PX,
    });
  }
  // Points per pair, by length, within the budget.
  let wanted = 0;
  for (const pair of pairs) wanted += Math.max(K.MIN_POINTS, Math.min(K.MAX_POINTS, pair.want));
  const squeeze = wanted > K.BUDGET ? K.BUDGET / wanted : 1;
  const point = (x: number, y: number, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(x, y);
    return out;
  };
  const morph: { from: number[]; to: number[]; starts: number[]; w0: number[]; w1: number[]; aFrom: number[]; aTo: number[] } = {
    from: [],
    to: [],
    starts: [],
    w0: [],
    w1: [],
    aFrom: [],
    aTo: [],
  };
  for (const pair of pairs) {
    const n = Math.max(
      K.MIN_POINTS,
      Math.round(Math.max(K.MIN_POINTS, Math.min(K.MAX_POINTS, pair.want)) * squeeze),
    );
    const centreA = pair.a !== null ? ringCentre(pair.a) : null;
    const centreB = pair.b !== null ? ringCentre(pair.b) : null;
    const ra = pair.a !== null ? resampleRing(pair.a, n) : point(centreB![0], centreB![1], n);
    let rb = pair.b !== null ? resampleRing(pair.b, n) : point(centreA![0], centreA![1], n);
    if (pair.a !== null && pair.b !== null) rb = alignRing(ra, rb);
    morph.starts.push(morph.from.length);
    for (let i = 0; i < ra.length; i++) {
      morph.from.push(ra[i]);
      morph.to.push(rb[i]);
    }
    // Alone: gone over the first part of the clock, or come over the last.
    morph.w0.push(pair.a === null ? 1 - K.ALONE_WINDOW : 0);
    morph.w1.push(pair.b === null ? K.ALONE_WINDOW : 1);
    morph.aFrom.push(pair.aAlpha);
    morph.aTo.push(pair.bAlpha);
  }
  morph.starts.push(morph.from.length);
  return morph;
}

/**
 * How much of each layer is drawn at `t`: the leaving lens's own drawing,
 * the arriving lens's, and the morph over them.
 */
export function morphShares(t: number): { from: number; to: number; morph: number } {
  'worklet';
  const h = MARBLE_MORPH_KNOBS.HAND_OVER;
  const ss = (x: number) => {
    const c = x < 0 ? 0 : x > 1 ? 1 : x;
    return c * c * (3 - 2 * c);
  };
  return {
    from: 1 - ss(t / h),
    to: ss((t - (1 - h)) / (h / 2)),
    morph: t <= 0 || t >= 1 ? 0 : 1 - ss((t - (1 - h / 2)) / (h / 2)),
  };
}

/**
 * The morph at `t` (0..1, linear), filled in the ink at `alpha`: each ring
 * eased through its own window, one even-odd path per alpha it stands at.
 */
export function drawMarbleMorphPaths(
  canvas: SkCanvas,
  morph: MarbleMorph,
  t: number,
  alpha: number,
  paints: PlayerPaints,
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
    const a = morph.aFrom[r] + (morph.aTo[r] - morph.aFrom[r]) * e;
    // A ring gone to a point draws nothing.
    if ((morph.w1[r] < 1 && e >= 1) || (morph.w0[r] > 0 && e <= 0)) continue;
    const key = Math.round(a * 100) / 100;
    let builder = null;
    for (const b of builders) if (b.a === key) builder = b.path;
    if (builder === null) {
      builder = Skia.PathBuilder.Make();
      builder.setFillType(FillType.EvenOdd);
      builders.push({ a: key, path: builder });
    }
    const start = morph.starts[r];
    const end = morph.starts[r + 1];
    for (let i = start; i < end; i += 2) {
      const px = morph.from[i] + (morph.to[i] - morph.from[i]) * e;
      const py = morph.from[i + 1] + (morph.to[i + 1] - morph.from[i + 1]) * e;
      if (i === start) builder.moveTo(px, py);
      else builder.lineTo(px, py);
    }
    builder.close();
  }
  for (const b of builders) {
    paints.fill.setAlphaf(alpha * b.a);
    canvas.drawPath(b.path.detach(), paints.fill);
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

/** A path's contours as rings, interleaved x, y, scaled. */
export function pathRings(path: SkPath, scale: number): number[][] {
  'worklet';
  const rings: number[][] = [];
  let ring: number[] = [];
  const cmds = path.toCmds();
  for (const cmd of cmds) {
    const verb = cmd[0];
    if (verb === 0) {
      if (ring.length >= 6) rings.push(ring);
      ring = [cmd[1] * scale, cmd[2] * scale];
    } else if (verb === 1) {
      ring.push(cmd[1] * scale, cmd[2] * scale);
    } else if (verb === 2 || verb === 3) {
      // A quad's or a conic's end point (a conic carries its weight after it).
      ring.push(cmd[3] * scale, cmd[4] * scale);
    } else if (verb === 4) {
      ring.push(cmd[5] * scale, cmd[6] * scale);
    }
  }
  if (ring.length >= 6) rings.push(ring);
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
