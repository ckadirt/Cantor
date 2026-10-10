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
