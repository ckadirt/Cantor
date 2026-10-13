import {
  FillType,
  Skia,
  type SkCanvas,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  ARRIVING_HELD_ALPHA,
  ARRIVING_NONE,
  arrivedShare,
  isArrivingHeld,
  type LensIdentity,
  type MarkPaints,
  type MarkSprites,
} from './contract';
import type { FaceRecipe } from './face';
import {
  applyMarbleOp,
  marbleIdentity,
  type MarbleOp,
  type MarbleSurface,
} from './marble';
import { NAME_LENS_KNOBS } from './nameLens';

/** KNOBS — marbling as a mark, and the room it takes. */
export const MARBLE_LENS_KNOBS = {
  /**
   * How far the furthest ink reaches at the mark, over the face's radius.
   * Inside `FACE_MAX_EXTENT` (1.37), so the playing ring and the arrival's
   * ring clear it as they clear the circle's lobes; a disc reads larger than a
   * lobed contour of the same reach, so this is under it.
   */
  MARK_REACH_RATIO: 1.25,
  /**
   * Its outlines, over the hairline. A bath has many rings in 19 px, so at a
   * full hairline the cached look holds nearly the ink of the filled one and
   * the two read alike; thinner lines keep downloaded clearly the darker
   * (`availability.test.ts` asks 1.3×).
   */
  LINE_RATIO: 0.6,
} as const;

/** Marbling's reach at the mark, in pixels: every size it is drawn at is this, scaled. */
export const MARBLE_MARK_REACH_PX =
  NAME_LENS_KNOBS.MARK_RADIUS_PX * MARBLE_LENS_KNOBS.MARK_REACH_RATIO;

/**
 * Marbling's identity at mark size, for the UI thread: every ring as one path
 * of outlines, the ink as one even-odd path, and the plain numbers to land the
 * recipe a drop at a time while it downloads.
 */
export type MarbleMark = Readonly<{
  /** Every ring's outline: the mark of a song on the node, or cached. */
  outline: SkPath;
  /** The ink, even-odd: the bands of a song on the phone for good. */
  ink: SkPath;
  /** The recipe's ops, to replay part of them while it downloads. */
  ops: readonly MarbleOp[];
  /** From the bath's units to pixels at the mark's size. */
  scale: number;
}>;

/** A bath's rings as one path, scaled: every ring, or only the ink's toggles. */
export function marbleRingsPath(
  surface: MarbleSurface,
  scale: number,
  inkOnly: boolean,
): SkPath {
  'worklet';
  const builder = Skia.PathBuilder.Make();
  if (inkOnly) builder.setFillType(FillType.EvenOdd);
  for (const ring of surface.rings) {
    if (inkOnly && !ring.toggle) continue;
    const pts = ring.pts;
    builder.moveTo(pts[0] * scale, pts[1] * scale);
    for (let i = 2; i < pts.length; i += 2) {
      builder.lineTo(pts[i] * scale, pts[i + 1] * scale);
    }
    builder.close();
  }
  return builder.detach();
}

const MARK_CACHE_LIMIT = 512;
const markCache = new Map<string, MarbleMark>();

export function marbleMarkOf(recipe: FaceRecipe): MarbleMark {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${
    recipe.model
  }\u001f${recipe.durationMs}\u001f${recipe.imported === true ? 'i' : ''}`;
  const cached = markCache.get(key);
  if (cached !== undefined) return cached;
  const identity = marbleIdentity(recipe);
  const scale = MARBLE_MARK_REACH_PX / identity.reach;
  const mark: MarbleMark = {
    outline: marbleRingsPath(identity.surface, scale, false),
    ink: marbleRingsPath(identity.surface, scale, true),
    ops: identity.ops,
    scale,
  };
  if (markCache.size >= MARK_CACHE_LIMIT) {
    const oldest = markCache.keys().next().value;
    if (oldest !== undefined) markCache.delete(oldest);
  }
  markCache.set(key, mark);
  return mark;
}

/**
 * The recipe landing as its bytes do: its ops replayed up to `share` of the
 * way, the last one part landed — the drops falling one by one and the
 * strokes drawn. A handful of ops on a few rings, so cheap enough per frame.
 */
function landedPath(mark: MarbleMark, share: number): SkPath {
  'worklet';
  const surface: MarbleSurface = { rings: [] };
  const k = share * mark.ops.length;
  for (let index = 0; index < mark.ops.length && index < k; index += 1) {
    applyMarbleOp(surface, mark.ops[index], Math.min(1, k - index));
  }
  return marbleRingsPath(surface, mark.scale, false);
}

/** The look a mark is stamped or drawn in: its outlines, its ink over them, or both. */
function drawMarbleLook(
  canvas: SkCanvas,
  mark: MarbleMark,
  lineAlpha: number,
  inkAlpha: number,
  hairlinePx: number,
  size: number,
  paints: MarkPaints,
): void {
  'worklet';
  if (inkAlpha > 0) {
    paints.fill.setAlphaf(inkAlpha);
    canvas.drawPath(mark.ink, paints.fill);
  }
  if (lineAlpha > 0) {
    paints.stroke.setAlphaf(lineAlpha);
    paints.stroke.setStrokeWidth(
      (hairlinePx * MARBLE_LENS_KNOBS.LINE_RATIO) / size,
    );
    canvas.drawPath(mark.outline, paints.stroke);
  }
}

/**
 * Marbling as stamps, one per look: its rings outlined (a song on the node,
 * or cached), and its bands filled (one kept on the phone). A download, or an
 * ink between the two, is drawn by `drawMarbleMark`.
 */
export const marbleSprites: MarkSprites = {
  layers: 2,
  reach: () => {
    'worklet';
    return MARBLE_MARK_REACH_PX;
  },
  drawLayer: (canvas, identity, layer, size, hairlinePx, paints) => {
    'worklet';
    const mark = identity as MarbleMark;
    canvas.save();
    canvas.scale(size, size);
    drawMarbleLook(canvas, mark, 1, layer === 1 ? 1 : 0, hairlinePx, size, paints);
    canvas.restore();
  },
  alphas: (alpha, weight, fill, arriving, out) => {
    'worklet';
    if (arriving !== ARRIVING_NONE) return false;
    if (fill <= 0) {
      out[0] = alpha * weight;
      out[1] = 0;
      return true;
    }
    if (fill >= 1 && weight >= 1) {
      out[0] = 0;
      out[1] = alpha;
      return true;
    }
    return false;
  },
};

/**
 * Marbling as a mark or a row's face, in the circle's reading: a song on the
 * node is its rings in grey, a cached one the same rings in ink, and one on
 * the phone for good has its bands filled. A download lands the recipe drop by
 * drop in ink over the grey rings it will become.
 */
export function drawMarbleMark(
  canvas: SkCanvas,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  _arrived: number,
  arriving: number,
  hairlinePx: number,
  paints: MarkPaints,
): void {
  'worklet';
  const mark = identity as MarbleMark;
  canvas.save();
  canvas.scale(size, size);
  if (arriving !== ARRIVING_NONE) {
    drawMarbleLook(canvas, mark, alpha * weight, 0, hairlinePx, size, paints);
    const share = arrivedShare(arriving);
    if (share > 0) {
      // A stopped download keeps what landed, faint: it is waiting, not here.
      paints.stroke.setAlphaf(
        alpha * (isArrivingHeld(arriving) ? ARRIVING_HELD_ALPHA : 1),
      );
      paints.stroke.setStrokeWidth(
      (hairlinePx * MARBLE_LENS_KNOBS.LINE_RATIO) / size,
    );
      canvas.drawPath(landedPath(mark, share), paints.stroke);
    }
  } else {
    drawMarbleLook(
      canvas,
      mark,
      alpha * weight,
      alpha * weight * fill,
      hairlinePx,
      size,
      paints,
    );
  }
  canvas.restore();
}
