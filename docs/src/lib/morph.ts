/**
 * Outline morphing, built once at build time so the browser only lerps. It
 * follows the app's motion engine (`cantor/src/motion`): every contour
 * resampled to the same count by arc length, contours matched in reading
 * order (outlines to outlines, counters to counters), each destination
 * rotated to the start its source travels least to, and a contour without a
 * partner growing out of, or shrinking into, the nearest one across.
 */

/** Points per contour: enough for a serif's curves at display sizes. */
export const MORPH_POINTS = 56;
/** Steps a curve is cut into before resampling. */
const CURVE_STEPS = 10;

export type Pt = { x: number; y: number };

/**
 * One morph between two outlines. `from` and `to` are contours as
 * `x0 y0 x1 y1 …`; `pairs` are `[from, to, near]`: a pair morphs from one into
 * the other; with `to` at -1 the contour shrinks into the centre of
 * `to[near]`, with `from` at -1 it grows out of the centre of `from[near]`.
 * Pairs are one to one, so no outline is ever stacked on another: stacked
 * outlines would fill each other's counters.
 */
export type Morph = { from: number[][]; to: number[][]; pairs: [number, number, number][] };

type Contour = { pts: Pt[]; cx: number; hole: boolean };

/** Curves cut into points; each closed subpath one list. */
export function flattenCommands(commands: { command: string; args: number[] }[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let at: Pt = { x: 0, y: 0 };
  const close = () => {
    if (cur.length > 2) out.push(cur);
    cur = [];
  };
  const curve = (pts: Pt[]) => {
    for (let i = 1; i <= CURVE_STEPS; i += 1) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      if (pts.length === 2) {
        const [c, e] = pts;
        cur.push({ x: u * u * at.x + 2 * u * t * c.x + t * t * e.x, y: u * u * at.y + 2 * u * t * c.y + t * t * e.y });
      } else {
        const [c1, c2, e] = pts;
        cur.push({
          x: u * u * u * at.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x,
          y: u * u * u * at.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y,
        });
      }
    }
    at = pts[pts.length - 1];
  };
  for (const { command, args } of commands) {
    const p = (i: number) => ({ x: args[i], y: args[i + 1] });
    if (command === 'moveTo') {
      close();
      at = p(0);
      cur.push(at);
    } else if (command === 'lineTo') {
      at = p(0);
      cur.push(at);
    } else if (command === 'quadraticCurveTo') curve([p(0), p(2)]);
    else if (command === 'bezierCurveTo') curve([p(0), p(2), p(4)]);
    else if (command === 'closePath') close();
  }
  close();
  return out;
}

/** The closed contour resampled to `n` points evenly along its length. */
export function resample(pts: Pt[], n = MORPH_POINTS): Pt[] {
  const ring = [...pts, pts[0]];
  const lengths = [0];
  for (let i = 1; i < ring.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y));
  const total = lengths[lengths.length - 1];
  const out: Pt[] = [];
  let j = 1;
  for (let k = 0; k < n; k += 1) {
    const d = (k / n) * total;
    while (j < lengths.length - 1 && lengths[j] < d) j += 1;
    const span = lengths[j] - lengths[j - 1] || 1;
    const t = (d - lengths[j - 1]) / span;
    out.push({ x: ring[j - 1].x + (ring[j].x - ring[j - 1].x) * t, y: ring[j - 1].y + (ring[j].y - ring[j - 1].y) * t });
  }
  return out;
}

const centre = (pts: Pt[]) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
const inside = (p: Pt, ring: Pt[]) => {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
  }
  return odd;
};

/** Contours resampled, each marked a counter when an odd number of the others hold it. */
export function contoursOf(rings: Pt[][]): Contour[] {
  const sampled = rings.map((r) => resample(r));
  return sampled.map((pts, i) => ({
    pts,
    cx: centre(pts).x,
    hole: sampled.filter((other, j) => j !== i && inside(pts[0], other)).length % 2 === 1,
  }));
}

/** `b` rotated to start where it best follows `a`, measured about their own centres. */
function align(a: Pt[], b: Pt[]): Pt[] {
  const ca = centre(a);
  const cb = centre(b);
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < b.length; shift += 1) {
    let cost = 0;
    for (let i = 0; i < a.length; i += 1) {
      const p = a[i];
      const q = b[(i + shift) % b.length];
      cost += (p.x - ca.x - (q.x - cb.x)) ** 2 + (p.y - ca.y - (q.y - cb.y)) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  return b.map((_, i) => b[(i + best) % b.length]);
}

/**
 * Pair two lists, each in reading order, one to one: the shorter list's
 * contours take partners spread evenly through the longer; every contour left
 * over joins the nearest contour that has one.
 */
function match(from: number[], to: number[], fromX: number[], toX: number[]): [number, number, number][] {
  const swap = from.length > to.length;
  const few = swap ? to : from;
  const many = swap ? from : to;
  const fewX = swap ? toX : fromX;
  const manyX = swap ? fromX : toX;
  const chosen = new Map<number, number>();
  few.forEach((f, k) => chosen.set(many[Math.floor(((k + 0.5) * many.length) / few.length)], f));
  return many.map((m) => {
    const partner = chosen.get(m);
    if (partner !== undefined) return swap ? [m, partner, -1] : [partner, m, -1];
    // Nothing of its own: it leaves into, or comes out of, the nearest one across.
    const near = few.length === 0
      ? -1
      : few.reduce((best, f) => (Math.abs(fewX[f] - manyX[m]) < Math.abs(fewX[best] - manyX[m]) ? f : best), few[0]);
    return swap ? [m, -1, near] : [-1, m, near];
  });
}

const flat = (pts: Pt[]) => pts.flatMap((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]);

/** The morph from one outline to another. */
export function morph(a: Contour[], b: Contour[]): Morph {
  const byX = (list: Contour[], hole: boolean) =>
    list.map((c, i) => ({ c, i })).filter(({ c }) => c.hole === hole).sort((p, q) => p.c.cx - q.c.cx).map(({ i }) => i);
  const ax = a.map((c) => c.cx);
  const bx = b.map((c) => c.cx);
  const pairs = [...match(byX(a, false), byX(b, false), ax, bx), ...match(byX(a, true), byX(b, true), ax, bx)];
  const aligned = new Map<number, Pt[]>();
  for (const [i, j] of pairs) {
    if (i >= 0 && j >= 0 && !aligned.has(j)) aligned.set(j, align(a[i].pts, b[j].pts));
  }
  return { from: a.map((c) => flat(c.pts)), to: b.map((c, j) => flat(aligned.get(j) ?? c.pts)), pairs };
}
