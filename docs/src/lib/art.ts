/**
 * The site's art: the app's own geometry, imported from `cantor/src`, so a
 * page's seal is the seal the app would draw for the same recipe. Nothing
 * here draws anything the app does not; it only puts the shapes in SVG.
 *
 * Pure, so it runs at build time (static SVG, no JavaScript) and in the
 * browser (the live marbling, the playing seal).
 */
import {
  FACE_MAX_EXTENT,
  facePoints,
  hash,
  type FaceRecipe,
} from '../../../cantor/src/lenses/face';
import { SEAL_KNOBS, sealModel } from '../../../cantor/src/lenses/seal';
import { marbleIdentityOpsFrom, marbleRandom } from '../../../cantor/src/lenses/marble';
import { station } from '../../../cantor/src/marks/station';
import { phoneSeal } from '../../../cantor/src/marks/seal';

/**
 * A page's recipe: its name stands in for a song's seed and id, and folds a
 * length of two to five minutes in, as a song's duration would.
 */
export function recipeOf(name: string): FaceRecipe {
  const seed = hash(name);
  return { seed, id: name, model: 'cantorfm', durationMs: (120 + (seed % 180)) * 1000 };
}

const n = (value: number) => +value.toFixed(4);

export type SealDot = { x: number; y: number; r: number; k: number };

/**
 * A seal's dots in a unit box centred on 0. `depth` 2 is the mark, 3 the
 * player's dust; `k` is each dot's place in the song's time order.
 */
export function sealDots(name: string, depth = SEAL_KNOBS.SONG_DEPTH): SealDot[] {
  const model = sealModel(recipeOf(name));
  const level = model.levels[depth];
  const r = (SEAL_KNOBS.DOT_FILL / 3 ** depth) / 2;
  const rank = new Array<number>(level.x.length);
  if (depth === SEAL_KNOBS.SONG_DEPTH) model.order.forEach((dot, k) => (rank[dot] = k));
  return level.x.map((x, i) => ({ x: n(x), y: n(level.y[i]), r: n(r), k: rank[i] ?? i }));
}

/** The circle's contour as a path, radius 1 at its furthest reach. */
export function facePath(name: string, samples = 240): string {
  const scale = 1 / FACE_MAX_EXTENT;
  const pts = facePoints(recipeOf(name), samples);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${n(p.x * scale)} ${n(p.y * scale)}`).join('') + 'Z';
}

/** A node's station from its key and how many models it holds. */
export function stationMark(publicKey: string, models: number) {
  const s = station(publicKey, models);
  return {
    outline: s.outline.map((p, i) => `${i ? 'L' : 'M'}${n(p[0])} ${n(p[1])}`).join(''),
    dots: s.dots.map(([x, y]) => ({ x: n(x), y: n(y) })),
  };
}

/** A phone's seal from its key: spokes round a dot. */
export function phoneMark(publicKey: string) {
  return phoneSeal(publicKey).spokes.map(([[x1, y1], [x2, y2]]) => ({
    x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2),
  }));
}

/** What a museum card would print under a page's marbling. */
export function marbleCaption(name: string) {
  const recipe = recipeOf(name);
  const ops = marbleIdentityOpsFrom(marbleRandom(recipe), 8);
  const drops = ops.filter((op) => op.kind === 'drop').length;
  return {
    seed: (recipe.seed ?? 0).toString(16).padStart(8, '0'),
    drops,
    combs: ops.length - drops,
    seconds: recipe.durationMs / 1000,
  };
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
