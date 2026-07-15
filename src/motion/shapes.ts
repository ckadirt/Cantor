/**
 * The authoring contract for engine shapes. A Shape is a handful of contours
 * in a 0..100 box; each contour is a single SVG path (one contour — validated
 * in dev, not tribal knowledge). Two modes:
 *
 *  - 'stroke': a thin centerline drawn with stroke paint (round caps). Open or
 *    closed — closed loops are fine now, there is no ribbon step to double them.
 *  - 'fill': a closed outline drawn filled — note heads, dots, beams.
 *
 * resolveShape() turns a Shape into placed, sampled canvas geometry; that's the
 * only input the transition builder needs.
 */
import { Skia } from '@shopify/react-native-skia';
import { N, placePts, samplePathString, type Pt } from './geometry';

export type ContourMode = 'stroke' | 'fill';

export type Contour = {
  d: string;
  mode: ContourMode;
};

export type Shape = {
  name: string;
  contours: Contour[];
  /** Optional exact compound silhouette used when the motion settles. */
  artwork?: { d: string };
  /** Centerline thickness in the 0..100 authoring box. */
  strokeWidth?: number;
  /** Optical width / height. The default authoring box is square. */
  aspectRatio?: number;
};

/** Default centerline thickness in authoring units (scales with placement). */
export const AUTHOR_STROKE = 3.0;

/** A contour resolved into canvas space — the transition builder's currency. */
export type ContourGeom = {
  pts: Pt[]; // N points; first == last when closed
  closed: boolean;
  mode: ContourMode;
  width: number; // stroke width in dp (0 for fills)
  alpha: number;
};

export type ResolveShapeOptions = {
  /** Per-instance optical width / height override. */
  aspectRatio?: number;
  /** Per-instance stroke thickness in authoring units. */
  strokeWidth?: number;
  /** Destination centre in canvas pixels; defaults to the canvas centre. */
  centerX?: number;
  centerY?: number;
};

/** Dev-time validation: fail loudly at author time, not mid-morph. */
export function validateShape(shape: Shape): void {
  if (!__DEV__) {
    return;
  }
  if ((shape.aspectRatio ?? 1) <= 0) {
    throw new Error(`shape "${shape.name}": aspectRatio must be positive`);
  }
  if ((shape.strokeWidth ?? AUTHOR_STROKE) <= 0) {
    throw new Error(`shape "${shape.name}": strokeWidth must be positive`);
  }
  shape.contours.forEach((c, i) => {
    const path = Skia.Path.MakeFromSVGString(c.d);
    if (!path) {
      throw new Error(`shape "${shape.name}" contour ${i}: unparseable path`);
    }
    const it = Skia.ContourMeasureIter(path, false, 1);
    let count = 0;
    while (it.next()) {
      count++;
    }
    if (count !== 1) {
      throw new Error(
        `shape "${shape.name}" contour ${i}: has ${count} contours — author one per string`,
      );
    }
    if (c.mode === 'fill') {
      const s = samplePathString(c.d);
      if (!s.closed) {
        throw new Error(
          `shape "${shape.name}" contour ${i}: fill contours must close (add Z or touch endpoints)`,
        );
      }
    }
  });
}

const validated = new Set<string>();

/**
 * Sample and place a shape into a canvas region. Fills sort first so they draw
 * under strokes, and so geoms stay mode-grouped across capture/rebuild cycles.
 */
export function resolveShape(
  shape: Shape,
  width: number,
  height: number,
  scale: number,
  n = N,
  options: ResolveShapeOptions = {},
): ContourGeom[] {
  if (!validated.has(shape.name)) {
    validateShape(shape);
    validated.add(shape.name);
  }
  const cx = options.centerX ?? width / 2;
  const cy = options.centerY ?? height / 2;
  const aspectRatio = options.aspectRatio ?? shape.aspectRatio ?? 1;
  if (aspectRatio <= 0) {
    throw new Error(
      `shape "${shape.name}": resolved aspectRatio must be positive`,
    );
  }
  // `size` is the authored height. Cap it by both canvas axes so wide and
  // narrow symbols retain their optical ratio without clipping.
  const size = Math.min(height * scale, (width * scale) / aspectRatio);
  const strokeDp =
    ((options.strokeWidth ?? shape.strokeWidth ?? AUTHOR_STROKE) * size) / 100;
  const geoms = shape.contours.map((c): ContourGeom => {
    const s = samplePathString(c.d, n);
    return {
      pts: placePts(s.pts, cx, cy, size, 0, aspectRatio),
      closed: s.closed,
      mode: c.mode,
      width: c.mode === 'stroke' ? strokeDp : 0,
      alpha: 1,
    };
  });
  return [
    ...geoms.filter(g => g.mode === 'fill'),
    ...geoms.filter(g => g.mode === 'stroke'),
  ];
}
