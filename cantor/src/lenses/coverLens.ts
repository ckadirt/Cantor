import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import type { LensIdentity, LensPlayer, PlayerPaints } from './contract';
import type { CoverArt } from './cover';
import { faceClockPoints, type FaceRecipe } from './face';
import {
  NAME_LENS_KNOBS,
  circleSprites,
  drawCircleMark,
  nameLens,
} from './nameLens';
import { SEAL_KNOBS, sealModel } from './seal';
import { SEAL_MARK_SIDE_PX, sealLens, sealRimAt } from './sealLens';
import { SWEEP_KNOBS, sweepBand } from './sweep';
import type { Lens } from './types';

/** KNOBS — the cover's glyphs, in a cell's own width. */
export const COVER_LENS_KNOBS = {
  /** How far a glyph reaches from its cell's centre: air between neighbours. */
  GLYPH_REACH: 0.36,
  /** The dot, `·`: a stroke this long, so it is ink and not a speck. */
  DOT_REACH: 0.07,
  /** Where `#`'s two rails stand either side of the centre. */
  RAIL_OFFSET: 0.16,
  /**
   * The cover's side, over the seal's: the same room the dust fills, whose
   * corners the seal already keeps inside the rim.
   */
  SIDE_RATIO: 1,
} as const;

/**
 * The cover's glyphs cut into bands along a clock (`sweep.ts`), for a lens
 * change that writes the picture in a moment at a time (`lenses/pairs.ts`).
 *
 * `glyphs[band]` is the band's glyphs where they stand; `seeds[band]` is the
 * same path, verb for verb, with every point of a glyph collapsed onto the
 * place it is born — so one native `interpolate` walks a whole band out of its
 * seeds and grows it, and a frame is a draw per band rather than per glyph.
 * An empty band is null.
 */
export type CoverSweep = Readonly<{
  glyphs: readonly (SkPath | null)[];
  seeds: readonly (SkPath | null)[];
}>;

/**
 * The cover lens's player: its glyphs as one path at the mark's scale. It
 * is the lens's `sound` too — what the renderer waits for before letting the
 * picture rise (`LensPlayer`).
 *
 * `fromCircle` and `fromSeal` are the same glyphs as sweeps: born on the face's
 * contour where its clock stands at their angle, in clock order, and born out
 * of the seal's nearest dot, in the order its thread passes that dot.
 */
export type CoverPlayer = Readonly<{
  sound: SkPath;
  fromCircle: CoverSweep;
  fromSeal: CoverSweep;
}>;

const COVER_SIDE_PX = SEAL_MARK_SIDE_PX * COVER_LENS_KNOBS.SIDE_RATIO;

const COVER_PATH_CACHE_LIMIT = 16;
const coverPathCache = new Map<Uint8Array, SkPath>();

/**
 * Every cell's glyph, as its strokes: `line` once per stroke, with the centre
 * of the cell the glyph stands in. Centred on the origin, `side` wide.
 */
function eachGlyphLine(
  art: CoverArt,
  side: number,
  line: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x: number,
    y: number,
  ) => void,
): void {
  const cell = side / art.cells;
  const reach = cell * COVER_LENS_KNOBS.GLYPH_REACH;
  const rail = cell * COVER_LENS_KNOBS.RAIL_OFFSET;
  const dot = cell * COVER_LENS_KNOBS.DOT_REACH;
  for (let row = 0; row < art.cells; row += 1) {
    for (let column = 0; column < art.cells; column += 1) {
      const level = art.levels[row * art.cells + column];
      if (level === 0) continue;
      const x = -side / 2 + (column + 0.5) * cell;
      const y = -side / 2 + (row + 0.5) * cell;
      const stroke = (x0: number, y0: number, x1: number, y1: number) =>
        line(x0, y0, x1, y1, x, y);
      const minus = () => stroke(x - reach, y, x + reach, y);
      const bar = () => stroke(x, y - reach, x, y + reach);
      const cross = () => {
        stroke(x - reach, y - reach, x + reach, y + reach);
        stroke(x - reach, y + reach, x + reach, y - reach);
      };
      // `·  -  +  ×  #  *`, in order of how much line each glyph is.
      if (level === 1) stroke(x - dot, y, x + dot, y);
      else if (level === 2) minus();
      else if (level === 3) {
        minus();
        bar();
      } else if (level === 4) cross();
      else if (level === 5) {
        stroke(x - reach, y - rail, x + reach, y - rail);
        stroke(x - reach, y + rail, x + reach, y + rail);
        stroke(x - rail, y - reach, x - rail, y + reach);
        stroke(x + rail, y - reach, x + rail, y + reach);
      } else {
        minus();
        bar();
        cross();
      }
    }
  }
}

/**
 * Every cell's glyph as one path, centred on the origin, `side` wide: one
 * path because the cover is one drawing, and a thousand strokes per frame
 * would be a thousand draws.
 */
export function coverPath(art: CoverArt, side: number = COVER_SIDE_PX): SkPath {
  const cached = coverPathCache.get(art.levels);
  if (cached !== undefined && side === COVER_SIDE_PX) return cached;
  const builder = Skia.PathBuilder.Make();
  eachGlyphLine(art, side, (x0, y0, x1, y1) => {
    builder.moveTo(x0, y0);
    builder.lineTo(x1, y1);
  });
  const path = builder.detach();
  if (side === COVER_SIDE_PX) {
    if (coverPathCache.size >= COVER_PATH_CACHE_LIMIT) {
      const oldest = coverPathCache.keys().next().value;
      if (oldest !== undefined) coverPathCache.delete(oldest);
    }
    coverPathCache.set(art.levels, path);
  }
  return path;
}

/** How finely the face's contour is sampled to find where a glyph is born. */
const CONTOUR_SAMPLES = 360;

/**
 * The glyphs as a sweep: `seedOf` says, for a glyph standing at (x, y), where
 * it is born and its rank along the clock, into `out` as [x, y, rank].
 */
function coverSweep(
  art: CoverArt,
  seedOf: (x: number, y: number, out: number[]) => void,
): CoverSweep {
  const bands = SWEEP_KNOBS.BANDS;
  const glyphs = Array.from({ length: bands }, () => Skia.PathBuilder.Make());
  const seeds = Array.from({ length: bands }, () => Skia.PathBuilder.Make());
  const filled = new Array<boolean>(bands).fill(false);
  const seed = [0, 0, 0];
  let cellX = Number.NaN;
  let cellY = Number.NaN;
  eachGlyphLine(art, COVER_SIDE_PX, (x0, y0, x1, y1, x, y) => {
    // A glyph's strokes come together, so its seed is found once.
    if (x !== cellX || y !== cellY) {
      seedOf(x, y, seed);
      cellX = x;
      cellY = y;
    }
    const band = sweepBand(seed[2]);
    glyphs[band].moveTo(x0, y0);
    glyphs[band].lineTo(x1, y1);
    seeds[band].moveTo(seed[0], seed[1]);
    seeds[band].lineTo(seed[0], seed[1]);
    filled[band] = true;
  });
  return {
    glyphs: glyphs.map((builder, band) =>
      filled[band] ? builder.detach() : null,
    ),
    seeds: seeds.map((builder, band) =>
      filled[band] ? builder.detach() : null,
    ),
  };
}

/**
 * Each glyph born on the face's contour, at its own angle from the centre,
 * and ranked by where the circle's clock stands at that angle: twelve o'clock
 * first, clockwise.
 */
function sweepFromCircle(art: CoverArt, recipe: FaceRecipe): CoverSweep {
  const contour = faceClockPoints(recipe, CONTOUR_SAMPLES);
  const radius = NAME_LENS_KNOBS.MARK_RADIUS_PX;
  return coverSweep(art, (x, y, out) => {
    const turn = (Math.atan2(y, x) / (Math.PI * 2) + 1.25) % 1;
    const point = contour[Math.floor(turn * CONTOUR_SAMPLES) % CONTOUR_SAMPLES];
    out[0] = point.x * radius;
    out[1] = point.y * radius;
    out[2] = turn;
  });
}

/**
 * Each glyph born out of the seal's nearest dot at the player, and ranked by
 * where the thread passes that dot: the seal breaks into the picture in the
 * order it plays.
 */
function sweepFromSeal(art: CoverArt, recipe: FaceRecipe): CoverSweep {
  const model = sealModel(recipe);
  const deep = model.levels[SEAL_KNOBS.SONG_DEPTH];
  const count = model.order.length;
  const rank = new Array<number>(deep.x.length).fill(0);
  model.order.forEach((dot, k) => {
    rank[dot] = (k + 0.5) / count;
  });
  const side = SEAL_MARK_SIDE_PX;
  return coverSweep(art, (x, y, out) => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let dot = 0; dot < deep.x.length; dot += 1) {
      const dx = deep.x[dot] * side - x;
      const dy = deep.y[dot] * side - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = dot;
      }
    }
    out[0] = deep.x[best] * side;
    out[1] = deep.y[best] * side;
    out[2] = rank[best];
  });
}

const COVER_PLAYER_CACHE_LIMIT = 8;
const coverPlayerCache = new Map<string, CoverPlayer>();

/**
 * The cover's player for one song. Cached by song and by the cover itself: a
 * player is asked for every time the field's flights are planned, and the
 * sweeps are a few thousand strokes each.
 */
function coverPlayerOf(recipe: FaceRecipe, art: CoverArt): CoverPlayer {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${
    recipe.model
  }\u001f${recipe.durationMs}`;
  const cached = coverPlayerCache.get(key);
  if (cached !== undefined && cached.sound === coverPath(art)) return cached;
  const player: CoverPlayer = {
    sound: coverPath(art),
    fromCircle: sweepFromCircle(art, recipe),
    fromSeal: sweepFromSeal(art, recipe),
  };
  coverPlayerCache.delete(key);
  if (coverPlayerCache.size >= COVER_PLAYER_CACHE_LIMIT) {
    const oldest = coverPlayerCache.keys().next().value;
    if (oldest !== undefined) coverPlayerCache.delete(oldest);
  }
  coverPlayerCache.set(key, player);
  return player;
}

/**
 * The cover as the player: the circle grows into it exactly as it grows into
 * its own player, and once the camera has arrived the face gives way and the
 * cover writes itself in on the sound's clock (`soundIn`). A song with no
 * cover — anything a node made, a file with no picture — is the circle's
 * player, which is what it would be under the circle anyway.
 */
function drawCoverPlayer(
  canvas: SkCanvas,
  player: LensPlayer | null,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  soundIn: number,
  _heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  const cover = player === null ? null : (player as CoverPlayer).sound;
  const shown = cover === null ? 0 : soundIn * arrived;
  if (shown < 1) {
    drawCircleMark(
      canvas,
      identity,
      size,
      alpha * (1 - shown),
      weight,
      fill,
      arrived,
      arriving,
      hairlinePx,
      paints,
    );
  }
  if (cover === null || shown <= 0) return;
  canvas.save();
  canvas.scale(size, size);
  paints.stroke.setAlphaf(alpha * shown);
  paints.stroke.setStrokeWidth(hairlinePx / size);
  canvas.drawPath(cover, paints.stroke);
  canvas.restore();
}

export const coverLens: Lens = {
  key: 'cover',
  label: 'Cover',
  // Marks and rows are the circle's: a cover is one picture per album, and
  // at L0 the song's own identity is what tells a record's tracks apart.
  identity: nameLens.identity,
  player: (recipe, _analysis, cover) =>
    cover === null ? null : coverPlayerOf(recipe, cover),
  // The seal's rim is the clock and the seek; the picture inside it is not a
  // timeline, so a touch on it means nothing.
  touch: {
    reachRatio: sealLens.touch.reachRatio,
    landAt: (_recipe, dx, dy, radius) => {
      const fraction = sealRimAt(dx, dy, radius);
      return fraction === null ? null : { kind: 'seek', fraction };
    },
    seekAt: (dx, dy, radius) => sealRimAt(dx, dy, radius),
  },
  ui: {
    drawMark: drawCircleMark,
    sprites: circleSprites,
    drawPlayer: drawCoverPlayer,
    ringTicks: 0,
    hearsPlayhead: 0,
    clock: sealLens.ui.clock,
  },
};
