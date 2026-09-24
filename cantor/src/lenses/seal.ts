/**
 * The seal: a song's identity drawn as two-dimensional Cantor dust, and its
 * sound drawn into that same dust.
 *
 * Two layers, the way the circle is two layers. The *identity* is a pure
 * function of the recipe — the inputs `facePoints` takes — so it exists at L0
 * for every song, including the ones whose audio has never been on this phone.
 * The recipe picks which cells of a 3×3 grid survive at each of three levels
 * (the four corners is the classic dust, the ring is Sierpiński's carpet) and
 * how the whole is turned, and the three choices nest into one seal.
 *
 * The *sound* only exists once the song is loaded. The Peano curve — the
 * space-filling curve built on the same base-3 grid — orders the deepest dots
 * in time, so every dot is a slice of the song, and each slice's loudness,
 * punch and stereo width reshape its own dot. See `sealSound`.
 *
 * Geometry only: no Skia here, so the seal can be tested without a canvas.
 * Coordinates are in a unit square centred on the origin, so a caller scales by
 * the side it wants and translates to the mark.
 */

/* eslint-disable no-bitwise -- a mask is a bit field by definition, the same
   exemption `face.ts` takes for its hash. */

import { faceSeed, mulberry32, type FaceRecipe } from './face';

/** KNOBS — the seal's shape language. */
export const SEAL_KNOBS = {
  /**
   * How many of a 3×3 grid's cells a level keeps. Five to seven, so no level
   * reads as a single stroke and none as a filled square: below five a seal is
   * a scatter, above seven it is a block with a hole in it.
   */
  MIN_DOTS: 5,
  MAX_DOTS: 7,
  /** Levels drawn at L0 and L1 — two, because a third is sub-pixel there. */
  MARK_DEPTH: 2,
  /** Levels drawn at the player, where each deepest dot is a slice of sound. */
  SONG_DEPTH: 3,
  /**
   * The seal's side, over the radius of the face it stands in for.
   *
   * Chosen so the square's half-diagonal lands on the face's own furthest
   * reach, which lets the playing ring and the arriving arc keep the radius
   * `nameLensRingRadius` already gives them.
   */
  SIDE_RATIO: 1.9,
  /** A dot's diameter over its cell: air enough that neighbours stay apart. */
  DOT_FILL: 0.78,
  /*
   * The sound, per dot, once the player is here.
   */
  /** A silent slice's dot, and how much a full-scale one adds, over the cell. */
  SOUND_MIN_FILL: 0.2,
  SOUND_SPAN_FILL: 0.8,
  /**
   * How steeply loudness fills a dot: `1 − e^(−gain · rms)`, normalised. A
   * soft knee rather than a linear gain, so the loud passages of a loud song
   * stay distinct rather than all meeting the cell's edge. Eight puts a
   * generated song's typical 0.03–0.15 RMS across a quarter to three quarters
   * of the cell.
   */
  LOUDNESS_GAIN: 8,
  /**
   * How hollow a fully punchy slice is: the ring's width over its radius is
   * `1 − this`. A pad is a solid dot; a drum hit is a ring.
   */
  PUNCH_HOLLOW: 0.72,
  /** How far a fully wide slice's pair stands apart, over the dot's radius. */
  WIDTH_SPLIT: 1.05,
  /** How much smaller each of a wide pair is than the dot it split from. */
  WIDTH_SHRINK: 0.3,
} as const;

/**
 * KNOBS — the seal as a player: the thread, the bead, the rim and their clocks.
 *
 * Pixels are screen pixels at the player's own size; ratios are of the player's
 * radius, `playerRadiusPx`, the same number the circle's ring is built from.
 */
export const SEAL_PLAYER_KNOBS = {
  /** The heard part of the thread, and the rest, drawn much quieter. */
  THREAD_WIDTH_PX: 1,
  THREAD_AHEAD_ALPHA: 0.14,
  /** How firmly a dot still to come is drawn, against one already heard. */
  UNHEARD_ALPHA: 0.3,
  /** The bead riding the thread: a ring of paper with an ink edge. */
  BEAD_RADIUS_PX: 4,
  BEAD_STROKE_PX: 1.3,
  /**
   * The rim, which is the clock and the seek. Outside the seal's corners,
   * whose half-diagonal is `SIDE_RATIO · SONG_FACE_RATIO / √2` of the radius
   * (about 0.83), and inside the reach the circle's own seek listens over.
   */
  RIM_RATIO: 0.93,
  RIM_WIDTH_PX: 1,
  RIM_ALPHA: 0.16,
  RIM_HEARD_WIDTH_PX: 1.5,
  /** Twelve, three, six and nine, so the rim reads as a dial. */
  RIM_TICK_PX: 5,
  RIM_TICK_ALPHA: 0.4,
  /** Where the hand is on the rim. */
  KNOB_RADIUS_PX: 3.6,
  /**
   * How far past the rim a finger still grabs it, over the radius. Wider than
   * the circle's reach, because the rim is a thin target at the dial's edge
   * rather than the whole face.
   */
  SEEK_REACH_RATIO: 1.18,
  /** How far a tap on a dot may wander and still be a tap, in pixels. */
  TAP_SLOP_PX: 10,
  /** How long switching lens takes; one clock for both directions. */
  LENS_MORPH_MS: 420,
  /** How long the sound takes to rise into the dust once it is measured. */
  SOUND_MS: 600,
} as const;

/** One level of the seal, as parallel arrays a worklet can read. */
export type SealLevel = Readonly<{
  /** Dot centres in the unit square, origin at its centre. */
  x: readonly number[];
  y: readonly number[];
  /** Each dot's parent in the level above; -1 at the root. */
  parent: readonly number[];
}>;

export type SealModel = Readonly<{
  /** Which cells survive, one 9-bit mask per level, top level first. */
  masks: readonly number[];
  /** One of the square's eight symmetries, applied to the whole seal. */
  orientation: number;
  /** `levels[d]` is the seal at depth `d`; `levels[0]` is one dot. */
  levels: readonly SealLevel[];
  /**
   * The deepest level in time order: `order[k]` is the dot that sounds `k`-th.
   * The Peano curve's order, so consecutive dots are grid neighbours whenever
   * both survive.
   */
  order: readonly number[];
}>;

/** The eight symmetries of the square, on a grid `n` cells wide. */
function orient(
  x: number,
  y: number,
  n: number,
  orientation: number,
): [number, number] {
  let ox = x;
  let oy = y;
  if (orientation & 4) [ox, oy] = [oy, ox];
  if (orientation & 1) ox = n - 1 - ox;
  if (orientation & 2) oy = n - 1 - oy;
  return [ox, oy];
}

function bits(mask: number): number {
  let count = 0;
  for (let cell = 0; cell < 9; cell += 1) count += (mask >> cell) & 1;
  return count;
}

/**
 * Every 3×3 pattern a level may be, in a fixed order.
 *
 * Kept to the patterns with at least one mirror or rotational symmetry. A seal
 * nests three of them, and asymmetric patterns nested three deep read as noise
 * rather than as something designed; symmetric ones read as a seal however
 * they are combined.
 */
export const SEAL_MASKS: readonly number[] = (() => {
  const masks: number[] = [];
  for (let mask = 0; mask < 512; mask += 1) {
    const count = bits(mask);
    if (count < SEAL_KNOBS.MIN_DOTS || count > SEAL_KNOBS.MAX_DOTS) continue;
    const images = new Set<number>();
    for (let orientation = 0; orientation < 8; orientation += 1) {
      let image = 0;
      for (let cell = 0; cell < 9; cell += 1) {
        if (!((mask >> cell) & 1)) continue;
        const [x, y] = orient(cell % 3, Math.floor(cell / 3), 3, orientation);
        image |= 1 << (y * 3 + x);
      }
      images.add(image);
    }
    if (images.size < 8) masks.push(mask);
  }
  return masks;
})();

/** The Peano curve's rank of each cell of a 27×27 grid, indexed `y * 27 + x`. */
const PEANO_RANK: readonly number[] = (() => {
  const peano = (level: number): [number, number][] => {
    if (level === 0) return [[0, 0]];
    const sub = peano(level - 1);
    const n = 3 ** (level - 1);
    const out: [number, number][] = [];
    for (let column = 0; column < 3; column += 1) {
      const rows = column % 2 === 0 ? [0, 1, 2] : [2, 1, 0];
      for (const row of rows) {
        for (const [x, y] of sub) {
          out.push([
            column * n + (row % 2 ? n - 1 - x : x),
            row * n + (column % 2 ? n - 1 - y : y),
          ]);
        }
      }
    }
    return out;
  };
  const rank = new Array<number>(729).fill(0);
  peano(3).forEach(([x, y], index) => {
    rank[y * 27 + x] = index;
  });
  return rank;
})();

/**
 * The recipe reduced to the seal's own seed.
 *
 * `faceSeed` covers the seed, the id and the model; the duration is folded in
 * here because the face spends it on its eccentricity, and a seal that ignored
 * it would make two songs with one seed identical.
 */
export function sealSeed(recipe: FaceRecipe): number {
  const seconds = Math.round(Math.max(0, recipe.durationMs) / 1000);
  return (faceSeed(recipe) ^ Math.imul(seconds + 1, 0x9e3779b1) ^ 0x5ea1) >>> 0;
}

const SEAL_CACHE_LIMIT = 512;
const sealCache = new Map<string, SealModel>();

/** The seal for a recipe. Same recipe, same seal, on every device. */
export function sealModel(recipe: FaceRecipe): SealModel {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${recipe.model}\u001f${
    recipe.durationMs
  }`;
  const cached = sealCache.get(key);
  if (cached !== undefined) return cached;

  const random = mulberry32(sealSeed(recipe));
  const masks = [0, 1, 2].map(
    () => SEAL_MASKS[Math.floor(random() * SEAL_MASKS.length)],
  );
  const orientation = Math.floor(random() * 8);

  // Built on the unturned grid, then turned as a whole at each level so the
  // nesting survives the symmetry.
  let cells = [{ gx: 0, gy: 0, parent: -1 }];
  const levels: SealLevel[] = [];
  const grids: { gx: number; gy: number }[][] = [];
  for (let depth = 0; depth <= SEAL_KNOBS.SONG_DEPTH; depth += 1) {
    const n = 3 ** depth;
    const x: number[] = [];
    const y: number[] = [];
    const parent: number[] = [];
    const turned: { gx: number; gy: number }[] = [];
    for (const cell of cells) {
      const [ox, oy] = orient(cell.gx, cell.gy, n, orientation);
      turned.push({ gx: ox, gy: oy });
      x.push((ox + 0.5) / n - 0.5);
      y.push((oy + 0.5) / n - 0.5);
      parent.push(cell.parent);
    }
    levels.push({ x, y, parent });
    grids.push(turned);
    if (depth === SEAL_KNOBS.SONG_DEPTH) break;
    const mask = masks[depth];
    const next: { gx: number; gy: number; parent: number }[] = [];
    cells.forEach((cell, index) => {
      for (let child = 0; child < 9; child += 1) {
        if (!((mask >> child) & 1)) continue;
        next.push({
          gx: cell.gx * 3 + (child % 3),
          gy: cell.gy * 3 + Math.floor(child / 3),
          parent: index,
        });
      }
    });
    cells = next;
  }

  const deepest = grids[SEAL_KNOBS.SONG_DEPTH];
  const order = deepest
    .map((_, index) => index)
    .sort(
      (a, b) =>
        PEANO_RANK[deepest[a].gy * 27 + deepest[a].gx] -
        PEANO_RANK[deepest[b].gy * 27 + deepest[b].gx],
    );

  const model: SealModel = { masks, orientation, levels, order };
  if (sealCache.size >= SEAL_CACHE_LIMIT) {
    const oldest = sealCache.keys().next().value;
    if (oldest !== undefined) sealCache.delete(oldest);
  }
  sealCache.set(key, model);
  return model;
}

/** A dot's radius at `depth`, in the unit square the seal is drawn in. */
export function sealDotRadius(depth: number): number {
  'worklet';
  return (SEAL_KNOBS.DOT_FILL / 3 ** depth) / 2;
}

/** How much of a dot's cell a slice of `rms` fills, through the soft knee. */
export function sealLoudness(rms: number): number {
  'worklet';
  const gain = SEAL_KNOBS.LOUDNESS_GAIN;
  const clamped = rms < 0 ? 0 : rms > 1 ? 1 : rms;
  return (1 - Math.exp(-gain * clamped)) / (1 - Math.exp(-gain));
}

/** The three measures the seal draws, one entry per dot in time order. */
export type SealSound = Readonly<{
  loudness: readonly number[];
  punch: readonly number[];
  width: readonly number[];
}>;

/** A song's measurement, per slice of time, as `analyseWindow` reduces it. */
export type SealSlices = Readonly<{
  loudness: ArrayLike<number>;
  punch: ArrayLike<number>;
  width: ArrayLike<number>;
}>;

/**
 * The measurement folded onto the seal's dots.
 *
 * Dot `k` in time order covers `[k/n, (k+1)/n)` of the song, and takes the
 * mean of every slice inside it. A seal has between 125 and 343 deepest dots
 * and the analysis 729 slices, so every dot averages at least two.
 */
export function sealSound(model: SealModel, slices: SealSlices): SealSound {
  const count = model.order.length;
  const total = slices.loudness.length;
  const loudness: number[] = [];
  const punch: number[] = [];
  const width: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const from = Math.floor((k * total) / count);
    const to = Math.max(from + 1, Math.floor(((k + 1) * total) / count));
    let l = 0;
    let p = 0;
    let w = 0;
    for (let slice = from; slice < to && slice < total; slice += 1) {
      l += slices.loudness[slice] ?? 0;
      p += slices.punch[slice] ?? 0;
      w += slices.width[slice] ?? 0;
    }
    const span = Math.max(1, Math.min(to, total) - from);
    loudness.push(l / span);
    punch.push(p / span);
    width.push(w / span);
  }
  return { loudness, punch, width };
}

/**
 * The dot under a point, as its place in time — `k` of `order.length` — or
 * null for a point on no dot.
 *
 * Generous by a cell rather than by the drawn dot, because a sound-drawn dot
 * can be a fifth of its cell and a finger is not.
 */
export function sealDotAt(
  model: SealModel,
  x: number,
  y: number,
): number | null {
  const level = model.levels[SEAL_KNOBS.SONG_DEPTH];
  const cell = 1 / 3 ** SEAL_KNOBS.SONG_DEPTH;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < level.x.length; index += 1) {
    const dx = level.x[index] - x;
    const dy = level.y[index] - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  if (best < 0 || bestDistance > cell * cell) return null;
  return model.order.indexOf(best);
}

/* eslint-enable no-bitwise */
