import {
  BlendMode,
  FilterMode,
  MipmapMode,
  Skia,
  type SkCanvas,
  type SkColor,
  type SkImage,
  type SkPaint,
  type SkRect,
  type SkRSXform,
} from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import { LENS_UI, type LensIdentity, type MarkPaints } from '../../lenses';

/**
 * The field's faces as stamps.
 *
 * Every face was its paths, every frame: a fill and an outline, scaled and
 * placed, ~13 ms a frame for 194 songs on a Samsung A52s at 120 Hz (the
 * outline alone ~8, its width set anew each frame so nothing could be kept).
 * A lens that splits its mark into layers (`MarkSprites`) has each layer of
 * each song drawn once into one image at the size the marks stand at, and the
 * field stamps them — every face in one `drawAtlas`, each layer tinted by its
 * own alpha. A face that is not a plain mark, or stands bigger than the image
 * was drawn for, is drawn as paths, as before, between two stamped batches so
 * the order faces overlap in never changes.
 */

/** KNOBS */
export const FACE_ATLAS_KNOBS = {
  /**
   * How far a face may stand from the size its stamps were drawn at before
   * it is drawn as paths instead (bigger) or the stamps are drawn again
   * (either way): a hairline drawn 10 % off is still a hairline.
   */
  FIT_LOW: 0.9,
  FIT_HIGH: 1.1,
  /** The least time between two redraws of the stamps, while the size moves. */
  REDRAW_MS: 250,
  /** The image's widest row, and its tallest, in pixels. */
  MAX_SIDE_PX: 4096,
  /** Clear pixels round each stamp, so filtering never reaches a neighbour. */
  GUTTER_PX: 2,
} as const;

/** One song's stamps under one lens: a source rect per layer. */
type Stamp = Readonly<{ rects: readonly SkRect[]; half: number }>;

export type FaceAtlas = Readonly<{
  /** The songs record it was drawn from, compared by identity. */
  songs: object;
  /** The lenses it holds, as `LENSES` indices joined. */
  lenses: string;
  /** The face size it was drawn at; see `drawFieldFaces`' `markPose`. */
  size: number;
  image: SkImage | null;
  /** By lens (`LENSES` index), then by entity key. */
  stamps: Readonly<Record<number, Readonly<Record<string, Stamp>>>>;
  builtAt: number;
}>;

/**
 * Transforms and colours made once and set anew each frame: a stamp is a
 * native transform and a colour, and making ~400 of each per frame cost more
 * than the stamps saved.
 */
export type StampPool = { xforms: SkRSXform[]; colors: SkColor[] };

/** What `drawFieldFaces` needs to stamp; null draws every face as paths. */
export type FaceStamping = Readonly<{
  atlas: SharedValue<FaceAtlas | null>;
  pool: SharedValue<StampPool>;
  /** Every song's identities, by entity key; see `SongDraw`. */
  songs: Readonly<Record<string, { identities: readonly LensIdentity[] }>>;
  pixelRatio: number;
  hairlinePx: number;
}>;

function now(): number {
  'worklet';
  const g = globalThis as unknown as { performance?: { now(): number } };
  return g.performance !== undefined ? g.performance.now() : Date.now();
}

/** Draw every song's layers for these lenses into one image. */
function drawFaceAtlas(
  stamping: FaceStamping,
  lenses: readonly number[],
  key: string,
  size: number,
  paints: MarkPaints,
): FaceAtlas {
  'worklet';
  const { pixelRatio, hairlinePx, songs } = stamping;
  const gutter = FACE_ATLAS_KNOBS.GUTTER_PX;
  // Lay the cells out first: one per layer per song per lens.
  const cells: {
    lens: number;
    entity: string;
    identity: LensIdentity;
    layer: number;
    side: number;
    x: number;
    y: number;
  }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  const max = FACE_ATLAS_KNOBS.MAX_SIDE_PX;
  let full = false;
  for (const entity in songs) {
    if (full) break;
    const identities = songs[entity].identities;
    for (let l = 0; l < lenses.length && !full; l++) {
      const lens = lenses[l];
      const sprites = LENS_UI[lens].sprites;
      const identity = identities[lens];
      if (sprites === undefined || identity == null) continue;
      const reach = sprites.reach(identity) * size + hairlinePx;
      const side = Math.ceil(reach * 2 * pixelRatio) + gutter * 2;
      for (let layer = 0; layer < sprites.layers; layer++) {
        if (x + side > max) {
          x = 0;
          y += rowHeight;
          rowHeight = 0;
        }
        if (y + side > max) {
          full = true;
          break;
        }
        cells.push({ lens, entity, identity, layer, side, x, y });
        x += side;
        if (x > width) width = x;
        if (side > rowHeight) rowHeight = side;
      }
    }
  }
  const height = y + rowHeight;
  const stamps: Record<number, Record<string, { rects: SkRect[]; half: number }>> = {};
  if (cells.length === 0 || width === 0 || height === 0) {
    return { songs, lenses: key, size, image: null, stamps, builtAt: now() };
  }
  const surface = Skia.Surface.Make(width, height);
  if (surface === null) {
    return { songs, lenses: key, size, image: null, stamps, builtAt: now() };
  }
  const canvas = surface.getCanvas();
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const sprites = LENS_UI[cell.lens].sprites;
    if (sprites === undefined) continue;
    canvas.save();
    canvas.translate(cell.x + cell.side / 2, cell.y + cell.side / 2);
    canvas.scale(pixelRatio, pixelRatio);
    sprites.drawLayer(canvas, cell.identity, cell.layer, size, hairlinePx, paints);
    canvas.restore();
    const byEntity = stamps[cell.lens] ?? {};
    stamps[cell.lens] = byEntity;
    const stamp = byEntity[cell.entity] ?? { rects: [], half: cell.side / 2 };
    stamp.rects[cell.layer] = Skia.XYWHRect(cell.x, cell.y, cell.side, cell.side);
    byEntity[cell.entity] = stamp;
  }
  surface.flush();
  const image = surface.makeImageSnapshot();
  return { songs, lenses: key, size, image, stamps, builtAt: now() };
}

/**
 * The atlas for these lenses at `size`: the one there is when it still fits,
 * else drawn anew — at most once per `REDRAW_MS` while only the size moves.
 */
export function faceAtlasFor(
  stamping: FaceStamping,
  lenses: readonly number[],
  size: number,
  paints: MarkPaints,
): FaceAtlas | null {
  'worklet';
  const key = lenses.join(',');
  const current = stamping.atlas.value;
  if (current !== null && current.songs === stamping.songs && current.lenses === key) {
    const fit = size / current.size;
    if (fit >= FACE_ATLAS_KNOBS.FIT_LOW && fit <= FACE_ATLAS_KNOBS.FIT_HIGH) {
      return current;
    }
    if (now() - current.builtAt < FACE_ATLAS_KNOBS.REDRAW_MS) return current;
  }
  const built = drawFaceAtlas(stamping, lenses, key, size, paints);
  stamping.atlas.value = built;
  return built;
}

/**
 * Stamps waiting to be drawn, in the order the faces were met: entries
 * `start` to `end` of the pool, and their source rects.
 */
export type StampBatch = {
  pool: StampPool | null;
  rects: SkRect[];
  start: number;
  end: number;
};

export function createStampBatch(pool: StampPool | null): StampBatch {
  'worklet';
  return { pool, rects: [], start: 0, end: 0 };
}

/**
 * Add one face's layers to the batch, centred on `(cx, cy)` at `size`; false
 * when it has no stamps or stands too big for them, so it is drawn as paths.
 */
export function stampFace(
  batch: StampBatch,
  atlas: FaceAtlas,
  lens: number,
  entityKey: string,
  cx: number,
  cy: number,
  size: number,
  alphas: readonly number[],
  layers: number,
  pixelRatio: number,
): boolean {
  'worklet';
  if (atlas.image === null) return false;
  const byEntity = atlas.stamps[lens];
  const stamp = byEntity === undefined ? undefined : byEntity[entityKey];
  if (stamp === undefined) return false;
  const fit = size / atlas.size;
  if (fit > FACE_ATLAS_KNOBS.FIT_HIGH) return false;
  const k = fit / pixelRatio;
  const tx = cx - stamp.half * k;
  const ty = cy - stamp.half * k;
  const pool = batch.pool;
  if (pool === null) return false;
  for (let layer = 0; layer < layers; layer++) {
    const alpha = alphas[layer];
    const rect = stamp.rects[layer];
    if (!(alpha > 0) || rect === undefined) continue;
    const at = batch.end;
    if (at >= pool.xforms.length) {
      pool.xforms.push(Skia.RSXform(k, 0, tx, ty));
      pool.colors.push(Float32Array.of(1, 1, 1, alpha));
    } else {
      pool.xforms[at].set(k, 0, tx, ty);
      pool.colors[at][3] = alpha;
    }
    batch.rects.push(rect);
    batch.end = at + 1;
  }
  return true;
}

/** Whether `stampFace` would take this face; see there. */
export function canStamp(
  atlas: FaceAtlas,
  lens: number,
  entityKey: string,
  size: number,
): boolean {
  'worklet';
  const byEntity = atlas.stamps[lens];
  return (
    atlas.image !== null &&
    byEntity !== undefined &&
    byEntity[entityKey] !== undefined &&
    size / atlas.size <= FACE_ATLAS_KNOBS.FIT_HIGH
  );
}

/** Draw what the batch holds, in one call, and empty it. */
export function flushStamps(
  canvas: SkCanvas,
  batch: StampBatch,
  atlas: FaceAtlas | null,
  paint: SkPaint,
): void {
  'worklet';
  const pool = batch.pool;
  if (
    batch.end > batch.start &&
    pool !== null &&
    atlas !== null &&
    atlas.image !== null
  ) {
    // The picture keeps its own copy of what it is handed, so the pool's
    // entries are free again for the next batch.
    canvas.drawAtlas(
      atlas.image,
      batch.rects,
      pool.xforms.slice(batch.start, batch.end),
      paint,
      BlendMode.Modulate,
      pool.colors.slice(batch.start, batch.end),
      { filter: FilterMode.Linear, mipmap: MipmapMode.None },
    );
  }
  batch.rects = [];
  batch.start = batch.end;
}
