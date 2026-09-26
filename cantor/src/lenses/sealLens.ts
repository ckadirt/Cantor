import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import { availabilityOf } from './availability';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  NAME_LENS_KNOBS,
  drawArrivingArc,
  drawPlayingRing,
  drawRowWords,
} from './nameLens';
import { SEAL_KNOBS, sealDotRadius, sealModel } from './seal';
import type { LensIdentity, MarkPaints } from './contract';
import type { Lens, LensPaints, LensSong } from './types';

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
 * The seal, weighted by what the song promises about its audio.
 *
 * The face's own convention, carried over exactly: a song on this phone for
 * good is filled dots, one cached here is firm rings, one elsewhere is faint
 * rings — and a song still arriving gains the same arc the face does.
 */
function drawAvailableSeal(
  canvas: Parameters<Lens['draw']>[0],
  song: LensSong,
  cx: number,
  cy: number,
  radius: number,
  alpha: number,
  paints: LensPaints,
  depth: number = SEAL_KNOBS.MARK_DEPTH,
): void {
  const availability = availabilityOf(song.audioState);
  const path = sealMarkPath(song, sealSidePx(radius), depth);
  canvas.save();
  canvas.translate(cx, cy);
  if (FACE_FILL_ALPHA[availability] > 0) {
    paints.ink.setAlphaf(alpha * FACE_FILL_ALPHA[availability]);
    canvas.drawPath(path, paints.ink);
  } else {
    paints.outline.setAlphaf(alpha * FACE_STROKE_ALPHA[availability]);
    canvas.drawPath(path, paints.outline);
  }
  canvas.restore();
  if (availability === 'arriving') {
    drawArrivingArc(canvas, song.arriving, cx, cy, radius, alpha, paints);
  }
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

export const sealLens: Lens = {
  key: 'seal',
  label: 'Seal',
  // The dust at the mark's size, the face's own room through `sealSidePx`.
  identity: recipe =>
    sealMarkPath(recipe, sealSidePx(NAME_LENS_KNOBS.MARK_RADIUS_PX)),
  ui: { drawMark: drawSealMark },
  draw(canvas, box, song, options) {
    const { alpha, fonts, paints } = options;
    if (alpha <= 0) return;
    if (box.kind === 'mark') {
      drawAvailableSeal(
        canvas,
        song,
        box.x,
        box.y,
        NAME_LENS_KNOBS.MARK_RADIUS_PX,
        alpha,
        paints,
      );
      if (song.playing) {
        drawPlayingRing(
          canvas,
          box.x,
          box.y,
          NAME_LENS_KNOBS.MARK_RADIUS_PX,
          alpha,
          paints,
        );
      }
      return;
    }

    if (box.kind === 'song') {
      // The identity at its deepest, where the player stands. The sound is
      // drawn beside this on the native path, never recorded into a picture:
      // it moves with the song.
      const radius =
        (Math.min(box.width, box.height) / 2) * NAME_LENS_KNOBS.SONG_FACE_RATIO;
      drawAvailableSeal(
        canvas,
        song,
        box.x,
        box.y,
        radius,
        alpha,
        paints,
        SEAL_KNOBS.SONG_DEPTH,
      );
      return;
    }

    const sealX = box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX;
    drawAvailableSeal(
      canvas,
      song,
      sealX,
      box.y,
      NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
      alpha,
      paints,
    );
    if (song.playing) {
      drawPlayingRing(
        canvas,
        sealX,
        box.y,
        NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
        alpha,
        paints,
      );
    }
    drawRowWords(canvas, box, song, alpha, fonts, paints);
  },
};
