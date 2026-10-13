import type { SongAnalysis } from './analysis';
import { CIRCLE_BODY_KNOBS } from './circleMotion';
import type { CoverArt } from './cover';
import { coverPlayerOf } from './coverLens';
import { FACE_KNOBS, facePoints, type FaceRecipe } from './face';
import { MARBLE_MARK_REACH_PX } from './marbleMark';
import { circleRing, pathRings, type MorphSide } from './marbleMorph';
import { NAME_LENS_KNOBS, nameLensFacePath } from './nameLens';
import { SEAL_KNOBS, sealDotRadius, sealLoudness } from './seal';
import { SEAL_MARK_SIDE_PX } from './sealLens';
import { sealPlayerOf } from './sealPlayer';

/**
 * The other lenses as marbling's morphs see them: plain rings, in the bath's
 * own unit — px over `MARBLE_MARK_REACH_PX × GROW × size`, which is what a
 * bath's rings over its extent are too — so the bath runtime can build every
 * morph between them off the drawing threads (`marbleBath.ts`), and one built
 * once is right at any size. Each is the lens as its player stands at L2.
 */

/** Built once per song, on the JS thread, and sent with the bath. */
export type MarbleSides = Readonly<{
  seal: MorphSide;
  circle: MorphSide;
  cover: MorphSide;
}>;

/** px of a lens at size 1, over the bath's unit at size 1. */
function unit(grow: number): number {
  return 1 / (MARBLE_MARK_REACH_PX * grow);
}

/** The seal's dots at their cells, sized by their sound, each with its place in time. */
function sealSideOf(recipe: FaceRecipe, analysis: SongAnalysis | undefined, u: number): MorphSide {
  const seal = sealPlayerOf(recipe, analysis);
  const side = SEAL_MARK_SIDE_PX * u;
  const deep = sealDotRadius(SEAL_KNOBS.SONG_DEPTH) * side;
  const cell = side / 3 ** SEAL_KNOBS.SONG_DEPTH;
  const rings: number[][] = [];
  const order: number[] = [];
  seal.order.forEach((dot, k) => {
    let radius = deep;
    if (seal.sound !== null) {
      const loud = seal.knee === undefined ? sealLoudness(seal.sound.loudness[k] ?? 0) : seal.knee[k] ?? 0;
      radius = (cell / 2) * (SEAL_KNOBS.SOUND_MIN_FILL + SEAL_KNOBS.SOUND_SPAN_FILL * loud);
    }
    rings.push(circleRing(seal.x[dot] * side, seal.y[dot] * side, radius, 12));
    order.push(k);
  });
  return { rings, alpha: 1, order };
}

/** The circle's face (its still samples, the fixed ring the singing contour replaces) and its well. */
function circleSideOf(recipe: FaceRecipe, u: number): MorphSide {
  const r = NAME_LENS_KNOBS.MARK_RADIUS_PX * u;
  const face: number[] = [];
  for (const point of facePoints(recipe, FACE_KNOBS.SAMPLES)) face.push(point.x * r, point.y * r);
  const spindle = recipe.imported === true ? NAME_LENS_KNOBS.SPINDLE_RATIO : 0;
  const well = r * Math.max(spindle, CIRCLE_BODY_KNOBS.WELL_RATIO);
  return { rings: [face, circleRing(0, 0, well, 48)], alpha: 1, depth: [0, 1], fixed: 0 };
}

/** The cover's strokes, or without a cover the circle's face as a hairline (as the cover then is). */
function coverSideOf(recipe: FaceRecipe, art: CoverArt | null, u: number): MorphSide {
  const path = art === null ? nameLensFacePath(recipe) : coverPlayerOf(recipe, art).sound;
  return { rings: pathRings(path, u), alpha: 1, lines: true };
}

export function marbleSidesOf(
  recipe: FaceRecipe,
  analysis: SongAnalysis | undefined,
  cover: CoverArt | null,
  grow: number,
): MarbleSides {
  const u = unit(grow);
  return {
    seal: sealSideOf(recipe, analysis, u),
    circle: circleSideOf(recipe, u),
    cover: coverSideOf(recipe, cover, u),
  };
}
