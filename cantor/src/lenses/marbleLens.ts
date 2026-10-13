import type { SkCanvas } from '@shopify/react-native-skia';
import {
  ARRIVING_NONE,
  type LensIdentity,
  type LensPlayer,
  type PlayerPaints,
} from './contract';
import { drawMarbleMark, marbleMarkOf, marbleSprites } from './marbleMark';
import {
  bakeMarble,
  drawMarblePlayer,
  enterDrop,
  leaveDrop,
  marbleBakeKey,
  marbleClipPx,
  marbleDropRadius,
  marblePlayerOf,
  type MarblePlayer,
} from './marblePlayer';
import type { MotionFrame } from './motion/motionFrame';
import { NAME_LENS_KNOBS } from './nameLens';
import { ringTurnAt } from './ring';
import { SEAL_PLAYER_KNOBS } from './seal';
import type { Lens } from './types';

/*
 * Marbling, the third lens: suminagashi. The identity and the equations are
 * `marble.ts`, the mark `marbleMark.ts`, the sound's strokes
 * `marbleTimeline.ts` and the player `marblePlayer.ts`; this is the lens the
 * registry holds.
 */

/**
 * Where a finger on the disc points: anywhere on the bath or its rim is the
 * angle round the dial, so a drag anywhere seeks. Only the dead centre, where
 * an angle is noise, says nothing.
 */
export function marbleRimAt(
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

/**
 * Marbling as the player (`drawMarblePlayer`); without a model — a renderer
 * that built none — the mark grown, its bands filling in as the player
 * arrives, as the circle's body does.
 */
export function drawMarbleAsPlayer(
  canvas: SkCanvas,
  model: LensPlayer | null,
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
  motion: MotionFrame | null = null,
): void {
  'worklet';
  if (model !== null) {
    drawMarblePlayer(canvas, model as MarblePlayer, size, alpha, weight, fill, arrived, soundIn, heard, hairlinePx, paints, motion);
    return;
  }
  const ink = fill + (1 - fill) * arrived;
  drawMarbleMark(
    canvas,
    identity,
    size,
    alpha,
    weight + (1 - weight) * arrived,
    ink,
    arrived,
    arrived >= 1 ? ARRIVING_NONE : arriving,
    hairlinePx,
    paints,
  );
}

/**
 * The queue stepping at L2 in marbling: the next song falls in as a drop.
 * Clear water opens at the centre carrying the arriving song's bath, and
 * pushes the leaving song's — held on the music it was last drawn to
 * (`motion`), or where its playhead stood (`fromHeard`) — out past the edge
 * by the drop's own equation. At 0 it is the leaving player, at 1 the
 * arriving one, and nothing of either is ever faded over the other.
 */
export function drawMarbleMorph(
  canvas: SkCanvas,
  _aIdentity: LensIdentity,
  aPlayer: LensPlayer | null,
  bIdentity: LensIdentity,
  bPlayer: LensPlayer | null,
  t: number,
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
  motion: MotionFrame | null = null,
  fromHeard = -1,
): void {
  'worklet';
  if (arrived <= 0 || aPlayer === null || bPlayer === null) {
    drawMarbleAsPlayer(canvas, bPlayer, bIdentity, size, alpha, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints);
    return;
  }
  const clipR = marbleClipPx(size, arrived);
  const r = marbleDropRadius(t, clipR);
  if (t < 1) {
    drawMarblePlayer(
      canvas,
      aPlayer as MarblePlayer,
      size,
      alpha,
      weight,
      fill,
      arrived,
      1,
      motion === null ? fromHeard : motion.head,
      hairlinePx,
      paints,
      motion,
      r,
    );
  }
  if (enterDrop(canvas, r, clipR, alpha, paints)) {
    drawMarblePlayer(canvas, bPlayer as MarblePlayer, size, alpha, weight, fill, arrived, soundIn, heard, hairlinePx, paints, null);
    leaveDrop(canvas);
  }
}

export const marbleLens: Lens = {
  key: 'marble',
  label: 'Marbling',
  preview: true,
  identity: marbleMarkOf,
  player: marblePlayerOf,
  bake: bakeMarble,
  touch: {
    reachRatio: SEAL_PLAYER_KNOBS.SEEK_REACH_RATIO,
    landAt: (_recipe, dx, dy, radius) => {
      const fraction = marbleRimAt(dx, dy, radius);
      return fraction === null ? null : { kind: 'seek', fraction };
    },
    seekAt: (dx, dy, radius) => marbleRimAt(dx, dy, radius),
  },
  ui: {
    drawMark: drawMarbleMark,
    sprites: marbleSprites,
    drawPlayer: drawMarbleAsPlayer,
    morphPlayer: drawMarbleMorph,
    bakeKey: marbleBakeKey,
    ringTicks: 0,
    hearsPlayhead: 1,
    // The seal's rim: a dial round the bath, its form outside it.
    clock: {
      ratio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      heardWidthPx: SEAL_PLAYER_KNOBS.RIM_HEARD_WIDTH_PX,
      handInnerRatio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      handOuterRatio: SEAL_PLAYER_KNOBS.RIM_RATIO,
      handWidthPx: NAME_LENS_KNOBS.CLOCK_HAND_WIDTH_PX,
      rimAlpha: SEAL_PLAYER_KNOBS.RIM_ALPHA,
      rimWidthPx: SEAL_PLAYER_KNOBS.RIM_WIDTH_PX,
      tickAlpha: SEAL_PLAYER_KNOBS.RIM_TICK_ALPHA,
      tickPx: SEAL_PLAYER_KNOBS.RIM_TICK_PX,
      knobRadiusPx: SEAL_PLAYER_KNOBS.KNOB_RADIUS_PX,
      formOnClock: 1,
    },
  },
};
