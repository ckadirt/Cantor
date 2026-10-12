import { PointMode, Skia, type SkCanvas, type SkPicture, type SkPoint } from '@shopify/react-native-skia';
import type { SongAnalysis } from './analysis';
import { ARRIVING_NONE, arrivedShare, type PlayerPaints } from './contract';
import { faceClockPoints, type FaceRecipe } from './face';
import {
  SEAL_FILLED_GROW,
  SEAL_KNOBS,
  SEAL_PLAYER_KNOBS,
  sealDotRadius,
  sealLoudness,
  sealMarkRanks,
  sealModel,
  sealSound,
  type SealSound,
} from './seal';
import { sweepAt, sweepFront } from './sweep';
import type { MotionFrame } from './motion/motionFrame';
import {
  SEAL_MOTION_KNOBS,
  drawSealWeave,
  sealMotionOf,
  sealMotionRadius,
} from './sealMotion';

/*
 * The seal as the player: the one song the camera is in, drawn a dot at a
 * time. Moved here from `FieldCanvas` at R6d (see the rewrite log) so the seal
 * is one lens behind the contract; the drawing is unchanged, down to the
 * pixel (`lensGoldens.test.ts`).
 *
 * `contourX`/`contourY` are the circle's, not the seal's: they are where each
 * dot starts when the player morphs from the circle (`lenses/pairs.ts`).
 * Carried here because this model is built once for the one song in the
 * player, and the morph is the one thing that reads them.
 */

/**
 * The seal as the player draws it: both of its deepest levels, and the sound.
 *
 * Plain arrays, because a worklet cannot hold the model's own objects any more
 * than a typed array. Built for one face at a time — the player — so its cost
 * is one song's, not the field's.
 */
export type SealPlayer = Readonly<{
  /** Depth 2, the mark's dots, in the unit square. */
  markX: readonly number[];
  markY: readonly number[];
  /** Depth 3, the player's dots, and which mark dot each grew out of. */
  x: readonly number[];
  y: readonly number[];
  parent: readonly number[];
  /** Depth 3 in time order. */
  order: readonly number[];
  /**
   * The face's contour in the same unit square, one point per dot in time
   * order, where the circle's clock stands at that dot's moment. The lens
   * morph walks each dot out of this point; see `faceClockPoints`.
   */
  contourX: readonly number[];
  contourY: readonly number[];
  /** Each mark dot's place in time (`sealMarkRanks`), and how many there are. */
  markRank: readonly number[];
  /**
   * Per dot in time order: its mark dot (the page's cluster) and its depth-1
   * cell (a ninth), and each ninth's centre in the unit square — what the
   * music moves the seal by (`sealMotion.ts`).
   */
  cluster: readonly number[];
  ninth: readonly number[];
  ninthX: readonly number[];
  ninthY: readonly number[];
  /** Null until the song has been measured: identity only. */
  sound: SealSound | null;
  /** Each dot's loudness through the soft knee (`sealLoudness`), worked out once. */
  knee?: readonly number[];
}>;

export function sealPlayerOf(
  recipe: FaceRecipe,
  analysis: SongAnalysis | undefined,
): SealPlayer {
  const model = sealModel(recipe);
  const mark = model.levels[SEAL_KNOBS.MARK_DEPTH];
  const deep = model.levels[SEAL_KNOBS.SONG_DEPTH];
  const slices = analysis?.measured ? analysis.slices : null;
  // The face is drawn at a radius and the seal at `SIDE_RATIO` times it, so a
  // contour point over that ratio is in the seal's own unit square.
  const contour = faceClockPoints(recipe, model.order.length);
  return {
    markX: mark.x,
    markY: mark.y,
    x: deep.x,
    y: deep.y,
    parent: deep.parent,
    order: model.order,
    contourX: contour.map(point => point.x / SEAL_KNOBS.SIDE_RATIO),
    contourY: contour.map(point => point.y / SEAL_KNOBS.SIDE_RATIO),
    markRank: sealMarkRanks(recipe),
    cluster: model.order.map(dot => deep.parent[dot]),
    ninth: model.order.map(dot => mark.parent[deep.parent[dot]]),
    ninthX: model.levels[1].x,
    ninthY: model.levels[1].y,
    ...soundOf(model, slices ?? null),
  };
}

function soundOf(
  model: ReturnType<typeof sealModel>,
  slices: SongAnalysis['slices'],
): { sound: SealSound | null; knee?: readonly number[] } {
  if (slices === null) return { sound: null };
  const sound = sealSound(model, slices);
  return { sound, knee: sound.loudness.map(sealLoudness) };
}

/**
 * The moving seal's thread at rest, recorded once rather than drawn a segment
 * at a time every frame: the whole of it quiet, and the heard part, which
 * changes only when the playhead reaches the next dot. One for the one player
 * that moves, on the runtime that draws it.
 */
type ThreadPictures = {
  key: string;
  ahead: SkPicture | null;
  last: number;
  behind: SkPicture | null;
};

function threadPictures(): ThreadPictures {
  'worklet';
  const g = globalThis as unknown as { __cantorSealThread?: ThreadPictures };
  if (g.__cantorSealThread === undefined) {
    g.__cantorSealThread = { key: '', ahead: null, last: -2, behind: null };
  }
  return g.__cantorSealThread;
}

/**
 * The seal as the player: the dust at its deepest, and the song inside it.
 *
 * Drawn a dot at a time rather than from the cached path, because every dot
 * moves on its own here. As the player arrives (`arrived`) each mark dot splits
 * into the dots it holds — they start stacked on their parent at the parent's
 * size and walk out to their own cells — so the seal deepens by the same
 * construction that made it. At `arrived = 0` every child sits on its parent at
 * the parent's radius, which is the cached mark path to the pixel: the row
 * hands over to the player with nothing to see.
 *
 * Then the sound, which only a measured song has, rises into the dust
 * (`sound`): each dot takes the loudness of its slice as its size, its punch as
 * how hollow it is, and its width as how far it splits into a pair. The Peano
 * thread runs through the dots in time order, inked behind the bead.
 *
 * `formed` is the lens morph: at 0 this is the circle's face, at 1 the seal.
 * Every dot starts as a point on the face's contour where the circle's clock
 * stands at that dot's moment, and the contour itself is the thread — a closed
 * line through those points in time order. As `formed` runs the points walk to
 * their cells and grow into dots, the line becomes the Peano thread, and the
 * segment that closed it shrinks into the last dot. One drawing throughout;
 * nothing is swapped for anything else. `lineAlpha` is the face's own ink,
 * which the line carries until the seal's thread takes it over.
 *
 * `leaving` is the seal giving way to the cover (`lenses/pairs.ts`), along
 * its own thread: each dot shrinks to nothing on its moment's window of the
 * change (`sweepAt`), and the thread rewinds from its start behind them.
 *
 * A dot is a fill: a ring is its outer circle wound one way and its inner
 * circle the other, so the fill's winding cuts the hole, and a solid dot has no
 * inner circle. One primitive for every state, so none of these transitions has
 * to swap one drawing for another.
 */
export function drawSealPlayer(
  canvas: SkCanvas,
  seal: SealPlayer,
  paints: PlayerPaints,
  side: number,
  opacity: number,
  weight: number,
  /** 1 filled, 0 outlined, and in between while a download lands. */
  fill: number,
  arrived: number,
  /** The download; see `ARRIVING_NONE`. */
  arriving: number,
  soundProgress: number,
  heard: number,
  /** The line width on screen: the field's hairline. */
  hairlinePx: number,
  formed = 1,
  lineAlpha = 0,
  leaving = 0,
  motion: MotionFrame | null = null,
): void {
  'worklet';
  const knobs = SEAL_KNOBS;
  const player = SEAL_PLAYER_KNOBS;
  const sound = seal.sound;
  const s = sound === null ? 0 : arrived * soundProgress;
  // The thread and the bead belong to the seal, so they arrive with it.
  const threadInk = s * formed;
  const lineInk = lineAlpha * (1 - formed);
  const markRadius = sealDotRadius(knobs.MARK_DEPTH) * side;
  const deepRadius = sealDotRadius(knobs.SONG_DEPTH) * side;
  const identityRadius =
    (markRadius + (deepRadius - markRadius) * arrived) * formed;
  const cell = side / 3 ** knobs.SONG_DEPTH;
  const count = seal.order.length;
  const head = heard < 0 ? -1 : Math.min(Math.max(heard, 0), 1) * count;
  // No motion to draw is no motion at all: the still player, drawn as it always was.
  const moved =
    motion === null || s <= 0 || motion.presence <= 0
      ? null
      : sealMotionOf(motion, motion.presence * s, seal.cluster, seal.ninth, head);
  const pull = moved === null ? 0 : moved.pull;
  /** How much of the `k`-th dot is left as the seal gives way. */
  const stayAt = (k: number): number =>
    leaving <= 0 ? 1 : 1 - sweepAt(leaving, (k + 0.5) / count);
  // The thread starts at the first dot not yet gone.
  const first = leaving <= 0 ? 0 : Math.ceil(sweepFront(leaving) * count);
  /*
   * How kept each dot is. The whole song's `fill`, unless a download is
   * landing: then a dot is kept once its mark parent's moment has landed —
   * the same dots, at the same moment, as the mark fills in (`drawSealMark`),
   * so the row hands over to the player with nothing to see.
   */
  const landed =
    arriving === ARRIVING_NONE
      ? -1
      : arrivedShare(arriving) * seal.markRank.length;
  const keptAt = (k: number): number =>
    landed < 0
      ? fill
      : seal.markRank[seal.parent[seal.order[k]]] < landed
      ? 1
      : 0;
  /*
   * A dot's radius and solidity. At the mark (`arrived` 0) every dot is solid
   * and a kept one is grown until the dots merge — exactly the mark. At the
   * player a kept dot is solid at its own size and the rest are hairline
   * rings, which there are big enough to read as outlines.
   */
  const grownAt = (kept: number): number =>
    identityRadius * (1 + (SEAL_FILLED_GROW - 1) * kept * (1 - arrived));
  const solidityAt = (kept: number): number => 1 - arrived * (1 - kept);
  /** The `k`-th dot in time order, on its way from the contour to its cell. */
  const at = (k: number, axis: 0 | 1): number => {
    const dot = seal.order[k];
    const own = axis === 0 ? seal.x[dot] : seal.y[dot];
    const parent = seal.parent[dot];
    const from = axis === 0 ? seal.markX[parent] : seal.markY[parent];
    const cellAt = from + (own - from) * arrived;
    const contour = axis === 0 ? seal.contourX[k] : seal.contourY[k];
    const place = contour + (cellAt - contour) * formed;
    if (pull <= 0) return place * side;
    // A drop gathers each ninth toward its own centre.
    const ninth = seal.ninth[k];
    const centre = axis === 0 ? seal.ninthX[ninth] : seal.ninthY[ninth];
    return (place + (centre - place) * pull) * side;
  };
  /*
   * A moving seal is drawn every frame, and there it is drawn in pieces the
   * GPU draws by itself: a circle per dot, the threads as runs of straight
   * segments. One path holding every dot, or the whole thread, is anti-aliased
   * on the CPU and uploaded anew whenever it changes — free for a still seal,
   * recorded once, and 37 % of the UI thread for a moving one (simpleperf,
   * Xiaomi). Each dot's place is worked out once a frame, here.
   */
  const gpu = moved !== null;
  const xs: number[] = [];
  const ys: number[] = [];
  if (gpu) {
    for (let k = 0; k < count; k++) {
      xs.push(at(k, 0));
      ys.push(at(k, 1));
    }
  }
  const px = (k: number): number => (gpu ? xs[k] : at(k, 0));
  const py = (k: number): number => (gpu ? ys[k] : at(k, 1));

  if (threadInk > 0 || lineInk > 0) {
    // The thread, under the dots: the whole of it quiet, the heard part inked.
    const last = Math.floor(head);
    const line = (points: SkPoint[]) => {
      if (points.length < 2) return;
      if (gpu) {
        canvas.drawPoints(PointMode.Polygon, points, paints.stroke);
        return;
      }
      const builder = Skia.PathBuilder.Make();
      builder.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) builder.lineTo(points[i].x, points[i].y);
      canvas.drawPath(builder.detach(), paints.stroke);
    };
    const width = hairlinePx + (player.THREAD_WIDTH_PX - hairlinePx) * formed;
    const aheadAlpha = opacity * (lineInk + threadInk * player.THREAD_AHEAD_ALPHA);
    const behindAlpha = opacity * threadInk;
    paints.stroke.setStrokeWidth(width);
    // Moving, but where it stands: the thread is the same from frame to frame.
    const still = gpu && pull <= 0 && formed >= 1 && first === 0;
    if (still) {
      const cache = threadPictures();
      const key = `${count}|${side}|${xs[0]}|${ys[0]}|${xs[count - 1]}|${ys[count - 1]}|${width}|${aheadAlpha}|${behindAlpha}`;
      const record = (from: number, to: number, alpha: number): SkPicture => {
        const recorder = Skia.PictureRecorder();
        const target = recorder.beginRecording(Skia.XYWHRect(-side, -side, side * 2, side * 2));
        const points: SkPoint[] = [];
        for (let k = from; k <= to; k++) points.push({ x: xs[k], y: ys[k] } as SkPoint);
        paints.stroke.setAlphaf(alpha);
        target.drawPoints(PointMode.Polygon, points, paints.stroke);
        return recorder.finishRecordingAsPicture();
      };
      if (cache.key !== key) {
        cache.key = key;
        cache.ahead = record(0, count - 1, aheadAlpha);
        cache.last = -2;
        cache.behind = null;
      }
      if (cache.ahead !== null) canvas.drawPicture(cache.ahead);
      if (threadInk > 0 && last >= 0) {
        if (cache.last !== last) {
          cache.last = last;
          cache.behind = last >= 1 ? record(0, Math.min(last, count - 1), behindAlpha) : null;
        }
        if (cache.behind !== null) canvas.drawPicture(cache.behind);
        if (last < count - 1) {
          const f = head - last;
          paints.stroke.setAlphaf(behindAlpha);
          canvas.drawLine(
            xs[last],
            ys[last],
            xs[last] + (xs[last + 1] - xs[last]) * f,
            ys[last] + (ys[last + 1] - ys[last]) * f,
            paints.stroke,
          );
        }
      }
    } else {
      const ahead: SkPoint[] = [];
      const behind: SkPoint[] = [];
      for (let k = first; k < count; k++) {
        const point = { x: px(k), y: py(k) } as SkPoint;
        ahead.push(point);
        if (k <= last) behind.push(point);
      }
      if (formed < 1 && count > 1) {
        // The face was closed and the thread is not: the closing segment's far
        // end slides back along it into the last dot.
        const firstX = px(0);
        const firstY = py(0);
        ahead.push({
          x: firstX + (px(count - 1) - firstX) * formed,
          y: firstY + (py(count - 1) - firstY) * formed,
        } as SkPoint);
      }
      if (last >= first && last < count - 1) {
        const f = head - last;
        behind.push({
          x: px(last) + (px(last + 1) - px(last)) * f,
          y: py(last) + (py(last + 1) - py(last)) * f,
        } as SkPoint);
      }
      paints.stroke.setAlphaf(aheadAlpha);
      line(ahead);
      if (last >= first && threadInk > 0) {
        paints.stroke.setAlphaf(behindAlpha);
        line(behind);
      }
    }
    if (moved !== null && motion !== null && threadInk > 0 && leaving <= 0) {
      drawSealWeave(
        canvas,
        motion,
        moved.amount,
        count,
        head,
        xs,
        ys,
        paints.stroke,
        paints.paper,
        opacity * threadInk,
      );
    }
  }

  if (s <= 0) {
    /*
     * The opening: one path per ink and one draw each — the kept dots and the
     * rest, which differ only while a download is landing.
     *
     * This runs on every frame of the descent, and it is the whole cost of the
     * seal while the camera moves — a draw per dot here was three or four JSI
     * calls each, a few hundred times a frame, and the flight dropped frames
     * the circle's single cached contour never did.
     */
    if (identityRadius <= 0) return;
    const kept = Skia.PathBuilder.Make();
    const rest = Skia.PathBuilder.Make();
    for (let k = 0; k < count; k++) {
      const keep = keptAt(k);
      const stay = stayAt(k);
      if (stay <= 0) continue;
      const outer = grownAt(keep) * stay;
      const stroke = hairlinePx + (outer - hairlinePx) * solidityAt(keep);
      const inner = outer - stroke;
      const target = landed >= 0 && keep >= 1 ? kept : rest;
      target.addCircle(px(k), py(k), outer);
      if (inner > 0.05) target.addCircle(px(k), py(k), inner, true);
    }
    paints.fill.setAlphaf(opacity * weight);
    canvas.drawPath(rest.detach(), paints.fill);
    if (landed >= 0) {
      paints.fill.setAlphaf(opacity);
      canvas.drawPath(kept.detach(), paints.fill);
    }
    return;
  }

  /*
   * The sound: two fills, the heard dots and the rest, rather than a draw per
   * dot. A wide slice is two dots side by side.
   */
  const heardDots = Skia.PathBuilder.Make();
  const aheadDots = Skia.PathBuilder.Make();
  /** Moving, each dot as `x, y, outer, inner`, heard and ahead; see `gpu`. */
  const heardRings: number[] = [];
  const aheadRings: number[] = [];
  for (let k = 0; k < count; k++) {
    const stay = stayAt(k);
    if (stay <= 0) continue;
    const x = px(k);
    const y = py(k);
    const keep = keptAt(k);
    // From the dot the opening draws, so leaving the song (the sound still
    // inked as the camera carries it out) meets the opening where it takes over.
    const grown = grownAt(keep);
    let radius = grown;
    let punch = 0;
    let width = 0;
    if (sound !== null) {
      const loud =
        seal.knee === undefined ? sealLoudness(sound.loudness[k] ?? 0) : seal.knee[k] ?? 0;
      const measured =
        sealMotionRadius(
          (cell / 2) * (knobs.SOUND_MIN_FILL + knobs.SOUND_SPAN_FILL * loud),
          moved === null ? 1 : moved.mul[k],
          cell,
        ) * formed;
      radius = grown + (measured - grown) * s;
      const hollow = moved === null ? 0 : moved.hollow[k];
      const split = moved === null ? 0 : moved.split[k];
      punch = Math.min(1, (sound.punch[k] ?? 0) + hollow) * s;
      width = Math.min(1, (sound.width[k] ?? 0) + split) * s;
    }
    // Identity: a filled dot, or a hairline ring for a song not kept here —
    // and a ring thickening into a dot while a download lands.
    const identityStroke =
      hairlinePx + (radius - hairlinePx) * solidityAt(keep);
    const soundStroke = radius * (1 - knobs.PUNCH_HOLLOW * punch);
    const stroke = identityStroke + (soundStroke - identityStroke) * s;
    const outer =
      Math.max(0.01, radius * (1 - knobs.WIDTH_SHRINK * width)) * stay;
    const inner = outer - stroke * stay;
    const isHeard = head < 0 || k < head;
    const target = isHeard ? heardDots : aheadDots;
    const rings = isHeard ? heardRings : aheadRings;
    const addDot = (cx: number) => {
      if (gpu) {
        rings.push(cx, y, outer, inner);
        return;
      }
      target.addCircle(cx, y, outer);
      if (inner > 0.05) target.addCircle(cx, y, inner, true);
    };
    if (width > 0.02) {
      const offset = width * radius * knobs.WIDTH_SPLIT;
      addDot(x - offset);
      addDot(x + offset);
    } else {
      addDot(x);
    }
  }
  /*
   * A dot as the GPU draws it: solid, a filled circle; hollow, a stroked one
   * whose stroke covers the same ring the path's winding cuts. Its grey is
   * the ink mixed with the paper rather than laid on at an alpha, so where a
   * wide slice's pair overlaps it does not darken, as one path's fill does
   * not; only the player's own fade is an alpha.
   */
  const inkColour = paints.fill.getColor();
  const paperColour = paints.paper.getColor();
  const rings = (list: number[], ink: number) => {
    const a = ink < 0 ? 0 : ink > 1 ? 1 : ink;
    const colour = Float32Array.of(
      paperColour[0] + (inkColour[0] - paperColour[0]) * a,
      paperColour[1] + (inkColour[1] - paperColour[1]) * a,
      paperColour[2] + (inkColour[2] - paperColour[2]) * a,
      opacity,
    );
    paints.fill.setColor(colour);
    paints.stroke.setColor(colour);
    for (let i = 0; i < list.length; i += 4) {
      const outer = list[i + 2];
      const inner = list[i + 3];
      if (inner > 0.05) {
        paints.stroke.setStrokeWidth(outer - inner);
        canvas.drawCircle(list[i], list[i + 1], (outer + inner) / 2, paints.stroke);
      } else {
        canvas.drawCircle(list[i], list[i + 1], outer, paints.fill);
      }
    }
  };
  const heardInk = weight + (1 - weight) * s;
  const aheadInk = weight + (player.UNHEARD_ALPHA - weight) * s;
  if (gpu) {
    const strokeColour = paints.stroke.getColor();
    rings(heardRings, heardInk);
    rings(aheadRings, aheadInk);
    paints.fill.setColor(inkColour);
    paints.stroke.setColor(strokeColour);
  } else {
    paints.fill.setAlphaf(opacity * heardInk);
    canvas.drawPath(heardDots.detach(), paints.fill);
    paints.fill.setAlphaf(opacity * aheadInk);
    canvas.drawPath(aheadDots.detach(), paints.fill);
  }

  if (threadInk > 0 && head >= 0) {
    // The bead: where the song is, on the thread.
    const k = Math.min(count - 1, Math.floor(head));
    const next = Math.min(count - 1, k + 1);
    const f = head - k;
    const bx = px(k) + (px(next) - px(k)) * f;
    const by = py(k) + (py(next) - py(k)) * f;
    const beadInk = threadInk * stayAt(k);
    if (moved !== null && moved.ghosts.length > 0 && leaving <= 0) {
      // Where a section heard before first played: a ghost of the bead.
      paints.stroke.setAlphaf(opacity * threadInk * moved.amount * SEAL_MOTION_KNOBS.GHOST_ALPHA);
      paints.stroke.setStrokeWidth(SEAL_MOTION_KNOBS.GHOST_STROKE_PX);
      for (let i = 0; i < moved.ghosts.length; i++) {
        const g = moved.ghosts[i];
        const gk = Math.min(count - 1, Math.floor(g));
        const gn = Math.min(count - 1, gk + 1);
        const gf = g - gk;
        canvas.drawCircle(
          px(gk) + (px(gn) - px(gk)) * gf,
          py(gk) + (py(gn) - py(gk)) * gf,
          player.BEAD_RADIUS_PX,
          paints.stroke,
        );
      }
    }
    paints.paper.setAlphaf(opacity * beadInk);
    canvas.drawCircle(bx, by, player.BEAD_RADIUS_PX, paints.paper);
    paints.stroke.setAlphaf(opacity * beadInk);
    paints.stroke.setStrokeWidth(player.BEAD_STROKE_PX);
    canvas.drawCircle(bx, by, player.BEAD_RADIUS_PX, paints.stroke);
  }
}

/**
 * One seal's dots as the player draws them, worked out for a step's morph
 * (`drawSealStep`): `drawSealPlayer`'s numbers at `formed` 1 and `leaving` 0,
 * per dot in time order — its centre, its outer and inner radius (0 is
 * solid), how far a wide slice's pair stands apart, its ink against the
 * paper — and the thread's.
 */
type SealStepDots = {
  x: number[];
  y: number[];
  outer: number[];
  inner: number[];
  offset: number[];
  ink: number[];
  /** Each dot's cell on the deepest grid, `gy * 27 + gx`. */
  cell: number[];
  head: number;
  threadInk: number;
  moved: ReturnType<typeof sealMotionOf> | null;
};

function sealStepDots(
  seal: SealPlayer,
  side: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  /** How far the sound is in (`drawSealPlayer`'s `s`): 0 for an unmeasured song. */
  s: number,
  heard: number,
  hairlinePx: number,
  motion: MotionFrame | null,
): SealStepDots {
  'worklet';
  const knobs = SEAL_KNOBS;
  const sound = seal.sound;
  const markRadius = sealDotRadius(knobs.MARK_DEPTH) * side;
  const deepRadius = sealDotRadius(knobs.SONG_DEPTH) * side;
  const identityRadius = markRadius + (deepRadius - markRadius) * arrived;
  const n = 3 ** knobs.SONG_DEPTH;
  const cell = side / n;
  const count = seal.order.length;
  const head = heard < 0 ? -1 : Math.min(Math.max(heard, 0), 1) * count;
  const moved =
    motion === null || s <= 0 || motion.presence <= 0
      ? null
      : sealMotionOf(motion, motion.presence * s, seal.cluster, seal.ninth, head);
  const pull = moved === null ? 0 : moved.pull;
  const landed =
    arriving === ARRIVING_NONE ? -1 : arrivedShare(arriving) * seal.markRank.length;
  const heardInk = weight + (1 - weight) * s;
  const aheadInk = weight + (SEAL_PLAYER_KNOBS.UNHEARD_ALPHA - weight) * s;
  const out: SealStepDots = {
    x: [],
    y: [],
    outer: [],
    inner: [],
    offset: [],
    ink: [],
    cell: [],
    head,
    threadInk: s,
    moved,
  };
  for (let k = 0; k < count; k++) {
    const dot = seal.order[k];
    const parent = seal.parent[dot];
    let px = seal.markX[parent] + (seal.x[dot] - seal.markX[parent]) * arrived;
    let py = seal.markY[parent] + (seal.y[dot] - seal.markY[parent]) * arrived;
    if (pull > 0) {
      const ninth = seal.ninth[k];
      px += (seal.ninthX[ninth] - px) * pull;
      py += (seal.ninthY[ninth] - py) * pull;
    }
    out.x.push(px * side);
    out.y.push(py * side);
    out.cell.push(
      Math.round((seal.y[dot] + 0.5) * n - 0.5) * n + Math.round((seal.x[dot] + 0.5) * n - 0.5),
    );
    const keep =
      landed < 0 ? fill : seal.markRank[parent] < landed ? 1 : 0;
    const grown = identityRadius * (1 + (SEAL_FILLED_GROW - 1) * keep * (1 - arrived));
    const solidity = 1 - arrived * (1 - keep);
    if (s <= 0 || sound === null) {
      const stroke = hairlinePx + (grown - hairlinePx) * solidity;
      out.outer.push(grown);
      out.inner.push(Math.max(0, grown - stroke));
      out.offset.push(0);
      out.ink.push(landed >= 0 && keep >= 1 ? 1 : weight);
      continue;
    }
    const loud = seal.knee === undefined ? sealLoudness(sound.loudness[k] ?? 0) : seal.knee[k] ?? 0;
    const measured = sealMotionRadius(
      (cell / 2) * (knobs.SOUND_MIN_FILL + knobs.SOUND_SPAN_FILL * loud),
      moved === null ? 1 : moved.mul[k],
      cell,
    );
    const radius = grown + (measured - grown) * s;
    const punch = Math.min(1, (sound.punch[k] ?? 0) + (moved === null ? 0 : moved.hollow[k])) * s;
    const width = Math.min(1, (sound.width[k] ?? 0) + (moved === null ? 0 : moved.split[k])) * s;
    const identityStroke = hairlinePx + (radius - hairlinePx) * solidity;
    const soundStroke = radius * (1 - knobs.PUNCH_HOLLOW * punch);
    const stroke = identityStroke + (soundStroke - identityStroke) * s;
    const outer = Math.max(0.01, radius * (1 - knobs.WIDTH_SHRINK * width));
    out.outer.push(outer);
    out.inner.push(Math.max(0, outer - stroke));
    out.offset.push(width > 0.02 ? width * radius * knobs.WIDTH_SPLIT : 0);
    out.ink.push(head < 0 || k < head ? heardInk : aheadInk);
  }
  return out;
}

/**
 * Which of `b`'s dots each of `a`'s goes to through a step, and which of
 * `a`'s each of `b`'s comes from: the dot in the same cell of the deepest
 * grid where there is one — that dot stays and only changes — and the
 * nearest otherwise, which the dot flows into or grows out of. Worked out
 * once per pair of songs, on the runtime that draws them.
 */
type SealStepPairing = {
  a: SealPlayer | null;
  b: SealPlayer | null;
  aTo: number[];
  bFrom: number[];
  /** Whether `b`'s `j`-th dot stands in a cell `a` had a dot in. */
  bShared: boolean[];
  aShared: boolean[];
};

function nearestInCells(cells: number[], at: number, n: number): number {
  'worklet';
  const gx = at % n;
  const gy = Math.floor(at / n);
  for (let r = 1; r < n; r++) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let y = gy - r; y <= gy + r; y++) {
      if (y < 0 || y >= n) continue;
      const edge = y === gy - r || y === gy + r;
      for (let x = gx - r; x <= gx + r; x += edge ? 1 : 2 * r) {
        if (x < 0 || x >= n) continue;
        const index = cells[y * n + x];
        if (index < 0) continue;
        const distance = (x - gx) * (x - gx) + (y - gy) * (y - gy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
    if (best >= 0) return best;
  }
  return 0;
}

function sealStepPairing(
  a: SealPlayer,
  b: SealPlayer,
  aCells: number[],
  bCells: number[],
): SealStepPairing {
  'worklet';
  const g = globalThis as unknown as { __cantorSealStep?: SealStepPairing };
  const cached = g.__cantorSealStep;
  if (cached !== undefined && cached.a === a && cached.b === b) return cached;
  const n = 3 ** SEAL_KNOBS.SONG_DEPTH;
  const byCellA: number[] = [];
  const byCellB: number[] = [];
  for (let i = 0; i < n * n; i++) {
    byCellA.push(-1);
    byCellB.push(-1);
  }
  for (let k = 0; k < aCells.length; k++) byCellA[aCells[k]] = k;
  for (let j = 0; j < bCells.length; j++) byCellB[bCells[j]] = j;
  const pairing: SealStepPairing = { a, b, aTo: [], bFrom: [], aShared: [], bShared: [] };
  for (let k = 0; k < aCells.length; k++) {
    const same = byCellB[aCells[k]];
    pairing.aShared.push(same >= 0);
    pairing.aTo.push(same >= 0 ? same : nearestInCells(byCellB, aCells[k], n));
  }
  for (let j = 0; j < bCells.length; j++) {
    const same = byCellA[bCells[j]];
    pairing.bShared.push(same >= 0);
    pairing.bFrom.push(same >= 0 ? same : nearestInCells(byCellA, bCells[j], n));
  }
  g.__cantorSealStep = pairing;
  return pairing;
}

/**
 * One song's seal becoming the next's, `t` of the way: the queue stepping at
 * L2 (`LensUi.morphPlayer`). The two seals sit on the same deepest grid, so a
 * cell both of them fill keeps its dot, which changes size, hollowness, ink
 * and pair into the arriving song's; a dot only the leaving seal has flows
 * into its nearest arriving neighbour as it shrinks away, and a dot only the
 * arriving one has grows out of its nearest leaving neighbour. Each thread
 * rides its own dots — the leaving one inks out, the arriving one in, on
 * shared vertices wherever the dots are shared — and one bead travels from
 * the leaving song's playhead to the arriving song's.
 *
 * At 0 this is `a`'s player as it was last drawn — on `motion`, its music
 * held, and at `aHeard`, where its playhead stood — and at 1 `b`'s, still:
 * each end is drawn by `drawSealPlayer` itself.
 */
export function drawSealStep(
  canvas: SkCanvas,
  a: SealPlayer,
  b: SealPlayer,
  t: number,
  paints: PlayerPaints,
  side: number,
  opacity: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  soundProgress: number,
  heard: number,
  aHeard: number,
  hairlinePx: number,
  motion: MotionFrame | null,
): void {
  'worklet';
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  // Each end is that seal's own player, exactly.
  if (u <= 0) {
    drawSealPlayer(canvas, a, paints, side, opacity, weight, fill, arrived, ARRIVING_NONE, 1, aHeard, hairlinePx, 1, 0, 0, motion);
    return;
  }
  if (u >= 1) {
    drawSealPlayer(canvas, b, paints, side, opacity, weight, fill, arrived, arriving, soundProgress, heard, hairlinePx);
    return;
  }
  // The leaving song's sound was in all the way; the arriving one's rises on
  // its own clock, which may still be running as the morph lands.
  const A = sealStepDots(
    a, side, weight, fill, arrived, ARRIVING_NONE, a.sound === null ? 0 : arrived,
    aHeard, hairlinePx, motion,
  );
  const B = sealStepDots(
    b, side, weight, fill, arrived, arriving, b.sound === null ? 0 : arrived * soundProgress,
    heard, hairlinePx, null,
  );
  const pairing = sealStepPairing(a, b, A.cell, B.cell);
  const na = A.x.length;
  const nb = B.x.length;
  // Each thread's vertices, riding their dots.
  const ax: number[] = [];
  const ay: number[] = [];
  for (let k = 0; k < na; k++) {
    const j = pairing.aTo[k];
    ax.push(A.x[k] + (B.x[j] - A.x[k]) * u);
    ay.push(A.y[k] + (B.y[j] - A.y[k]) * u);
  }
  const bx: number[] = [];
  const by: number[] = [];
  for (let j = 0; j < nb; j++) {
    const k = pairing.bFrom[j];
    bx.push(A.x[k] + (B.x[j] - A.x[k]) * u);
    by.push(A.y[k] + (B.y[j] - A.y[k]) * u);
  }
  const line = (xs: number[], ys: number[], from: number, to: number, end: number) => {
    const points: SkPoint[] = [];
    for (let k = from; k <= to; k++) points.push({ x: xs[k], y: ys[k] } as SkPoint);
    if (end > 0 && to + 1 < xs.length) {
      points.push({
        x: xs[to] + (xs[to + 1] - xs[to]) * end,
        y: ys[to] + (ys[to + 1] - ys[to]) * end,
      } as SkPoint);
    }
    if (points.length < 2) return;
    canvas.drawPoints(PointMode.Polygon, points, paints.stroke);
  };
  /*
   * The threads, as runs of segments in the ink mixed with the paper: at an
   * alpha, each joint is two segments' ends and inks twice, where the still
   * seal's one path does not — and where the two threads share a stretch,
   * the arriving one covers the leaving one rather than adding to it.
   */
  const inkColour = paints.fill.getColor();
  const strokeColour = paints.stroke.getColor();
  const paperColour = paints.paper.getColor();
  const threadInk = (ink: number) => {
    paints.stroke.setColor(
      Float32Array.of(
        paperColour[0] + (strokeColour[0] - paperColour[0]) * ink,
        paperColour[1] + (strokeColour[1] - paperColour[1]) * ink,
        paperColour[2] + (strokeColour[2] - paperColour[2]) * ink,
        opacity,
      ),
    );
  };
  const thread = (xs: number[], ys: number[], head: number, ink: number) => {
    if (ink <= 0) return;
    paints.stroke.setStrokeWidth(SEAL_PLAYER_KNOBS.THREAD_WIDTH_PX);
    threadInk(ink * SEAL_PLAYER_KNOBS.THREAD_AHEAD_ALPHA);
    line(xs, ys, 0, xs.length - 1, 0);
    if (head < 0) return;
    const last = Math.floor(head);
    if (last < 0) return;
    threadInk(ink);
    line(xs, ys, 0, Math.min(last, xs.length - 1), last < xs.length - 1 ? head - last : 0);
  };
  const aThread = A.threadInk * (1 - u);
  const bThread = B.threadInk * u;
  thread(ax, ay, A.head, aThread);
  thread(bx, by, B.head, bThread);
  paints.stroke.setColor(strokeColour);
  if (A.moved !== null && motion !== null && aThread > 0) {
    drawSealWeave(canvas, motion, A.moved.amount, na, A.head, ax, ay, paints.stroke, paints.paper, opacity * aThread);
  }

  /*
   * The dots. A moving seal draws each one opaque, its grey the ink mixed
   * with the paper, and a still one at an alpha, so the thread shows through
   * its quiet dots (`drawSealPlayer`). Both read the same on paper; over the
   * thread they do not. So a dot is drawn at an alpha between the two —
   * opaque as far as the leaving seal was moving and the morph has not
   * walked away from it, its colour darkened to match — and each end lands
   * on its own player's look.
   */
  const opaque = A.moved === null ? 0 : 1 - u;
  let inked = -1;
  const dot = (x: number, y: number, outer: number, inner: number, offset: number, ink: number) => {
    if (outer <= 0.01) return;
    const a2 = ink < 0 ? 0 : ink > 1 ? 1 : ink;
    const cover = a2 + (1 - a2) * opaque;
    if (cover <= 0) return;
    if (Math.abs(a2 - inked) > 1 / 512) {
      inked = a2;
      const mix = a2 / cover;
      const colour = Float32Array.of(
        paperColour[0] + (inkColour[0] - paperColour[0]) * mix,
        paperColour[1] + (inkColour[1] - paperColour[1]) * mix,
        paperColour[2] + (inkColour[2] - paperColour[2]) * mix,
        opacity * cover,
      );
      paints.fill.setColor(colour);
      paints.stroke.setColor(colour);
    }
    const one = (cx: number) => {
      if (inner > 0.05) {
        paints.stroke.setStrokeWidth(outer - inner);
        canvas.drawCircle(cx, y, (outer + inner) / 2, paints.stroke);
      } else {
        canvas.drawCircle(cx, y, outer, paints.fill);
      }
    };
    if (offset <= 0.01) {
      one(x);
    } else if (cover >= 1) {
      one(x - offset);
      one(x + offset);
    } else {
      // At an alpha, a wide slice's pair is one fill, or its overlap darkens.
      const pair = Skia.PathBuilder.Make();
      pair.addCircle(x - offset, y, outer);
      pair.addCircle(x + offset, y, outer);
      if (inner > 0.05) {
        pair.addCircle(x - offset, y, inner, true);
        pair.addCircle(x + offset, y, inner, true);
      }
      canvas.drawPath(pair.detach(), paints.fill);
    }
  };
  const v = 1 - u;
  // The leaving seal's own dots, flowing into their neighbours.
  for (let k = 0; k < na; k++) {
    if (pairing.aShared[k]) continue;
    dot(ax[k], ay[k], A.outer[k] * v, A.inner[k] * v, A.offset[k] * v, A.ink[k]);
  }
  // The arriving seal's: kept from the cell it shares, or grown.
  for (let j = 0; j < nb; j++) {
    const k = pairing.bFrom[j];
    if (pairing.bShared[j]) {
      dot(
        bx[j],
        by[j],
        A.outer[k] + (B.outer[j] - A.outer[k]) * u,
        A.inner[k] + (B.inner[j] - A.inner[k]) * u,
        A.offset[k] + (B.offset[j] - A.offset[k]) * u,
        A.ink[k] + (B.ink[j] - A.ink[k]) * u,
      );
    } else {
      dot(bx[j], by[j], B.outer[j] * u, B.inner[j] * u, B.offset[j] * u, B.ink[j]);
    }
  }
  paints.fill.setColor(inkColour);
  paints.stroke.setColor(strokeColour);

  // The bead, from where the leaving song stood to where the arriving one is.
  const beadAt = (xs: number[], ys: number[], head: number): [number, number] => {
    const k = Math.min(xs.length - 1, Math.floor(head));
    const next = Math.min(xs.length - 1, k + 1);
    const f = head - k;
    return [xs[k] + (xs[next] - xs[k]) * f, ys[k] + (ys[next] - ys[k]) * f];
  };
  const aBead = A.threadInk > 0 && A.head >= 0;
  const bBead = B.threadInk > 0 && B.head >= 0;
  if (!aBead && !bBead) return;
  const [fx, fy] = aBead ? beadAt(ax, ay, A.head) : beadAt(bx, by, B.head);
  const [tx, ty] = bBead ? beadAt(bx, by, B.head) : [fx, fy];
  const beadInk = (aBead ? A.threadInk : 0) * v + (bBead ? B.threadInk : 0) * u;
  if (beadInk <= 0) return;
  const beadX = fx + (tx - fx) * u;
  const beadY = fy + (ty - fy) * u;
  const ghosts = A.moved === null ? [] : A.moved.ghosts;
  if (ghosts.length > 0 && aThread > 0) {
    paints.stroke.setAlphaf(opacity * aThread * A.moved!.amount * SEAL_MOTION_KNOBS.GHOST_ALPHA);
    paints.stroke.setStrokeWidth(SEAL_MOTION_KNOBS.GHOST_STROKE_PX);
    for (let i = 0; i < ghosts.length; i++) {
      const [gx, gy] = beadAt(ax, ay, ghosts[i]);
      canvas.drawCircle(gx, gy, SEAL_PLAYER_KNOBS.BEAD_RADIUS_PX, paints.stroke);
    }
  }
  paints.paper.setAlphaf(opacity * beadInk);
  canvas.drawCircle(beadX, beadY, SEAL_PLAYER_KNOBS.BEAD_RADIUS_PX, paints.paper);
  paints.stroke.setAlphaf(opacity * beadInk);
  paints.stroke.setStrokeWidth(SEAL_PLAYER_KNOBS.BEAD_STROKE_PX);
  canvas.drawCircle(beadX, beadY, SEAL_PLAYER_KNOBS.BEAD_RADIUS_PX, paints.stroke);
}
