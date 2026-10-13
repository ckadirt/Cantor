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
import { drawCoverPlayer, type CoverPlayer, type CoverSweep } from './coverLens';
import { drawMarbleAsPlayer } from './marbleLens';
import {
  drawMarbleMorphFaded,
  drawPushedPicture,
  enterDrop,
  leaveDrop,
  marbleClipPx,
  marbleDropRadius,
  marbleSide,
  marbleUnitPx,
  type MarblePlayer,
} from './marblePlayer';
import {
  buildMarbleMorph,
  cachedMarbleMorph,
  circleRing,
  morphShares,
  pathRings,
  type MorphSide,
} from './marbleMorph';
import {
  NAME_LENS_KNOBS,
  circleLineInk,
  drawCircleBodyAt,
  drawCircleMark,
  drawCirclePlayer,
} from './nameLens';
import { SEAL_KNOBS, SEAL_PLAYER_KNOBS, sealDotRadius, sealLoudness } from './seal';
import { drawSealAsPlayer, sealSidePx } from './sealLens';
import {
  circleMotionClockPoints,
  circleMotionPoints,
  circleStillPoints,
  isCirclePlayer,
  CIRCLE_BODY_KNOBS,
} from './circleMotion';
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
/** How much of a change the circle's body keeps its ink for, before it fades. */
const BODY_HOLD = 0.3;

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
  // At full: the body, its line and the dots' starts are one shape (see the body below).
  const singing = motion === null ? 0 : motion.presence * arrived;
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
  if (isCirclePlayer(circlePlayer) && arrived > 0) {
    /*
     * The circle's body gives way as the dots leave it — still singing, at
     * full: unwinding its pose under the dots twisted a solid shape, and two
     * poses showed at once where the motion layer still held it. It keeps its
     * ink through the hand-over (`BODY_HOLD` of the change) and fades over the
     * rest, so the layer's whole body hands it over without a step.
     */
    const R = NAME_LENS_KNOBS.MARK_RADIUS_PX;
    const points =
      motion !== null && singing > 0
        ? circleMotionPoints(circlePlayer, motion, singing, R)
        : circleStillPoints(circlePlayer, R);
    drawCircleBodyAt(
      canvas,
      circlePlayer,
      points,
      size,
      alpha * (1 - smootherstep((t - BODY_HOLD) / (1 - BODY_HOLD))),
      weight,
      fill,
      arrived,
      hairlinePx,
      paints,
    );
  } else if (fill > 0 && arrived < 1) {
    canvas.save();
    canvas.scale(size, size);
    paints.fill.setAlphaf(alpha * weight * fill * (1 - arrived) * (1 - formed));
    canvas.drawPath(circle as SkPath, paints.fill);
    canvas.restore();
  }
  // The circle's own line at the player (`drawCirclePlayer`), which the thread
  // carries until the seal's takes it over.
  const faceLine = circleLineInk(weight, arrived);
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
/** A lens's own player, as `LensUi.drawPlayer` draws it. */
type PlayerDraw = (
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
  motion: MotionFrame | null,
) => void;

/**
 * Any lens becoming marbling, at the player: marbling arrives as everything
 * arrives in it, as a drop. Clear water opens at the centre carrying the
 * bath, and the other lens's player — recorded as it is drawn this frame — is
 * pushed aside by the drop's own equation, out past the bath's edge
 * (`drawPushedPicture`). Run backwards, the drop closes and the other lens
 * flows back in from the edge, so a change reversed mid-way is the same
 * frame. The leaving lens's motion goes over the first half and marbling's
 * comes over the second.
 */
function marbleArrivesOver(drawOther: PlayerDraw) {
  return (
    canvas: SkCanvas,
    other: LensIdentity,
    otherPlayer: LensPlayer | null,
    marble: LensIdentity,
    marblePlayer: LensPlayer | null,
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
  ): void => {
    'worklet';
    const clipR = marbleClipPx(size, arrived);
    const r = marbleDropRadius(t, clipR);
    const leaving = motionShare(motion, leavingMotion(t));
    if (r <= 0.01) {
      drawOther(canvas, otherPlayer, other, size, alpha, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, leaving);
    } else if (t < 1) {
      const reach = clipR * 1.25;
      const recorder = Skia.PictureRecorder();
      const target = recorder.beginRecording(Skia.XYWHRect(0, 0, reach * 2, reach * 2));
      target.translate(reach, reach);
      drawOther(target, otherPlayer, other, size, alpha, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, leaving);
      drawPushedPicture(canvas, recorder.finishRecordingAsPicture(), reach, clipR, r, alpha, paints);
    }
    if (enterDrop(canvas, r, clipR, alpha, paints)) {
      drawMarbleAsPlayer(canvas, marblePlayer, marble, size, alpha, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, motionShare(motion, arrivingMotion(t)));
      leaveDrop(canvas);
    }
  };
}

/** A lens's player as a marbling morph's side, at the player. */
type SideOf = (
  player: LensPlayer | null,
  identity: LensIdentity,
  size: number,
  arrived: number,
  soundIn: number,
  heard: number,
) => MorphSide | null;

/**
 * The seal's side: each dot in time order at its cell, as large as its sound
 * makes it, a dot heard in ink and one still to come in the grey the seal
 * draws it — `drawSealPlayer`'s dots, still.
 */
function sealSide(
  player: LensPlayer | null,
  _identity: LensIdentity,
  size: number,
  arrived: number,
  soundIn: number,
  heard: number,
): MorphSide | null {
  'worklet';
  const seal = player as SealPlayer | null;
  if (seal === null) return null;
  const side = SEAL_MARK_SIDE_PX * size;
  const s = seal.sound === null ? 0 : arrived * soundIn;
  const deep = sealDotRadius(SEAL_KNOBS.SONG_DEPTH) * side;
  const cell = side / 3 ** SEAL_KNOBS.SONG_DEPTH;
  const count = seal.order.length;
  const head = heard < 0 ? count : Math.min(Math.max(heard, 0), 1) * count;
  const rings: number[][] = [];
  const alpha: number[] = [];
  for (let k = 0; k < count; k++) {
    const dot = seal.order[k];
    let radius = deep;
    if (seal.sound !== null) {
      const loud = seal.knee === undefined ? sealLoudness(seal.sound.loudness[k] ?? 0) : seal.knee[k] ?? 0;
      const measured = (cell / 2) * (SEAL_KNOBS.SOUND_MIN_FILL + SEAL_KNOBS.SOUND_SPAN_FILL * loud);
      radius = deep + (measured - deep) * s;
    }
    rings.push(circleRing(seal.x[dot] * side, seal.y[dot] * side, radius, 12));
    alpha.push(k < head ? 1 : 1 + (SEAL_PLAYER_KNOBS.UNHEARD_ALPHA - 1) * s);
  }
  return { rings, alpha };
}

/**
 * The circle's side: its face, filled, round the paper well the clock runs in.
 * The face is its own 96 samples, kept as they are (`fixed`), so the morph can
 * take the contour the circle is drawn as each frame, singing (`circleLive`).
 * An imported song's spindle is a hairline in the well, not ink: left out.
 */
function circleSide(
  player: LensPlayer | null,
  _identity: LensIdentity,
  size: number,
  arrived: number,
): MorphSide | null {
  'worklet';
  if (!isCirclePlayer(player)) return null;
  const R = NAME_LENS_KNOBS.MARK_RADIUS_PX * size;
  const rings: number[][] = [circleStillPoints(player, R)];
  const well = NAME_LENS_KNOBS.MARK_RADIUS_PX * size * Math.max(player.spindle, CIRCLE_BODY_KNOBS.WELL_RATIO * smootherstep(arrived));
  if (well > 0.5) rings.push(circleRing(0, 0, well, 48));
  return { rings, alpha: 1, fixed: 0, depth: [0, 1] };
}

/**
 * The cover's side: its picture's strokes, each a ring of its own drawn as a
 * hairline — filled as it becomes marbling's ink, on the same moving rings.
 * Before its picture rises the cover at the player is the circle's face as a
 * hairline (`drawCircleMark` arrived), so a stroke too.
 */
function coverSide(
  player: LensPlayer | null,
  identity: LensIdentity,
  size: number,
  arrived: number,
  soundIn: number,
): MorphSide | null {
  'worklet';
  const cover = player === null ? null : (player as CoverPlayer).sound;
  if (cover !== null && soundIn * arrived >= 1) {
    return { rings: pathRings(cover, size), alpha: 1, lines: true };
  }
  const rings = pathRings(identity as SkPath, size);
  return rings.length === 0 ? null : { rings, alpha: 1, lines: true };
}

/** The circle's face as `drawCirclePlayer` draws it this frame, in px. */
function circleLive(
  player: LensPlayer | null,
  size: number,
  arrived: number,
  motion: MotionFrame | null,
): number[] | null {
  'worklet';
  if (!isCirclePlayer(player)) return null;
  const R = NAME_LENS_KNOBS.MARK_RADIUS_PX * size;
  const amount = motion === null ? 0 : motion.presence * arrived;
  return motion !== null && amount > 0 ? circleMotionPoints(player, motion, amount, R) : circleStillPoints(player, R);
}

/** No live contour: the side is still. */
function noLive(): number[] | null {
  'worklet';
  return null;
}

/**
 * Any lens becoming marbling, at the player, as a true morph: the other
 * lens's shapes — the seal's dots, the circle's face — flow ring by ring into
 * marbling's ink (`marbleMorph.ts`, the engine's silhouette morph). Each end
 * hands over to that lens's own drawing under the morph. Run backwards it is
 * marbling becoming the other lens, so a reversed change is the same frame.
 * The leaving lens's motion goes over the first half, marbling's the second.
 * Where either side has nothing to morph (no marbling model, no seal model)
 * it is the drop (`marbleArrivesOver`).
 */
function marbleMorphsWith(
  drawOther: PlayerDraw,
  sideOf: SideOf,
  kind: string,
  liveOf: (player: LensPlayer | null, size: number, arrived: number, motion: MotionFrame | null) => number[] | null = noLive,
) {
  const drop = marbleArrivesOver(drawOther);
  return (
    canvas: SkCanvas,
    other: LensIdentity,
    otherPlayer: LensPlayer | null,
    marble: LensIdentity,
    marblePlayer: LensPlayer | null,
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
  ): void => {
    'worklet';
    const m = marblePlayer as MarblePlayer | null;
    const bath = m === null || m.sound === null || soundIn <= 0 ? null : m.baked.value;
    const built = bath === null || bath.morphs === null ? null : bath.morphs.pairs[kind] ?? null;
    // The other lens as rings only where the bath's runtime built no morph:
    // a seal is hundreds of rings, not to be rebuilt every frame.
    const from = m === null || built !== null ? null : sideOf(otherPlayer, other, size, arrived, soundIn, heard);
    const fixed = built !== null ? (kind === 'circle' ? 0 : -1) : from === null ? -1 : from.fixed ?? -1;
    if (m === null || (built === null && from === null)) {
      drop(canvas, other, otherPlayer, marble, marblePlayer, t, size, alpha, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, motion);
      return;
    }
    const shares = morphShares(t);
    if (shares.from > 0) {
      drawOther(canvas, otherPlayer, other, size, alpha * shares.from, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, motionShare(motion, leavingMotion(t)));
    }
    if (shares.to > 0) {
      drawMarbleAsPlayer(canvas, m, marble, size, alpha * shares.to, weight, fill, arrived, arriving, soundIn, heard, hairlinePx, paints, motionShare(motion, arrivingMotion(t)));
    }
    if (shares.morph > 0) {
      const clipR = marbleClipPx(size, arrived);
      // Built with the bake on the bath's runtime, or here if it came without.
      const morph =
        built ??
        cachedMarbleMorph(
          `${kind}:${m.id}:${bath === null ? -1 : bath.key}:${Math.round(size * 100)}:${Math.round(soundIn * 10)}`,
          () => buildMarbleMorph(from!, marbleSide(m, size, arrived, bath), clipR),
        );
      const ink = alpha * (fill + (1 - fill) * arrived);
      const live = liveOf(otherPlayer, size, arrived, motionShare(motion, leavingMotion(t)));
      // The seal's dots grey where the song is still to come, read now.
      const seal = kind === 'seal' && built !== null ? (otherPlayer as SealPlayer | null) : null;
      const count = seal === null ? 0 : seal.order.length;
      const s = seal === null || seal.sound === null ? 0 : arrived * soundIn;
      drawMarbleMorphFaded(
        canvas,
        morph,
        t,
        ink * shares.morph,
        paints,
        clipR,
        live,
        fixed,
        1 - smootherstep(t),
        hairlinePx,
        built === null ? 1 : marbleUnitPx(size, arrived),
        seal === null ? -1 : heard < 0 ? count : Math.min(Math.max(heard, 0), 1) * count,
        1 + (SEAL_PLAYER_KNOBS.UNHEARD_ALPHA - 1) * s,
      );
    }
  };
}

export const PAIR_MORPHS: readonly LensPairMorph[] = [
  { a: 'name', b: 'seal', drawPlayer: drawCircleSealMorph },
  { a: 'name', b: 'cover', drawPlayer: drawCircleCoverMorph },
  { a: 'seal', b: 'cover', drawPlayer: drawSealCoverMorph },
  { a: 'name', b: 'marble', drawPlayer: marbleMorphsWith(drawCirclePlayer, circleSide, 'circle', circleLive) },
  { a: 'seal', b: 'marble', drawPlayer: marbleMorphsWith(drawSealAsPlayer, sealSide, 'seal') },
  { a: 'cover', b: 'marble', drawPlayer: marbleMorphsWith(drawCoverPlayer, coverSide, 'cover') },
];
