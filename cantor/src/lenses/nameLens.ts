import {
  PaintStyle,
  Skia,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  availabilityAction,
  availabilityLine,
  availabilityOf,
  type Availability,
} from './availability';
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
  /**
   * The row's right edge, from its point. The face sits 98 px left of the
   * point and 22 px in from the row's own left edge, so a 240 px row ends here.
   */
  ROW_RIGHT_PX: 120,
  /**
   * Air between the longest a title may run and the action word beside it.
   * Titles are cut to fit rather than to a character count, because a
   * proportional face makes a count a guess.
   */
  ROW_TITLE_GAP_PX: 14,
  /** Where the action word sits between the two lines it belongs to. */
  ROW_ACTION_BASELINE_PX: 5,
  /**
   * The action word is drawn muted rather than in ink: it is the row's second
   * voice, and `REMOVE` in particular should never look like the way forward.
   */
  ROW_ACTION_ALPHA: 0.8,
  /** A title on a song that is not on the phone reads as quietly as its face. */
  ROW_TITLE_AWAY_ALPHA: 0.55,
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
    // The action word is right-aligned against the row's edge, and the title
    // is cut to whatever is left. Measuring both keeps a long title from
    // running under the word that acts on it.
    const availability = availabilityOf(song.audioState);
    const action = availabilityAction(availability);
    const titleLeft = box.x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX;
    const rowRight = box.x + NAME_LENS_KNOBS.ROW_RIGHT_PX;
    let titleRight = rowRight;
    if (action !== null) {
      const width = textWidth(action, fonts.mono);
      paints.muted.setAlphaf(alpha * NAME_LENS_KNOBS.ROW_ACTION_ALPHA);
      canvas.drawText(
        action,
        rowRight - width,
        box.y + NAME_LENS_KNOBS.ROW_ACTION_BASELINE_PX,
        paints.muted,
        fonts.mono,
      );
      titleRight = rowRight - width - NAME_LENS_KNOBS.ROW_TITLE_GAP_PX;
    }
    // A song that is not on the phone says so twice: in the weight of its face
    // and in the weight of its name.
    paints.ink.setAlphaf(
      alpha *
        (availability === 'cached' || availability === 'downloaded'
          ? 1
          : NAME_LENS_KNOBS.ROW_TITLE_AWAY_ALPHA),
    );
    paints.muted.setAlphaf(alpha);
    paints.faint.setAlphaf(alpha);
    canvas.drawText(
      fitText(song.title, fonts.display, titleRight - titleLeft),
      titleLeft,
      box.y + NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
      paints.ink,
      fonts.display,
    );
    canvas.drawText(
      // Cut to the same column as the title: `CACHED · MAY BE RECLAIMED` is
      // the longest line here and it must not run under the action word.
      fitText(availabilityLine(song), fonts.mono, titleRight - titleLeft),
      titleLeft,
      box.y + NAME_LENS_KNOBS.ROW_META_BASELINE_PX,
      paints.muted,
      fonts.mono,
    );
  },
};

/**
 * The part of `SkFont` this file needs.
 *
 * Named so the cut can be tested against a font whose widths are known: the
 * Skia jest mock has no typeface, so a real font measures nothing there.
 */
export type MeasuredFont = Readonly<{
  getSize: () => number;
  measureText: (text: string) => { width: number };
}>;

const textWidthCache = new Map<string, number>();
const fitTextCache = new Map<string, string>();
const TEXT_CACHE_LIMIT = 512;

/** `measureText` is not free, and a row is measured on every recorded frame. */
function textWidth(value: string, font: MeasuredFont): number {
  const key = `${font.getSize()}:${value}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;
  // A font with no typeface measures nothing and also draws nothing, so zero
  // is the honest answer rather than a NaN that silently disables the cut.
  const measured = font.measureText(value)?.width;
  const width = Number.isFinite(measured) ? measured : 0;
  remember(textWidthCache, key, width);
  return width;
}

/**
 * The longest prefix of `value` that fits `maxWidth`, ellipsed when it had to
 * be cut.
 *
 * Cut by measurement rather than by a character count: the display face is
 * proportional, so a count either wastes the column or overruns it. The first
 * guess comes from the average glyph width and is corrected from there, which
 * lands in one or two steps for a real title.
 */
export function fitText(
  value: string,
  font: MeasuredFont,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return '';
  const key = `${font.getSize()}:${Math.round(maxWidth)}:${value}`;
  const cached = fitTextCache.get(key);
  if (cached !== undefined) return cached;
  let result = value;
  if (textWidth(value, font) > maxWidth) {
    const perChar = textWidth(value, font) / value.length;
    let count = Math.max(0, Math.min(value.length - 1, Math.floor(maxWidth / perChar) - 1));
    while (count > 0 && textWidth(`${value.slice(0, count)}…`, font) > maxWidth) {
      count -= 1;
    }
    while (
      count < value.length - 1 &&
      textWidth(`${value.slice(0, count + 1)}…`, font) <= maxWidth
    ) {
      count += 1;
    }
    result = count <= 0 ? '' : `${value.slice(0, count)}…`;
  }
  remember(fitTextCache, key, result);
  return result;
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= TEXT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
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
