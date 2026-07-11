/**
 * The manim trick, minus the topology cleverness: resample every shape to the
 * same number of points along its outline, then interpolate point-by-point.
 * Because all shapes become an N-point polygon with identical verb structure,
 * Skia's built-in interpolatePaths can morph any of them into any other on the
 * UI thread. Correspondence + easing — that's the whole magic.
 */
import { Skia, StrokeCap, StrokeJoin, type SkPath } from '@shopify/react-native-skia';

export type Pt = { x: number; y: number };

/** Points per shape. 64 is plenty for glyph-sized marks and cheap on the GPU. */
export const N = 64;

/** Walk a path's first contour and sample N equidistant points along it. */
export function resample(path: SkPath, n = N): Pt[] {
  const it = Skia.ContourMeasureIter(path, true, 1);
  const contour = it.next();
  if (!contour) {
    return [];
  }
  const len = contour.length();
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const [pos] = contour.getPosTan((i / n) * len);
    pts.push({ x: pos.x, y: pos.y });
  }
  return pts;
}

/** Sample an SVG path string directly. Returns [] if it doesn't parse. */
export function resampleSvg(svg: string, n = N): Pt[] {
  const path = Skia.Path.MakeFromSVGString(svg);
  return path ? resample(path, n) : [];
}

/**
 * Thicken a centerline SVG into a thin ribbon (Path.stroke) and sample its
 * outline. Lets the symbols be authored as single elegant strokes yet morph
 * through the same filled-polygon pipeline as the solid bars.
 */
export function resampleStrokedSvg(svg: string, width: number, n = N): Pt[] {
  const base = Skia.Path.MakeFromSVGString(svg);
  if (!base) {
    return [];
  }
  const ribbon = base.stroke({ width, cap: StrokeCap.Round, join: StrokeJoin.Round });
  return ribbon ? resample(ribbon, n) : [];
}

/** A closed N-gon as an SkPath — the interpolable form of any shape. */
export function polygonPath(pts: Pt[]): SkPath {
  const p = Skia.Path.Make();
  if (pts.length === 0) {
    return p;
  }
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    p.lineTo(pts[i].x, pts[i].y);
  }
  p.close();
  return p;
}

/**
 * Rotate `dst` so its first point is the one nearest `src`'s first point. Keeps
 * the morph from twisting when two shapes start their outline in different
 * places. (Nearest-start only — cheap, and enough for our small marks.)
 */
export function align(src: Pt[], dst: Pt[]): Pt[] {
  if (src.length === 0 || dst.length === 0) {
    return dst;
  }
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < dst.length; k++) {
    const d = (dst[k].x - src[0].x) ** 2 + (dst[k].y - src[0].y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best === 0 ? dst : [...dst.slice(best), ...dst.slice(0, best)];
}

/** Place a 0..100-box symbol into the canvas: rotate, scale, translate. */
export function placeSymbol(
  pts: Pt[],
  cx: number,
  cy: number,
  size: number,
  angle: number,
): Pt[] {
  const s = size / 100;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(({ x, y }) => {
    const lx = (x - 50) * s;
    const ly = (y - 50) * s;
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    };
  });
}

/**
 * Push a set of points apart until none overlap, keeping them inside `bounds`.
 * Deterministic relaxation — a few dozen passes of pairwise repulsion is plenty
 * for the handful of scattered marks. Mutates `pts` in place.
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
          // coincident — nudge apart deterministically
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
    // keep everyone on-screen
    for (let i = 0; i < n; i++) {
      pts[i].x = Math.min(bounds.maxX, Math.max(bounds.minX, pts[i].x));
      pts[i].y = Math.min(bounds.maxY, Math.max(bounds.minY, pts[i].y));
    }
  }
}

/* eslint-disable no-bitwise -- mulberry32 is inherently bitwise */
/** Deterministic per-bar RNG so the scatter is stable across renders. */
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
