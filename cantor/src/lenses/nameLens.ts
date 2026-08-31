import {
  PaintStyle,
  Skia,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';
import { facePoints, type FaceRecipe } from './face';
import type { Lens, LensSong } from './types';

/** KNOBS — pixel measurements match the verified name-lens prototype. */
const NAME_LENS_KNOBS = {
  /** Radius the face is drawn at as a mark. Was the dot's radius. */
  MARK_RADIUS_PX: 7.5,
  /** The same face beside a row, small enough to leave the title its width. */
  ROW_FACE_RADIUS_PX: 9,
  ROW_PREVIEW_OFFSET_PX: 98,
  ROW_TITLE_OFFSET_PX: 42,
  ROW_TITLE_BASELINE_PX: -1,
  ROW_META_BASELINE_PX: 13,
  MAX_TITLE_CHARS: 24,
  // The playing mark keeps its dot and gains a ring, so "which one is playing"
  // is legible at L0 without any mini-player chrome anywhere.
  PLAYING_RING_RADIUS_PX: 7.5,
  PLAYING_RING_WIDTH_PX: 1.2,
} as const;

export const nameLens: Lens = {
  key: 'name',
  label: 'Name',
  draw(canvas, box, song, options) {
    const { alpha, fonts, paints } = options;
    if (alpha <= 0) return;
    if (box.kind === 'mark') {
      paints.outline.setAlphaf(alpha * 0.85);
      drawFace(
        canvas,
        song,
        box.x,
        box.y,
        NAME_LENS_KNOBS.MARK_RADIUS_PX,
        paints.outline,
      );
      if (song.playing) drawPlayingRing(canvas, box.x, box.y, alpha, paints);
      return;
    }

    paints.ink.setAlphaf(alpha);
    paints.outline.setAlphaf(alpha);
    paints.muted.setAlphaf(alpha);
    paints.faint.setAlphaf(alpha);
    drawFace(
      canvas,
      song,
      box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX,
      box.y,
      NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
      paints.outline,
    );
    if (song.playing) {
      drawPlayingRing(
        canvas,
        box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX,
        box.y,
        alpha,
        paints,
      );
    }
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
 * The playing indicator: a ring around the mark, drawn at every level.
 *
 * Restores the paint's fill style afterwards — paints are shared across the
 * whole picture, so leaving one stroked would silently outline everything drawn
 * after it.
 */
/**
 * The song's face, stroked at `radius`.
 *
 * The geometry is a pure function of the recipe, so this is the same silhouette
 * the row and the player draw — only `radius` changes. Stroking rather than
 * filling is what carries availability later: outline is a song on the node,
 * filled is one on this phone.
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

function drawPlayingRing(
  canvas: Parameters<typeof nameLens.draw>[0],
  x: number,
  y: number,
  alpha: number,
  paints: Parameters<typeof nameLens.draw>[3]['paints'],
): void {
  paints.ink.setAlphaf(alpha);
  paints.ink.setStyle(PaintStyle.Stroke);
  paints.ink.setStrokeWidth(NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX);
  canvas.drawCircle(x, y, NAME_LENS_KNOBS.PLAYING_RING_RADIUS_PX, paints.ink);
  paints.ink.setStyle(PaintStyle.Fill);
}
