import type { MotionFrame } from './motion/motionFrame';
import {
  PathOp,
  Skia,
  type SkCanvas,
  type SkPath,
} from '@shopify/react-native-skia';
import { smootherstep } from '../field/bands';
import { NAME_LENS_KNOBS } from './nameLens';
import { ringTurnAt } from './ring';
import {
  SEAL_FILLED_GROW,
  SEAL_KNOBS,
  SEAL_PLAYER_KNOBS,
  sealDotAt,
  sealDotRadius,
  sealMarkRanks,
  sealModel,
} from './seal';
import {
  ARRIVING_HELD_ALPHA,
  ARRIVING_NONE,
  isArrivingHeld,
  arrivedShare,
  type LensIdentity,
  type LensPlayer,
  type MarkPaints,
  type MarkSprites,
  type PlayerPaints,
} from './contract';
import type { FaceRecipe } from './face';
import { drawSealPlayer, sealPlayerOf, type SealPlayer } from './sealPlayer';
import type { Lens, LensSong } from './types';

/**
 * The seal's side for a face drawn at `radius`.
 *
 * Every size the seal is drawn at is the face's own size through this one
 * ratio, so the seal and the circle occupy the same room at every level and
 * switching lens never moves the field.
 */
export function sealSidePx(radius: number): number {
  'worklet';
  return radius * SEAL_KNOBS.SIDE_RATIO;
}

const SEAL_PATH_CACHE_LIMIT = 512;
const sealPathCache = new Map<string, SkPath>();

/**
 * The seal as one path: every dot at `depth`, centred on the origin.
 *
 * One path per song rather than a circle per dot, because at L0 the whole field
 * is drawn every frame — a few hundred seals of up to forty-nine dots each is
 * twenty thousand draws as circles and a few hundred as paths. Built once per
 * recipe and size, then translated, exactly as the face's contour is.
 */
export function sealMarkPath(
  song: Pick<LensSong, 'seed' | 'id' | 'model' | 'durationMs'>,
  side: number,
  depth: number = SEAL_KNOBS.MARK_DEPTH,
): SkPath {
  const key = `${song.seed ?? ''}\u001f${song.id}\u001f${song.model}\u001f${
    song.durationMs
  }\u001f${side}\u001f${depth}`;
  const cached = sealPathCache.get(key);
  if (cached !== undefined) return cached;
  const level = sealModel(song).levels[depth];
  const radius = sealDotRadius(depth) * side;
  const builder = Skia.PathBuilder.Make();
  for (let index = 0; index < level.x.length; index += 1) {
    builder.addCircle(level.x[index] * side, level.y[index] * side, radius);
  }
  const path = builder.detach();
  if (sealPathCache.size >= SEAL_PATH_CACHE_LIMIT) {
    const oldest = sealPathCache.keys().next().value;
    if (oldest !== undefined) sealPathCache.delete(oldest);
  }
  sealPathCache.set(key, path);
  return path;
}

/** The seal at the mark's size: every size it is drawn at is this, scaled. */
export const SEAL_MARK_SIDE_PX = sealSidePx(NAME_LENS_KNOBS.MARK_RADIUS_PX);

/**
 * The seal's identity at mark size: its dots as two cached paths — as they are
 * and as they are when the song is on the phone for good — and the plain
 * numbers to build anything in between on the UI thread: each dot's centre, in
 * pixels at the mark's size, and its rank along the thread.
 */
export type SealMark = Readonly<{
  dots: SkPath;
  filled: SkPath;
  x: readonly number[];
  y: readonly number[];
  /** Each dot's place in time: where its first child falls on the thread. */
  rank: readonly number[];
  radius: number;
  /**
   * The imported marker's ring, as a radius at the mark's size; 0 for a
   * generated song. `dots` and `filled` already have its clearing cut out.
   */
  spindle: number;
}>;

const SEAL_MARK_CACHE_LIMIT = 512;
const sealMarkCache = new Map<string, SealMark>();

export function sealMarkOf(recipe: FaceRecipe): SealMark {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${
    recipe.model
  }\u001f${recipe.durationMs}\u001f${recipe.imported === true ? 'i' : ''}`;
  const cached = sealMarkCache.get(key);
  if (cached !== undefined) return cached;
  const level = sealModel(recipe).levels[SEAL_KNOBS.MARK_DEPTH];
  const side = SEAL_MARK_SIDE_PX;
  const radius = sealDotRadius(SEAL_KNOBS.MARK_DEPTH) * side;
  const x = Array.from(level.x, value => value * side);
  const y = Array.from(level.y, value => value * side);
  const at = (grow: number) => {
    const builder = Skia.PathBuilder.Make();
    for (let index = 0; index < x.length; index += 1) {
      builder.addCircle(x[index], y[index], radius * grow);
    }
    return builder.detach();
  };
  const spindle =
    recipe.imported === true
      ? NAME_LENS_KNOBS.MARK_RADIUS_PX * NAME_LENS_KNOBS.SPINDLE_RATIO
      : 0;
  const mark: SealMark = {
    dots: cleared(sealMarkPath(recipe, side), spindle),
    filled: cleared(at(SEAL_FILLED_GROW), spindle),
    x,
    y,
    rank: sealMarkRanks(recipe),
    radius,
    spindle,
  };
  if (sealMarkCache.size >= SEAL_MARK_CACHE_LIMIT) {
    const oldest = sealMarkCache.keys().next().value;
    if (oldest !== undefined) sealMarkCache.delete(oldest);
  }
  sealMarkCache.set(key, mark);
  return mark;
}

/** The dust with the spindle's clearing cut out of it, or as it is. */
function cleared(dust: SkPath, spindle: number): SkPath {
  if (spindle <= 0) return dust;
  const disc = Skia.PathBuilder.Make()
    .addCircle(0, 0, spindle * SEAL_KNOBS.SPINDLE_CLEAR)
    .detach();
  return Skia.Path.MakeFromOp(dust, disc, PathOp.Difference) ?? dust;
}

/**
 * The imported marker's ring, over whatever the seal drew: a hairline at any
 * size. The clearing it stands in is in the cached paths; while a download
 * builds the dust dot by dot (never, for an imported song) the ring is drawn
 * alone.
 */
function drawSealSpindle(
  canvas: SkCanvas,
  mark: SealMark,
  alpha: number,
  hairlinePx: number,
  size: number,
  paints: MarkPaints,
): void {
  'worklet';
  if (mark.spindle <= 0 || alpha <= 0) return;
  paints.stroke.setAlphaf(alpha);
  paints.stroke.setStrokeWidth(hairlinePx / size);
  canvas.drawCircle(0, 0, mark.spindle, paints.stroke);
}

/**
 * The seal as stamps, one per look: its dots with the spindle (a song on the
 * node), and its filled dots with the spindle (one kept on the phone). A
 * download, an ink between the two, or a filled mark whose spindle is fainter
 * than its dots, is drawn by `drawSealMark`.
 */
const sealSprites: MarkSprites = {
  layers: 2,
  reach: identity => {
    'worklet';
    const mark = identity as SealMark;
    const bounds = mark.filled.computeTightBounds();
    return Math.max(
      Math.abs(bounds.x),
      Math.abs(bounds.y),
      Math.abs(bounds.x + bounds.width),
      Math.abs(bounds.y + bounds.height),
      mark.spindle,
    );
  },
  drawLayer: (canvas, identity, layer, size, hairlinePx, paints) => {
    'worklet';
    const mark = identity as SealMark;
    canvas.save();
    canvas.scale(size, size);
    paints.fill.setAlphaf(1);
    canvas.drawPath(layer === 0 ? mark.dots : mark.filled, paints.fill);
    drawSealSpindle(canvas, mark, 1, hairlinePx, size, paints);
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
 * The seal as a mark or a row's face, keeping the circle's reading in its own
 * form: a song on the node is small grey dots, a cached one the same dots in
 * ink, and one on the phone for good has its dots grown until they merge — the
 * dust as one solid glyph, the seal's filled face. Fills only: at mark size a
 * dot is smaller than a hairline, so a ring would be a bigger blob, not an
 * outline.
 *
 * A download fills the dust in along its own thread: every dot whose moment
 * has landed is drawn as downloaded, the rest as on the node.
 *
 * `arrived` is not read: the seal that grows into the player is drawn a dot at
 * a time by `drawSealPlayer`, which starts from exactly this.
 */
function drawSealMark(
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
  const mark = identity as SealMark;
  canvas.save();
  canvas.scale(size, size);
  if (arriving !== ARRIVING_NONE) {
    const landed = arrivedShare(arriving) * mark.rank.length;
    const done = Skia.PathBuilder.Make();
    const rest = Skia.PathBuilder.Make();
    for (let index = 0; index < mark.x.length; index += 1) {
      if (mark.rank[index] < landed) {
        done.addCircle(
          mark.x[index],
          mark.y[index],
          mark.radius * SEAL_FILLED_GROW,
        );
      } else {
        rest.addCircle(mark.x[index], mark.y[index], mark.radius);
      }
    }
    paints.fill.setAlphaf(alpha * weight);
    canvas.drawPath(rest.detach(), paints.fill);
    // A stopped download keeps what landed, faint: it is waiting, not here.
    paints.fill.setAlphaf(
      alpha * (isArrivingHeld(arriving) ? ARRIVING_HELD_ALPHA : 1),
    );
    canvas.drawPath(done.detach(), paints.fill);
  } else if (fill <= 0) {
    paints.fill.setAlphaf(alpha * weight);
    canvas.drawPath(mark.dots, paints.fill);
  } else if (fill >= 1) {
    paints.fill.setAlphaf(alpha);
    canvas.drawPath(mark.filled, paints.fill);
  } else {
    // A download landing: the dots grow and darken on the ink's own clock.
    const grow = 1 + (SEAL_FILLED_GROW - 1) * fill;
    const builder = Skia.PathBuilder.Make();
    for (let index = 0; index < mark.x.length; index += 1) {
      builder.addCircle(mark.x[index], mark.y[index], mark.radius * grow);
    }
    paints.fill.setAlphaf(alpha * (weight + (1 - weight) * fill));
    canvas.drawPath(builder.detach(), paints.fill);
  }
  drawSealSpindle(canvas, mark, alpha * weight, hairlinePx, size, paints);
  canvas.restore();
}

/**
 * The seal as the player: its dust at the deepest level, the mark's dots
 * splitting into their children as it arrives, and the sound rising into it
 * once measured — see `drawSealPlayer`. `leaving` is the seal giving way to
 * the cover along its thread, which takes the spindle with it.
 */
export function drawSealAsPlayer(
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
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
  _motion: MotionFrame | null = null,
  leaving = 0,
): void {
  'worklet';
  if (player === null) return;
  const mark = identity as SealMark;
  drawSealPlayer(
    canvas,
    player as SealPlayer,
    paints,
    SEAL_MARK_SIDE_PX * size,
    alpha,
    // A dot's ink: its outline's weight, filling to full as the song is kept.
    weight + (1 - weight) * fill,
    fill,
    arrived,
    arriving,
    soundIn,
    heard,
    hairlinePx,
    1,
    0,
    leaving,
  );
  // The spindle leaves as the player arrives, its clearing filling back in
  // with the dust: at `arrived` 0 this is the mark exactly.
  const away = (1 - arrived) * (1 - smootherstep(leaving));
  if (mark.spindle > 0 && away > 0) {
    canvas.save();
    canvas.scale(size, size);
    paints.paper.setAlphaf(alpha * away);
    canvas.drawCircle(0, 0, mark.spindle * SEAL_KNOBS.SPINDLE_CLEAR, paints.paper);
    drawSealSpindle(canvas, mark, alpha * away * weight, hairlinePx, size, paints);
    canvas.restore();
  }
}

/** The seal's rim under a finger: the circle's dead centre, a longer reach. */
export function sealRimAt(
  dx: number,
  dy: number,
  radius: number,
): number | null {
  'worklet';
  return ringTurnAt(
    dx,
    dy,
    radius * NAME_LENS_KNOBS.CLOCK_SEEK_DEAD_RATIO,
    radius * SEAL_PLAYER_KNOBS.SEEK_REACH_RATIO,
  );
}

export const sealLens: Lens = {
  key: 'seal',
  label: 'Seal',
  // The dust at the mark's size, the face's own room through `sealSidePx`.
  identity: sealMarkOf,
  player: sealPlayerOf,
  /*
   * The seal keeps the circle's gesture and moves it outward: its clock is a
   * rim around the dust, so a drag that starts off the dust is the same angle,
   * measured the same way. A drag across the dust cannot be a scrub — the
   * Peano order walks smoothly through space as time passes, but two
   * neighbouring dots can be a third of the song apart — so a touch that
   * starts on the dust is a tap: it jumps to the dot under the finger.
   */
  touch: {
    reachRatio: SEAL_PLAYER_KNOBS.SEEK_REACH_RATIO,
    landAt: (recipe, dx, dy, radius) => {
      const side = sealSidePx(radius * NAME_LENS_KNOBS.SONG_FACE_RATIO);
      if (Math.abs(dx) <= side / 2 && Math.abs(dy) <= side / 2) {
        const model = sealModel(recipe);
        const dot = sealDotAt(model, dx / side, dy / side);
        return {
          kind: 'tap',
          fraction: dot === null ? null : dot / model.order.length,
        };
      }
      const fraction = sealRimAt(dx, dy, radius);
      return fraction === null ? null : { kind: 'seek', fraction };
    },
    seekAt: (dx, dy, radius) => sealRimAt(dx, dy, radius),
  },
  ui: {
    drawMark: drawSealMark,
    sprites: sealSprites,
    drawPlayer: drawSealAsPlayer,
    ringTicks: 0,
    hearsPlayhead: 1,
    clock: {
      ratio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      heardWidthPx: SEAL_PLAYER_KNOBS.RIM_HEARD_WIDTH_PX,
      // No hand: both ends on the rim, where the knob stands instead.
      handInnerRatio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      handOuterRatio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      handWidthPx: NAME_LENS_KNOBS.CLOCK_HAND_WIDTH_PX,
      rimAlpha: SEAL_PLAYER_KNOBS.RIM_ALPHA,
      rimWidthPx: SEAL_PLAYER_KNOBS.RIM_WIDTH_PX,
      tickAlpha: SEAL_PLAYER_KNOBS.RIM_TICK_ALPHA,
      tickPx: SEAL_PLAYER_KNOBS.RIM_TICK_PX,
      knobRadiusPx: SEAL_PLAYER_KNOBS.KNOB_RADIUS_PX,
    },
  },
};
