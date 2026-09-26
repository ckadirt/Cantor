import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import { NAME_LENS_KNOBS } from './nameLens';
import { ringTurnAt } from './ring';
import {
  SEAL_KNOBS,
  SEAL_PLAYER_KNOBS,
  sealDotAt,
  sealDotRadius,
  sealModel,
} from './seal';
import type {
  LensIdentity,
  LensPlayer,
  MarkPaints,
  PlayerPaints,
} from './contract';
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

/**
 * The seal lens: a song as its own Cantor dust.
 *
 * This is the picture's drawing of it, which the field falls back to where the
 * native renderer does not run. The native one — `drawFieldFaces` — draws the
 * same paths at the same sizes, and adds what only it can: the sound, the
 * thread and the bead, which answer to the clock.
 */
/**
 * The seal as a mark or a row's face: its dust at the mark's depth, as one
 * path. A song on the phone for good is filled dots, anything less is rings
 * at its weight — the face's convention, carried over.
 *
 * `arrived` is not read: the seal that grows into the player is drawn a dot at
 * a time by the renderer's player (`drawSealPlayer`), never by this.
 */
function drawSealMark(
  canvas: SkCanvas,
  identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  _arrived: number,
  hairlinePx: number,
  paints: MarkPaints,
): void {
  'worklet';
  const path = identity as SkPath;
  canvas.save();
  canvas.scale(size, size);
  if (fill > 0) {
    paints.fill.setAlphaf(alpha * fill);
    canvas.drawPath(path, paints.fill);
  }
  if (fill < 1) {
    paints.stroke.setAlphaf(alpha * weight * (1 - fill));
    paints.stroke.setStrokeWidth(hairlinePx / size);
    canvas.drawPath(path, paints.stroke);
  }
  canvas.restore();
}

/** The seal at the mark's size: every size it is drawn at is this, scaled. */
const SEAL_MARK_SIDE_PX = sealSidePx(NAME_LENS_KNOBS.MARK_RADIUS_PX);

/**
 * The seal as the player: its dust at the deepest level, the mark's dots
 * splitting into their children as it arrives, and the sound rising into it
 * once measured — see `drawSealPlayer`.
 */
function drawSealAsPlayer(
  canvas: SkCanvas,
  player: LensPlayer | null,
  _identity: LensIdentity,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  soundIn: number,
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  if (player === null) return;
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
    soundIn,
    heard,
    hairlinePx,
  );
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
  identity: recipe => sealMarkPath(recipe, SEAL_MARK_SIDE_PX),
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
