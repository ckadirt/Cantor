/**
 * The geometric heart of the motion engine — the manim trick, done properly.
 * Every contour is resampled to the same number of points along its length, so
 * any shape can morph into any other through Skia's interpolatePaths on the UI
 * thread. What lives here beyond the old onboarding/morph.ts:
 *
 *  - corner-aware sampling: pure-line contours keep their corners as sample
 *    points, so squares stay squares mid-morph instead of smearing;
 *  - real correspondence: winding/direction normalisation plus a best-rotation
 *    search (O(N²), runs once per transition), replacing nearest-first-point —
 *    the source of most "the morph twisted" moments;
 *  - smootherstep: manim's `smooth` — the quintic 10t³−15t⁴+6t⁵ with zero first
 *    AND second derivative at the ends. This is the app's one easing now.
 *
 * Everything here is pure math on JS-side arrays; it runs once when a
 * transition is built, never per frame.
 */
import {
  PathVerb,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkPath,
} from '@shopify/react-native-skia';

export type Pt = { x: number; y: number };

/** A contour reduced to its interpolable form: N points, first==last if closed. */
export type Sampled = { pts: Pt[]; closed: boolean };

/** Points per contour. 64 is plenty for glyph-sized marks and cheap on the GPU. */
export const N = 64;

/** Cubic Hermite step. Kept for places that want the lighter curve. */
export function smoothstep(a: number, b: number, x: number): number {
  'worklet';
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Quintic smootherstep — manim's default rate function. Acceleration itself
 * eases in and out, which is most of the "buttery" in a 3b1b transform.
 */
export function smootherstep(a: number, b: number, x: number): number {
  'worklet';
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/* ------------------------------------------------------------------ sampling */

/** True when every verb is Move/Line/Close — a polyline whose corners matter. */
function polylineVertices(
  path: SkPath,
): { verts: Pt[]; closed: boolean } | null {
  const cmds = path.toCmds();
  const verts: Pt[] = [];
  let closed = false;
  for (const c of cmds) {
    const verb = c[0];
    if (verb === PathVerb.Move || verb === PathVerb.Line) {
      verts.push({ x: c[1], y: c[2] });
    } else if (verb === PathVerb.Close) {
      closed = true;
    } else {
      return null; // curves — sample by arc length instead
    }
  }
  return verts.length >= 2 ? { verts, closed } : null;
}

/**
 * Distribute `count` samples along a polyline, guaranteeing every vertex
 * (corner) is one of them. Counts per segment are proportional to length,
 * fixed up by largest remainder so they sum exactly.
 */
function samplePolyline(verts: Pt[], closed: boolean, n: number): Sampled {
  const ring = closed ? [...verts, verts[0]] : verts;
  const segs: { a: Pt; b: Pt; len: number }[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1e-6) {
      segs.push({ a, b, len });
    }
  }
  const total = segs.reduce((s, g) => s + g.len, 0);
  const unique = n - 1; // last slot: closing copy of pts[0], or the end vertex
  // Each segment owns its start vertex plus a length-proportional share.
  const quota = segs.map(g => (unique * g.len) / total);
  const counts = quota.map(q => Math.max(1, Math.floor(q)));
  let left = unique - counts.reduce((s, c) => s + c, 0);
  const byRemainder = quota
    .map((q, i) => ({ i, r: q - Math.floor(q) }))
    .sort((p, q) => q.r - p.r);
  for (let k = 0; left > 0; k = (k + 1) % byRemainder.length, left--) {
    counts[byRemainder[k].i]++;
  }
  while (left < 0) {
    const i = counts.findIndex(c => c > 1);
    counts[i > -1 ? i : 0]--;
    left++;
  }
  const pts: Pt[] = [];
  segs.forEach((g, si) => {
    for (let j = 0; j < counts[si]; j++) {
      const f = j / counts[si];
      pts.push({
        x: g.a.x + (g.b.x - g.a.x) * f,
        y: g.a.y + (g.b.y - g.a.y) * f,
      });
    }
  });
  pts.push(closed ? { ...pts[0] } : { ...ring[ring.length - 1] });
  return { pts, closed };
}

/** Uniform arc-length sampling of a path's first contour. */
function sampleByLength(path: SkPath, closed: boolean, n: number): Sampled {
  const it = Skia.ContourMeasureIter(path, false, 1);
  const contour = it.next();
  if (!contour) {
    return { pts: [], closed };
  }
  const len = contour.length();
  const pts: Pt[] = [];
  const unique = closed ? n - 1 : n;
  const step = closed ? len / (n - 1) : len / (n - 1);
  for (let i = 0; i < unique; i++) {
    const [pos] = contour.getPosTan(Math.min(len, i * step));
    pts.push({ x: pos.x, y: pos.y });
  }
  if (closed) {
    pts.push({ ...pts[0] });
  }
  return { pts, closed };
}

/**
 * Sample a single-contour SVG path string into its N-point interpolable form.
 * Pure-line contours keep every corner as a sample point.
 */
export function samplePathString(d: string, n = N): Sampled {
  const path = Skia.Path.MakeFromSVGString(d);
  if (!path) {
    throw new Error(`motion: unparseable path "${d.slice(0, 40)}…"`);
  }
  const poly = polylineVertices(path);
  if (poly) {
    return samplePolyline(poly.verts, poly.closed, n);
  }
  const cmds = path.toCmds();
  const hasClose = cmds.some(c => c[0] === PathVerb.Close);
  if (!hasClose) {
    // endpoints touching also count as closed (authored loops without Z)
    const it = Skia.ContourMeasureIter(path, false, 1);
    const contour = it.next();
    if (contour) {
      const len = contour.length();
      const [p0] = contour.getPosTan(0);
      const [p1] = contour.getPosTan(len);
      const touch = Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.75;
      return sampleByLength(path, touch, n);
    }
  }
  return sampleByLength(path, hasClose, n);
}

/**
 * Sample the OUTLINE of a path (first contour) as a closed ring — the intro's
 * form: solid Cantor bars and stroked-ribbon glyphs both live here.
 */
export function sampleOutline(path: SkPath, n = N): Pt[] {
  return sampleByLength(path, true, n + 1).pts.slice(0, n);
}

/** Sample every contour in a compound path as a closed N-point ring. */
export function sampleCompoundPath(path: SkPath, n = N): Pt[][] {
  const contours: Pt[][] = [];
  const it = Skia.ContourMeasureIter(path, false, 1);
  let contour = it.next();
  while (contour) {
    const len = contour.length();
    if (len > 1e-6) {
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const [pos] = contour.getPosTan((len * i) / n);
        pts.push({ x: pos.x, y: pos.y });
      }
      contours.push(pts);
    }
    contour = it.next();
  }
  return contours;
}

/** Parse and sample all counters/components of a compound SVG path. */
export function sampleCompoundPathString(d: string, n = N): Pt[][] {
  const path = Skia.Path.MakeFromSVGString(d);
  if (!path) {
    throw new Error(`motion: unparseable compound path "${d.slice(0, 40)}…"`);
  }
  return sampleCompoundPath(path, n);
}

/**
 * Thicken a centerline SVG into a thin ribbon (Path.stroke) and sample its
 * outline — the intro morphs solid bars into these. New engine strokes render
 * centerlines directly with stroke paint instead; this stays for fill↔ribbon.
 */
export function ribbonOutline(svg: string, width: number, n = N): Pt[] {
  const base = Skia.Path.MakeFromSVGString(svg);
  if (!base) {
    return [];
  }
  const ribbon = Skia.Path.Stroke(base, {
    width,
    cap: StrokeCap.Round,
    join: StrokeJoin.Round,
  });
  return ribbon ? sampleOutline(ribbon, n) : [];
}

/* --------------------------------------------------------------------- paths */

/**
 * Dev-only invariant: interpolatePaths silently misdraws if from/to verbs
 * ever diverge. The builders guarantee identity by construction; this makes
 * the guarantee loud where pairs are produced, not subtle where they render.
 */
export function assertInterpolatable(
  from: SkPath,
  to: SkPath,
  label: string,
): void {
  if (__DEV__ && !from.isInterpolatable(to)) {
    throw new Error(
      `motion: ${label} built non-interpolatable paths (verb drift)`,
    );
  }
}

/** An open polyline as an SkPath — the one verb structure everything shares. */
export function polylinePath(pts: Pt[]): SkPath {
  const builder = Skia.PathBuilder.Make();
  if (pts.length === 0) {
    return builder.build();
  }
  builder.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    builder.lineTo(pts[i].x, pts[i].y);
  }
  return builder.build();
}

/** A closed N-gon as an SkPath (the intro's bar/ribbon form). */
export function polygonPath(pts: Pt[]): SkPath {
  const builder = Skia.PathBuilder.Make();
  if (pts.length === 0) {
    return builder.build();
  }
  builder.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    builder.lineTo(pts[i].x, pts[i].y);
  }
  builder.close();
  return builder.build();
}

/** Multiple closed rings in one verb-compatible, even-odd-fillable path. */
export function compoundPolygonPath(contours: Pt[][]): SkPath {
  const builder = Skia.PathBuilder.Make();
  for (const pts of contours) {
    if (pts.length === 0) {
      continue;
    }
    builder.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      builder.lineTo(pts[i].x, pts[i].y);
    }
    builder.close();
  }
  return builder.build();
}

/* ----------------------------------------------------------------- alignment */

function score(
  a: Pt[],
  b: Pt[],
  bOffset: number,
  bLen: number,
  reversed: boolean,
): number {
  let s = 0;
  const n = Math.min(a.length, bLen);
  for (let i = 0; i < n; i++) {
    let j = (bOffset + i) % bLen;
    if (reversed) {
      j = (bLen + bOffset - i) % bLen;
    }
    const dx = a[i].x - b[j].x;
    const dy = a[i].y - b[j].y;
    s += dx * dx + dy * dy;
  }
  return s;
}

/**
 * Reorder `b`'s points so they correspond to `a`'s with the least total travel:
 * tries the reversed direction (winding normalisation — a CW→CCW pair otherwise
 * twists into a bowtie) and, for closed contours, every rotation of the cycle.
 * O(N²) once per transition; ~8k ops at N=64.
 */
export function alignSampled(a: Sampled, b: Sampled): Pt[] {
  if (a.pts.length === 0 || b.pts.length === 0) {
    return b.pts;
  }
  if (!b.closed) {
    const fwd = score(a.pts, b.pts, 0, b.pts.length, false);
    const rev = score(a.pts, [...b.pts].reverse(), 0, b.pts.length, false);
    return rev < fwd ? [...b.pts].reverse() : b.pts;
  }
  // closed: rotate the unique cycle (last point duplicates the first)
  const cyc = b.pts.slice(0, b.pts.length - 1);
  const m = cyc.length;
  let best = { s: Infinity, k: 0, rev: false };
  for (let k = 0; k < m; k++) {
    const sf = score(a.pts, cyc, k, m, false);
    if (sf < best.s) {
      best = { s: sf, k, rev: false };
    }
    const sr = score(a.pts, cyc, k, m, true);
    if (sr < best.s) {
      best = { s: sr, k, rev: true };
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const j = best.rev ? (m + best.k - i) % m : (best.k + i) % m;
    out.push(cyc[j]);
  }
  out.push({ ...out[0] });
  return out;
}

/** The intro's alignment: both rings closed, given as plain point arrays. */
export function alignClosed(a: Pt[], b: Pt[]): Pt[] {
  const aligned = alignSampled(
    { pts: [...a, a[0]], closed: true },
    { pts: [...b, b[0]], closed: true },
  );
  return aligned.slice(0, aligned.length - 1);
}

/* ------------------------------------------------------------------- affines */

/**
 * Place a 0..100-box contour into the canvas: stretch, rotate, scale, translate.
 * `aspectRatio` is width / height; keeping it here means authored symbol
 * proportions survive both the reusable shape renderer and bespoke scenes.
 */
export function placePts(
  pts: Pt[],
  cx: number,
  cy: number,
  size: number,
  angle = 0,
  aspectRatio = 1,
): Pt[] {
  const s = size / 100;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(({ x, y }) => {
    const lx = (x - 50) * s * aspectRatio;
    const ly = (y - 50) * s;
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    };
  });
}

export function lerpPts(a: Pt[], b: Pt[], t: number): Pt[] {
  return a.map((p, i) => ({
    x: p.x + (b[i].x - p.x) * t,
    y: p.y + (b[i].y - p.y) * t,
  }));
}

export function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Every point at `c` — the FadeToPoint / grow-from-point partner shape. */
export function collapsedAt(pts: Pt[], c: Pt): Pt[] {
  return pts.map(() => ({ ...c }));
}

/* ------------------------------------------------------- scatter (the intro) */

/**
 * Push a set of points apart until none overlap, keeping them inside `bounds`.
 * Deterministic relaxation; mutates `pts` in place.
 */
export function relaxPositions(
  pts: Pt[],
  radii: number[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  iterations = 80,
): void {
  const n = pts.length;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pts[j].x - pts[i].x;
        let dy = pts[j].y - pts[i].y;
        let d = Math.hypot(dx, dy);
        const min = radii[i] + radii[j];
        if (d >= min) {
          continue;
        }
        if (d < 1e-4) {
          dx = (i - j) % 2 === 0 ? 1 : -1;
          dy = 0.3;
          d = Math.hypot(dx, dy);
        }
        const push = (min - d) / 2;
        const nx = (dx / d) * push;
        const ny = (dy / d) * push;
        pts[i].x -= nx;
        pts[i].y -= ny;
        pts[j].x += nx;
        pts[j].y += ny;
      }
    }
    for (let i = 0; i < n; i++) {
      pts[i].x = Math.min(bounds.maxX, Math.max(bounds.minX, pts[i].x));
      pts[i].y = Math.min(bounds.maxY, Math.max(bounds.minY, pts[i].y));
    }
  }
}

/* eslint-disable no-bitwise -- mulberry32 is inherently bitwise */
/** Deterministic RNG so scatters are stable across renders. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable no-bitwise */
