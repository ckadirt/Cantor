/**
 * Filled silhouette geometry for true glyph-to-glyph morphs.
 *
 * Canonical artwork is compound: an outer ring plus counters/holes. Keeping
 * every ring inside one even-odd path means the good glyph itself—not a
 * centerline proxy—is the interpolation target.
 */
import {
  FillType,
  PathOp,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  alignClosed,
  assertInterpolatable,
  centroid,
  compoundPolygonPath,
  lerpPts,
  placePts,
  sampleCompoundPath,
  type Pt,
} from './geometry';
import { AUTHOR_STROKE, type ResolveShapeOptions, type Shape } from './shapes';

/** Extra detail matters on the long flourishes of the music glyphs. */
export const SILHOUETTE_N = 96;

export type Silhouette = { contours: Pt[][] };

export type SilhouetteTransition = {
  from: SkPath;
  to: SkPath;
  out: SkPath;
  fromContours: Pt[][];
  toContours: Pt[][];
};

function authoredContours(
  shape: Shape,
  strokeWidth: number,
  n: number,
  inkInset = 0,
): Pt[][] {
  if (shape.artwork) {
    const parsed = Skia.Path.MakeFromSVGString(shape.artwork.d);
    if (!parsed) {
      return [];
    }
    const builder = Skia.PathBuilder.MakeFromPath(parsed);
    builder.setFillType(FillType.EvenOdd);
    const original = builder.build();
    const baseline = shape.strokeWidth ?? AUTHOR_STROKE;
    const weightDelta = strokeWidth - baseline - inkInset;
    if (Math.abs(weightDelta) < 1e-3) {
      return sampleCompoundPath(original, n);
    }
    // A centred boundary stroke adds half its width on the ink side. Union
    // expands the glyph; Difference removes the same amount from every edge,
    // including counters, so weight remains optically consistent.
    const boundary = Skia.Path.Stroke(original, {
      width: Math.abs(weightDelta) * 2,
      cap: StrokeCap.Round,
      join: StrokeJoin.Round,
    });
    const weighted = boundary
      ? Skia.Path.MakeFromOp(
          original,
          boundary,
          weightDelta > 0 ? PathOp.Union : PathOp.Difference,
        )
      : null;
    return sampleCompoundPath(weighted ?? original, n);
  }
  return shape.contours.flatMap(contour => {
    const path = Skia.Path.MakeFromSVGString(contour.d);
    if (!path) {
      return [];
    }
    if (contour.mode === 'fill') {
      return sampleCompoundPath(path, n);
    }
    const ribbon = Skia.Path.Stroke(path, {
      width: strokeWidth,
      cap: StrokeCap.Round,
      join: StrokeJoin.Round,
    });
    return ribbon ? sampleCompoundPath(ribbon, n) : [];
  });
}

export function resolveSilhouette(
  shape: Shape,
  width: number,
  height: number,
  scale: number,
  options: ResolveShapeOptions = {},
  n = SILHOUETTE_N,
): Silhouette {
  const centerX = options.centerX ?? width / 2;
  const centerY = options.centerY ?? height / 2;
  // Exact SVG/font artwork already contains its intrinsic proportions. Its
  // centerline skeleton may still carry an optical ratio, but applying that
  // ratio to the finished silhouette would stretch the source artwork twice.
  const aspectRatio =
    options.aspectRatio ?? (shape.artwork ? 1 : shape.aspectRatio ?? 1);
  const size = Math.min(height * scale, (width * scale) / aspectRatio);
  const strokeWidth = options.strokeWidth ?? shape.strokeWidth ?? AUTHOR_STROKE;
  return {
    contours: authoredContours(
      shape,
      strokeWidth,
      n,
      options.inkInset ?? 0,
    ).map(pts =>
      placePts(pts, centerX, centerY, size, 0, aspectRatio),
    ),
  };
}

/**
 * Mean stroke thickness of a shape's ink, in authored 0..100 units. For a
 * ribbon of length L and thickness t: area ≈ t·L and boundary ≈ 2L, so
 * t ≈ 2·area/perimeter. Counters subtract from area via ring orientation.
 * Feeds weight normalization: pass a strokeWidth of
 * `baseline + (targetThickness − thickness) / 2` to resolveSilhouette.
 */
export function meanInkThickness(shape: Shape, n = SILHOUETTE_N): number {
  const rings = authoredContours(
    shape,
    shape.strokeWidth ?? AUTHOR_STROKE,
    n,
  );
  const area = Math.abs(
    rings.reduce((sum, ring) => sum + signedArea(ring), 0),
  );
  const perimeter = rings.reduce((sum, ring) => {
    let len = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return sum + len;
  }, 0);
  return perimeter > 0 ? (2 * area) / perimeter : 0;
}

function signedArea(pts: Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function largestFirst(contours: Pt[][]): Pt[][] {
  return [...contours].sort(
    (a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)),
  );
}

function collapsedLike(pts: Pt[]): Pt[] {
  const center = centroid(pts);
  return pts.map(() => ({ ...center }));
}

/** Pair/pad rings, then build two compound paths with identical verbs. */
export function buildSilhouetteTransition(
  source: Silhouette,
  target: Silhouette,
): SilhouetteTransition {
  const from = largestFirst(source.contours);
  const to = largestFirst(target.contours);
  const count = Math.max(from.length, to.length);
  const fromContours: Pt[][] = [];
  const toContours: Pt[][] = [];

  for (let i = 0; i < count; i++) {
    const sourceRing = from[i] ?? collapsedLike(to[i]);
    const targetRing = to[i] ?? collapsedLike(from[i]);
    fromContours.push(sourceRing);
    toContours.push(alignClosed(sourceRing, targetRing));
  }

  const fromPath = compoundPolygonPath(fromContours);
  const toPath = compoundPolygonPath(toContours);
  assertInterpolatable(fromPath, toPath, 'buildSilhouetteTransition');
  return {
    from: fromPath,
    to: toPath,
    out: Skia.Path.Make(),
    fromContours,
    toContours,
  };
}

export function collapsedSilhouette(target: Silhouette): Silhouette {
  return { contours: target.contours.map(collapsedLike) };
}

export function captureSilhouette(
  transition: SilhouetteTransition,
  t: number,
): Silhouette {
  return {
    contours: transition.fromContours.map((from, index) =>
      lerpPts(from, transition.toContours[index], t),
    ),
  };
}
