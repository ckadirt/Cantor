/**
 * The manim trick, minus the topology cleverness: resample every shape to the
 * same number of points along its outline, then interpolate point-by-point.
 * Because all shapes become an N-point polygon with identical verb structure,
 * Skia's built-in interpolatePaths can morph any of them into any other on the
 * UI thread. Correspondence + easing — that's the whole magic.
 */
import { Skia, type SkPath } from '@shopify/react-native-skia';

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
