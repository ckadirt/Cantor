import {
  PaintStyle,
  Skia,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';
import { availabilityOf, type Availability } from './availability';
import { FACE_MAX_EXTENT, facePoints, type FaceRecipe } from './face';
import type { Lens, LensPaints, LensSong } from './types';

/**
 * KNOBS — pixel measurements match the verified name-lens prototype.
 *
 * Exported because `FieldCanvas` draws this same face from React during a
 * re-cut flight, and a mark that changed size or ring gap on the way to its new
 * seat would be a different mark.
 */
export const NAME_LENS_KNOBS = {
  /** Radius the face is drawn at as a mark. Was the dot's radius. */
  MARK_RADIUS_PX: 7.5,
  /** The same face beside a row, small enough to leave the title its width. */
  ROW_FACE_RADIUS_PX: 9,
  ROW_PREVIEW_OFFSET_PX: 98,
  ROW_TITLE_OFFSET_PX: 42,
  ROW_TITLE_BASELINE_PX: -1,
  ROW_META_BASELINE_PX: 13,
  MAX_TITLE_CHARS: 24,
  // The playing mark keeps its face and gains a ring, so "which one is playing"
  // is legible at L0 without any mini-player chrome anywhere. Both rings clear
  // the face's furthest lobe by this much: drawn any closer they cut through the
  // contour and read as part of it rather than around it, and a ring inside a
  // filled face is not a ring at all.
  RING_GAP_PX: 1.5,
  PLAYING_RING_WIDTH_PX: 1.2,
  /** The arriving arc, in the same hand as the ring a generating job draws. */
  ARRIVING_RING_WIDTH_PX: 1.4,
  /** Swept when the artifact's byte length is unknown, so progress is unknowable. */
  ARRIVING_INDETERMINATE_SWEEP_DEG: 70,
} as const;

/**
 * Availability as weight: how much of the face is drawn.
 *
 * Faint is a song you do not have, firm is one you have for now, and filled is
 * one you are promised. The whole field's offline-readiness is legible at a
 * glance, with no badges anywhere. `cached` keeps the alpha the face has always
 * been drawn at, so the state the field mostly shows today does not move.
 */
export const FACE_STROKE_ALPHA: Readonly<Record<Availability, number>> = {
  'not-synced': 0.38,
  arriving: 0.38,
  cached: 0.85,
  downloaded: 1,
};

/** Only a downloaded song is filled — the promise the budget may not reclaim. */
export const FACE_FILL_ALPHA: Readonly<Record<Availability, number>> = {
  'not-synced': 0,
  arriving: 0,
  cached: 0,
  downloaded: 1,
};

/**
 * Where a ring goes around a face drawn at `radius`.
 *
 * Exported because the flying face in `FieldCanvas` draws the playing ring from
 * React, and the two have to agree or the ring would jump size on landing.
 */
export function nameLensRingRadius(radius: number): number {
  return radius * FACE_MAX_EXTENT + NAME_LENS_KNOBS.RING_GAP_PX;
}

export const nameLens: Lens = {
  key: 'name',
  label: 'Name',
  draw(canvas, box, song, options) {
    const { alpha, fonts, paints } = options;
    if (alpha <= 0) return;
    if (box.kind === 'mark') {
      drawAvailableFace(
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

    const faceX = box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX;
    drawAvailableFace(
      canvas,
      song,
      faceX,
      box.y,
      NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
      alpha,
      paints,
    );
    if (song.playing) {
      drawPlayingRing(
        canvas,
        faceX,
        box.y,
        NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
        alpha,
        paints,
      );
    }
    paints.ink.setAlphaf(alpha);
    paints.muted.setAlphaf(alpha);
    paints.faint.setAlphaf(alpha);
    canvas.drawText(
      truncate(song.title),
      box.x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      box.y + NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
      paints.ink,
      fonts.display,
    );
    canvas.drawText(
      `${formatDuration(song.durationMs)} · ${song.model.toUpperCase()}`,
      box.x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      box.y + NAME_LENS_KNOBS.ROW_META_BASELINE_PX,
      paints.muted,
      fonts.mono,
    );
  },
};

function truncate(value: string): string {
  return value.length > NAME_LENS_KNOBS.MAX_TITLE_CHARS
    ? `${value.slice(0, NAME_LENS_KNOBS.MAX_TITLE_CHARS - 1)}…`
    : value;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The song's face, drawn at `radius` with whatever paint the caller hands in.
 *
 * The geometry is a pure function of the recipe, so this is the same silhouette
 * the row and the player draw — only `radius` changes. Stroking rather than
 * filling is what carries availability: outline is a song on the node, filled
 * is one on this phone. `drawAvailableFace` decides which.
 */
function drawFace(
  canvas: Parameters<Lens['draw']>[0],
  song: LensSong,
  cx: number,
  cy: number,
  radius: number,
  paint: SkPaint,
): void {
  // The contour is identity, not animation state. Build each of the two drawn
  // sizes once, then translate it. Rebuilding 96 points (and all their trig)
  // for every transition frame starves the UI thread. Scaling the canvas is
  // intentionally avoided because it would also scale the hairline stroke.
  canvas.save();
  canvas.translate(cx, cy);
  canvas.drawPath(nameLensFacePath(song, radius), paint);
  canvas.restore();
}

const FACE_PATH_CACHE_LIMIT = 512;
const facePathCache = new Map<string, SkPath>();

/** Build the closed contour once per song recipe and requested display size. */
export function nameLensFacePath(
  song: Pick<LensSong, 'seed' | 'id' | 'model' | 'durationMs'>,
  radius: number = NAME_LENS_KNOBS.MARK_RADIUS_PX,
): SkPath {
  const cacheKey = JSON.stringify([
    song.seed ?? null,
    song.id,
    song.model,
    song.durationMs,
    radius,
  ]);
  const cached = facePathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const recipe: FaceRecipe = {
    seed: song.seed,
    id: song.id,
    model: song.model,
    durationMs: song.durationMs,
  };
  const builder = Skia.PathBuilder.Make();
  facePoints(recipe).forEach((point, index) => {
    const x = point.x * radius;
    const y = point.y * radius;
    if (index === 0) builder.moveTo(x, y);
    else builder.lineTo(x, y);
  });
  builder.close();
  const path = builder.detach();
  if (facePathCache.size >= FACE_PATH_CACHE_LIMIT) {
    const oldest = facePathCache.keys().next().value;
    if (oldest !== undefined) facePathCache.delete(oldest);
  }
  facePathCache.set(cacheKey, path);
  return path;
}

/**
 * The face, weighted by what the song promises about its audio.
 *
 * Three states, three promises, and cached and downloaded never look alike: a
 * faint contour is a song that will not play offline, a firm one is a loan the
 * budget may reclaim, and a filled one is here until you remove it. A song
 * still arriving keeps the faint contour and gains the arc.
 */
function drawAvailableFace(
  canvas: Parameters<Lens['draw']>[0],
  song: LensSong,
  cx: number,
  cy: number,
  radius: number,
  alpha: number,
  paints: LensPaints,
): void {
  const availability = availabilityOf(song.audioState);
  const fill = FACE_FILL_ALPHA[availability];
  if (fill > 0) {
    paints.ink.setAlphaf(alpha * fill);
    drawFace(canvas, song, cx, cy, radius, paints.ink);
  }
  paints.outline.setAlphaf(alpha * FACE_STROKE_ALPHA[availability]);
  drawFace(canvas, song, cx, cy, radius, paints.outline);
  if (availability === 'arriving') {
    drawArrivingArc(canvas, song.arriving, cx, cy, radius, alpha, paints);
  }
}

/**
 * The wait, drawn: the same ring a generating job traces, around the face the
 * bytes are on their way to.
 *
 * Pressing play on a song that is not here is a full download with a silence in
 * front of it — `playFocused` fetches the whole delivery artifact before it
 * opens anything — so the arrival has to be visible rather than implied.
 *
 * Restores the paint's fill style afterwards; paints are shared across the
 * whole picture, so leaving one stroked would silently outline everything drawn
 * after it.
 */
function drawArrivingArc(
  canvas: Parameters<Lens['draw']>[0],
  fraction: number | null,
  cx: number,
  cy: number,
  radius: number,
  alpha: number,
  paints: LensPaints,
): void {
  const ringRadius = nameLensRingRadius(radius);
  const box = Skia.XYWHRect(
    cx - ringRadius,
    cy - ringRadius,
    ringRadius * 2,
    ringRadius * 2,
  );
  paints.ink.setAlphaf(alpha);
  paints.ink.setStyle(PaintStyle.Stroke);
  paints.ink.setStrokeWidth(NAME_LENS_KNOBS.ARRIVING_RING_WIDTH_PX);
  const sweep =
    fraction === null
      ? NAME_LENS_KNOBS.ARRIVING_INDETERMINATE_SWEEP_DEG
      : 360 * Math.min(1, Math.max(0, fraction));
  canvas.drawArc(box, -90, sweep, false, paints.ink);
  paints.ink.setStyle(PaintStyle.Fill);
}

/**
 * The playing indicator: a ring around the mark, drawn at every level.
 *
 * Restores the paint's fill style afterwards, for the same reason the arriving
 * arc does.
 */
function drawPlayingRing(
  canvas: Parameters<Lens['draw']>[0],
  x: number,
  y: number,
  radius: number,
  alpha: number,
  paints: LensPaints,
): void {
  paints.ink.setAlphaf(alpha);
  paints.ink.setStyle(PaintStyle.Stroke);
  paints.ink.setStrokeWidth(NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX);
  canvas.drawCircle(x, y, nameLensRingRadius(radius), paints.ink);
  paints.ink.setStyle(PaintStyle.Fill);
}
