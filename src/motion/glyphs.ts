/**
 * Glyphs as morphable geometry — the last piece of manim's text transform.
 * Skia.Path.MakeFromText gives a character's true outline (all contours:
 * an 'e' is a ring and a hole); each contour goes through the same
 * resample→align pipeline as the sigils, holes and rings paired by size,
 * missing partners collapsing to/growing from their counterpart's centre.
 * One multi-contour path per character pair, interpolated on the UI thread
 * and filled even-odd so counters stay holes mid-morph.
 *
 * Native Skia only (CanvasKit web throws) — callers must treat null as
 * "morph unavailable" and fall back to exit+enter.
 */
import { Skia, type SkFont, type SkPath } from '@shopify/react-native-skia';
import {
  alignSampled,
  assertInterpolatable,
  centroid,
  collapsedAt,
  type Pt,
  type Sampled,
} from './geometry';
import type { CharBox } from './text';

/** Points per glyph contour. Glyph-sized shapes; 48 reads perfectly smooth. */
const N_GLYPH = 48;

type Outline = Sampled[]; // contours sorted by area, baseline-origin space

const cache = new WeakMap<SkFont, Map<string, Outline | null>>();

function shoelace(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function sampleContours(path: SkPath): Outline {
  const it = Skia.ContourMeasureIter(path, false, 1);
  const contours: Outline = [];
  let c = it.next();
  while (c) {
    const len = c.length();
    if (len > 1e-3) {
      const pts: Pt[] = [];
      const unique = N_GLYPH - 1;
      for (let i = 0; i < unique; i++) {
        const [pos] = c.getPosTan((i / unique) * len);
        pts.push({ x: pos.x, y: pos.y });
      }
      pts.push({ ...pts[0] });
      contours.push({ pts, closed: true });
    }
    c = it.next();
  }
  // ring before hole(s): pair outers with outers when glyphs differ
  contours.sort((a, b) => shoelace(b.pts) - shoelace(a.pts));
  return contours;
}

/** A character's outline at baseline origin, or null when unavailable. */
export function glyphOutline(font: SkFont, ch: string): Outline | null {
  let byChar = cache.get(font);
  if (!byChar) {
    byChar = new Map();
    cache.set(font, byChar);
  }
  if (byChar.has(ch)) {
    return byChar.get(ch)!;
  }
  let outline: Outline | null = null;
  try {
    const path = Skia.Path.MakeFromText(ch, 0, 0, font);
    if (path) {
      const contours = sampleContours(path);
      outline = contours.length > 0 ? contours : null;
    }
  } catch {
    outline = null; // CanvasKit (jest) has no MakeFromText
  }
  byChar.set(ch, outline);
  return outline;
}

/**
 * A glyph's exact native outline at its laid-out baseline position. Write uses
 * this unsampled path so its border trace and filled hand-off are pixel-identical
 * to the final Skia glyph. CanvasKit does not expose MakeFromText, so callers
 * retain a Glyphs fallback for that environment.
 */
export function placedGlyphPath(font: SkFont, box: CharBox): SkPath | null {
  try {
    return Skia.Path.MakeFromText(box.ch, box.x, box.y, font);
  } catch {
    return null;
  }
}

function multiPolylinePath(contours: Pt[][]): SkPath {
  const builder = Skia.PathBuilder.Make();
  for (const pts of contours) {
    builder.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      builder.lineTo(pts[i].x, pts[i].y);
    }
  }
  return builder.build();
}

const placed = (o: Outline, x: number, y: number): Outline =>
  o.map(s => ({ pts: s.pts.map(p => ({ x: p.x + x, y: p.y + y })), closed: true }));

/**
 * Verb-identical from/to paths morphing one character's shape into another's,
 * travel included (the outlines are placed at their boxes before sampling
 * correspondence, so one interpolation carries both). Null when either glyph
 * has no outline.
 */
export function buildGlyphMorphPaths(
  font: SkFont,
  from: CharBox,
  to: CharBox,
): { from: SkPath; to: SkPath } | null {
  const a = glyphOutline(font, from.ch);
  const b = glyphOutline(font, to.ch);
  if (!a || !b) {
    return null;
  }
  const pa = placed(a, from.x, from.y);
  const pb = placed(b, to.x, to.y);
  const k = Math.max(pa.length, pb.length);
  const fromC: Pt[][] = [];
  const toC: Pt[][] = [];
  for (let i = 0; i < k; i++) {
    let src = pa[i];
    let dst = pb[i];
    if (!src) {
      // a hole appears — grow it from its own centre
      src = { pts: collapsedAt(dst.pts, centroid(dst.pts)), closed: true };
    }
    if (!dst) {
      // a hole closes — swallow it into its own centre
      dst = { pts: collapsedAt(src.pts, centroid(src.pts)), closed: true };
    }
    fromC.push(src.pts);
    toC.push(alignSampled(src, dst));
  }
  const fromPath = multiPolylinePath(fromC);
  const toPath = multiPolylinePath(toC);
  assertInterpolatable(fromPath, toPath, 'buildGlyphMorphPaths');
  return { from: fromPath, to: toPath };
}
