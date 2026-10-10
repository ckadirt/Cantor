import {
  ClipOp,
  Skia,
  type SkCanvas,
  type SkPath,
} from '@shopify/react-native-skia';
import { smootherstep } from '../field/bands';
import type {
  LensIdentity,
  LensPairMorph,
  LensPlayer,
  PlayerPaints,
} from './contract';
import type { CoverPlayer, CoverSweep } from './coverLens';
import { NAME_LENS_KNOBS, drawCircleMark, drawCirclePlayer } from './nameLens';
import { SEAL_KNOBS } from './seal';
import { drawSealAsPlayer, sealSidePx } from './sealLens';
import { circleMotionClockPoints, isCirclePlayer } from './circleMotion';
import type { MotionFrame } from './motion/motionFrame';
import { drawSealPlayer, type SealPlayer } from './sealPlayer';
import { sweepAt, sweepBandRank, sweepFront } from './sweep';

/** The seal at the mark's size, as `sealLens` draws it. */
const SEAL_MARK_SIDE_PX = sealSidePx(NAME_LENS_KNOBS.MARK_RADIUS_PX);

/*
 * The music through a lens change (reactive-player-plan.md, "Circle ↔ seal
 * mid-song"): the lens being left lets its motion go over the first half of
 * the change and the arriving lens takes its own up over the second, so the
 * morph runs between still endpoints. Both read the same frame.
 */
/** How much of the leaving lens's motion is left at `t`. */
function leavingMotion(t: number): number {
  'worklet';
  return 1 - smootherstep(Math.min(1, t * 2));
}
/** How much of the arriving lens's motion has come at `t`. */
function arrivingMotion(t: number): number {
  'worklet';
  return smootherstep(Math.max(0, t * 2 - 1));
}
/** The frame with its presence scaled by `share`, or null where nothing is left. */
function motionShare(motion: MotionFrame | null, share: number): MotionFrame | null {
  'worklet';
  if (motion === null || share <= 0) return null;
  return share >= 1 ? motion : { ...motion, presence: motion.presence * share };
}

/**
 * The circle becoming the seal, at the player.
 *
 * Every dot starts as a point on the face's contour where the circle's clock
 * stands at that dot's moment, and the contour itself is the thread; as `t`
 * runs the points walk to their cells and grow into dots, and the line becomes
 * the Peano thread (`drawSealPlayer`'s `formed`). Under it, a downloaded
 * song's filled face gives its ink back as the dots take it. One drawing
 * throughout — nothing is swapped for anything else. Run backwards, it is the
 * seal becoming the circle.
 */
function drawCircleSealMorph(
  canvas: SkCanvas,
  circle: LensIdentity,
  circlePlayer: LensPlayer | null,
  _seal: LensIdentity,
  sealPlayer: LensPlayer | null,
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
): void {
  'worklet';
  if (sealPlayer === null) return;
  const formed = smootherstep(t);
  /*
   * The dots leave a moving circle: while its motion is still going, each
   * starts on the singing contour at its moment rather than on the identity's,
   * so the change begins from the face as it stood.
   */
  let seal = sealPlayer as SealPlayer;
  const singing = motion === null ? 0 : motion.presence * arrived * leavingMotion(t);
  if (motion !== null && singing > 0 && isCirclePlayer(circlePlayer)) {
    const points = circleMotionClockPoints(circlePlayer, motion, singing, seal.order.length);
    const contourX: number[] = [];
    const contourY: number[] = [];
    for (let k = 0; k < points.length; k += 2) {
      contourX.push(points[k] / SEAL_KNOBS.SIDE_RATIO);
      contourY.push(points[k + 1] / SEAL_KNOBS.SIDE_RATIO);
    }
    seal = { ...seal, contourX, contourY };
  }
  if (fill > 0 && arrived < 1) {
    canvas.save();
    canvas.scale(size, size);
    paints.fill.setAlphaf(alpha * weight * fill * (1 - arrived) * (1 - formed));
    canvas.drawPath(circle as SkPath, paints.fill);
    canvas.restore();
  }
  // The circle's own line at the player (`drawCircleMark`), which the thread
  // carries until the seal's takes it over.
  const faceLine =
    weight + (NAME_LENS_KNOBS.SONG_FACE_ALPHA - weight) * arrived;
  drawSealPlayer(
    canvas,
    seal,
    paints,
    SEAL_MARK_SIDE_PX * size,
    alpha,
    weight + (1 - weight) * fill,
    fill,
    arrived,
    arriving,
    soundIn,
    heard,
    hairlinePx,
    formed,
    faceLine,
    0,
    motionShare(motion, arrivingMotion(t)),
  );
}

/**
 * The cover's glyphs written in along a sweep (`sweep.ts`): each band walks
 * out of its seeds and grows to its cells on its own window of `t`.
 */
function drawCoverSweep(
  canvas: SkCanvas,
  sweep: CoverSweep,
  t: number,
  size: number,
  ink: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  if (ink <= 0) return;
  canvas.save();
  canvas.scale(size, size);
  paints.stroke.setAlphaf(ink);
  paints.stroke.setStrokeWidth(hairlinePx / size);
  for (let band = 0; band < sweep.glyphs.length; band++) {
    const glyphs = sweep.glyphs[band];
    const seeds = sweep.seeds[band];
    if (glyphs === null || seeds === null) continue;
    const grown = sweepAt(t, sweepBandRank(band));
    if (grown <= 0) continue;
    const path = grown >= 1 ? glyphs : glyphs.interpolate(seeds, grown);
    if (path !== null) canvas.drawPath(path, paints.stroke);
  }
  canvas.restore();
}

/**
 * A slice of the dial from twelve o'clock, `from` to `to` in turns, clockwise,
 * reaching `radius` from the centre: what the circle's hand has passed.
 */
function dialSlice(from: number, to: number, radius: number): SkPath {
  'worklet';
  return Skia.PathBuilder.Make()
    .moveTo(0, 0)
    .arcToOval(
      Skia.XYWHRect(-radius, -radius, radius * 2, radius * 2),
      -90 + 360 * from,
      360 * (to - from),
      false,
    )
    .close()
    .detach();
}

/**
 * The circle becoming the cover, at the player.
 *
 * The picture is written in on the circle's own clock: a hand sweeps from
 * twelve, and every glyph it passes is born on the face's contour at its own
 * angle and walks out — or in — to its cell, growing as it goes, while the
 * contour behind the hand is spent. So the face unfolds both ways into the
 * picture, a moment at a time, and run backwards the glyphs fold home onto
 * the line and the hand draws it back. A song with no cover is the circle
 * under either lens, so there is nothing to change.
 */
function drawCircleCoverMorph(
  canvas: SkCanvas,
  circle: LensIdentity,
  circlePlayer: LensPlayer | null,
  _cover: LensIdentity,
  coverPlayer: LensPlayer | null,
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
): void {
  'worklet';
  // The circle as its player draws it, its motion going over the first half
  // — unless there is no picture, and the cover lens is the circle throughout.
  const cover = coverPlayer as CoverPlayer | null;
  const singing = cover === null ? motion : motionShare(motion, leavingMotion(t));
  const drawCircle = (ink: number) =>
    drawCirclePlayer(
      canvas,
      circlePlayer,
      circle,
      size,
      ink,
      weight,
      fill,
      arrived,
      arriving,
      soundIn,
      heard,
      hairlinePx,
      paints,
      singing,
    );
  if (cover === null) {
    drawCircle(alpha);
    return;
  }
  // What the cover's own player keeps of the circle until its picture rises.
  const shown = soundIn * arrived;
  const front = sweepFront(t);
  // Past the face's arriving arc, so the hand spends that too.
  const reach = NAME_LENS_KNOBS.MARK_RADIUS_PX * size * 4;
  if (front <= 0) {
    drawCircle(alpha);
  } else {
    if (front < 1) {
      canvas.save();
      canvas.clipPath(dialSlice(front, 1, reach), ClipOp.Intersect, true);
      drawCircle(alpha);
      canvas.restore();
    }
    if (shown < 1) {
      canvas.save();
      canvas.clipPath(
        dialSlice(0, Math.min(front, 0.9999), reach),
        ClipOp.Intersect,
        true,
      );
      drawCircle(alpha * (1 - shown));
      canvas.restore();
    }
  }
  drawCoverSweep(
    canvas,
    cover.fromCircle,
    t,
    size,
    alpha * shown,
    hairlinePx,
    paints,
  );
}

/**
 * The seal becoming the cover, at the player.
 *
 * The seal breaks into the picture in the order it plays: along its thread,
 * each dot shrinks away as the glyphs nearest it are born out of it and walk to
 * their cells, and the thread rewinds behind them (`drawSealPlayer`'s
 * `leaving`). Run backwards, the picture gathers back into the dust a moment
 * at a time and the thread is drawn on again. With no cover the cover lens is
 * the circle, so this is the circle-and-seal morph run the other way.
 */
function drawSealCoverMorph(
  canvas: SkCanvas,
  seal: LensIdentity,
  sealPlayer: LensPlayer | null,
  cover: LensIdentity,
  coverPlayer: LensPlayer | null,
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
): void {
  'worklet';
  const picture = coverPlayer as CoverPlayer | null;
  if (picture === null) {
    // The cover lens's identity is the circle's.
    drawCircleSealMorph(
      canvas,
      cover,
      null,
      seal,
      sealPlayer,
      1 - t,
      size,
      alpha,
      weight,
      fill,
      arrived,
      arriving,
      soundIn,
      heard,
      hairlinePx,
      paints,
      motion,
    );
    return;
  }
  drawSealAsPlayer(
    canvas,
    sealPlayer,
    seal,
    size,
    alpha,
    weight,
    fill,
    arrived,
    arriving,
    soundIn,
    heard,
    hairlinePx,
    paints,
    motionShare(motion, leavingMotion(t)),
    t,
  );
  const shown = soundIn * arrived;
  if (shown < 1) {
    // Until its picture rises the cover's player is the circle.
    drawCircleMark(
      canvas,
      cover,
      size,
      alpha * (1 - shown) * smootherstep(t),
      weight,
      fill,
      arrived,
      arriving,
      hairlinePx,
      paints,
    );
  }
  drawCoverSweep(
    canvas,
    picture.fromSeal,
    t,
    size,
    alpha * shown,
    hairlinePx,
    paints,
  );
}

/** Every hand-written player morph. A pair missing here takes the two beats. */
export const PAIR_MORPHS: readonly LensPairMorph[] = [
  { a: 'name', b: 'seal', drawPlayer: drawCircleSealMorph },
  { a: 'name', b: 'cover', drawPlayer: drawCircleCoverMorph },
  { a: 'seal', b: 'cover', drawPlayer: drawSealCoverMorph },
];
