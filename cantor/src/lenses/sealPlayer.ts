import { Skia, type SkCanvas } from '@shopify/react-native-skia';
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
  /** Null until the song has been measured: identity only. */
  sound: SealSound | null;
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
    sound:
      slices === null || slices === undefined ? null : sealSound(model, slices),
  };
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
    return (contour + (cellAt - contour) * formed) * side;
  };

  if (threadInk > 0 || lineInk > 0) {
    // The thread, under the dots: the whole of it quiet, the heard part inked.
    const ahead = Skia.PathBuilder.Make();
    const behind = Skia.PathBuilder.Make();
    const last = Math.floor(head);
    for (let k = 0; k < count; k++) {
      const x = at(k, 0);
      const y = at(k, 1);
      if (k === 0) ahead.moveTo(x, y);
      else ahead.lineTo(x, y);
      if (k <= last) {
        if (k === 0) behind.moveTo(x, y);
        else behind.lineTo(x, y);
      }
    }
    if (formed < 1 && count > 1) {
      // The face was closed and the thread is not: the closing segment's far
      // end slides back along it into the last dot.
      const firstX = at(0, 0);
      const firstY = at(0, 1);
      ahead.lineTo(
        firstX + (at(count - 1, 0) - firstX) * formed,
        firstY + (at(count - 1, 1) - firstY) * formed,
      );
    }
    if (last >= 0 && last < count - 1) {
      const f = head - last;
      behind.lineTo(
        at(last, 0) + (at(last + 1, 0) - at(last, 0)) * f,
        at(last, 1) + (at(last + 1, 1) - at(last, 1)) * f,
      );
    }
    paints.stroke.setStrokeWidth(
      hairlinePx + (player.THREAD_WIDTH_PX - hairlinePx) * formed,
    );
    paints.stroke.setAlphaf(
      opacity * (lineInk + threadInk * player.THREAD_AHEAD_ALPHA),
    );
    canvas.drawPath(ahead.detach(), paints.stroke);
    if (last >= 0 && threadInk > 0) {
      paints.stroke.setAlphaf(opacity * threadInk);
      canvas.drawPath(behind.detach(), paints.stroke);
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
      const outer = grownAt(keep);
      const stroke = hairlinePx + (outer - hairlinePx) * solidityAt(keep);
      const inner = outer - stroke;
      const target = landed >= 0 && keep >= 1 ? kept : rest;
      target.addCircle(at(k, 0), at(k, 1), outer);
      if (inner > 0.05) target.addCircle(at(k, 0), at(k, 1), inner, true);
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
  for (let k = 0; k < count; k++) {
    const x = at(k, 0);
    const y = at(k, 1);
    const keep = keptAt(k);
    // From the dot the opening draws, so leaving the song (the sound still
    // inked as the camera carries it out) meets the opening where it takes over.
    const grown = grownAt(keep);
    let radius = grown;
    let punch = 0;
    let width = 0;
    if (sound !== null) {
      const loud = sealLoudness(sound.loudness[k] ?? 0);
      const measured =
        (cell / 2) *
        (knobs.SOUND_MIN_FILL + knobs.SOUND_SPAN_FILL * loud) *
        formed;
      radius = grown + (measured - grown) * s;
      punch = (sound.punch[k] ?? 0) * s;
      width = (sound.width[k] ?? 0) * s;
    }
    // Identity: a filled dot, or a hairline ring for a song not kept here —
    // and a ring thickening into a dot while a download lands.
    const identityStroke =
      hairlinePx + (radius - hairlinePx) * solidityAt(keep);
    const soundStroke = radius * (1 - knobs.PUNCH_HOLLOW * punch);
    const stroke = identityStroke + (soundStroke - identityStroke) * s;
    const outer = Math.max(0.01, radius * (1 - knobs.WIDTH_SHRINK * width));
    const inner = outer - stroke;
    const target = head < 0 || k < head ? heardDots : aheadDots;
    const addDot = (cx: number) => {
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
  paints.fill.setAlphaf(opacity * (weight + (1 - weight) * s));
  canvas.drawPath(heardDots.detach(), paints.fill);
  paints.fill.setAlphaf(
    opacity * (weight + (player.UNHEARD_ALPHA - weight) * s),
  );
  canvas.drawPath(aheadDots.detach(), paints.fill);

  if (threadInk > 0 && head >= 0) {
    // The bead: where the song is, on the thread.
    const k = Math.min(count - 1, Math.floor(head));
    const next = Math.min(count - 1, k + 1);
    const f = head - k;
    const bx = at(k, 0) + (at(next, 0) - at(k, 0)) * f;
    const by = at(k, 1) + (at(next, 1) - at(k, 1)) * f;
    paints.paper.setAlphaf(opacity * threadInk);
    canvas.drawCircle(bx, by, player.BEAD_RADIUS_PX, paints.paper);
    paints.stroke.setAlphaf(opacity * threadInk);
    paints.stroke.setStrokeWidth(player.BEAD_STROKE_PX);
    canvas.drawCircle(bx, by, player.BEAD_RADIUS_PX, paints.stroke);
  }
}
