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
  type SkSurface,
} from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';
import { uiRecord, uiSpan } from '../../dev/perfProbe';
import { LENS_UI, type LensIdentity, type MarkPaints } from '../../lenses';

/**
 * The field's faces as stamps.
 *
 * Every face was its paths, every frame: a fill and an outline, scaled and
 * placed, ~13 ms a frame for 194 songs on a Samsung A52s at 120 Hz (the
 * outline alone ~8, its width set anew each frame so nothing could be kept).
 * A lens that splits its mark into layers (`MarkSprites`) has each layer of
 * each song drawn once into an image at the size the marks stand at, and the
 * field stamps them — runs of faces in one `drawAtlas`, each layer tinted by
 * its own alpha. A face that is not a plain mark, stands bigger than its
 * stamps, or has none yet, is drawn as paths, between two stamped runs so the
 * order faces overlap in never changes.
 *
 * The stamps are a cache the field fills as it looks, never all at once.
 * Drawing every song's stamps in one go held one frame for ~300 ms on the
 * Xiaomi at 872 songs, on each new size (opening a week, coming back to the
 * map) and each time the songs changed. Now a face with no stamp asks for one
 * (`stampFor`) and is drawn as paths meanwhile, which look the same; a worker
 * on the UI thread (`pumpFaceAtlas`) draws what was asked for, the faces in
 * view first, a few milliseconds a frame, then the rest of the library while
 * there is room. Stamps live on fixed-size pages, so a new stamp redraws one
 * small image, not the whole library's, and they are kept by size
 * (`Generation`), so coming back to a size finds its stamps still there.
 */

/** KNOBS */
export const FACE_ATLAS_KNOBS = {
  /**
   * How far a face may stand from the size its stamps were drawn at before
   * it is drawn as paths instead (bigger) or stamps are drawn for its size
   * (either way): a hairline drawn 10 % off is still a hairline.
   */
  FIT_LOW: 0.9,
  FIT_HIGH: 1.1,
  /**
   * The least time between two stampings of one song that changed: a
   * download's progress changes its song many times a second, and until the
   * next stamping that song is drawn as paths.
   */
  RESTOCK_MS: 2000,
  /**
   * One page's side, in pixels. A new stamp redraws its page's image, and
   * drawing onto a page whose image is still held copies it first: at 1024 a
   * page cost the worker ~4 ms a frame on the Xiaomi whatever it stamped.
   */
  PAGE_PX: 512,
  /** Clear pixels round each stamp, so filtering never reaches a neighbour. */
  GUTTER_PX: 2,
  /** A frame's share for stamping faces in or near view. */
  WANT_BUDGET_MS: 4,
  /** A frame's share for stamping the rest of the library, ahead of need. */
  FILL_BUDGET_MS: 2,
  /**
   * Pages one size fills ahead of need; faces asked for may take up to
   * `MAX_PAGES`, after which that size starts over, empty.
   */
  FILL_PAGES: 24,
  MAX_PAGES: 48,
  /** Sizes kept: the one in use and the last one before it. */
  GENERATIONS: 2,
} as const;

type Page = {
  surface: SkSurface;
  /** The page as last drawn; what a stamp on it is drawn from. */
  image: SkImage | null;
  dirty: boolean;
  /** Where the next stamp goes: shelf packing, left to right, then down. */
  x: number;
  y: number;
  rowHeight: number;
};

/**
 * One song's stamps under one lens at one size: a source rect per look on
 * its page, and the identity they were drawn from — a song whose identity has
 * changed since is drawn as paths until it is stamped again.
 */
export type Stamp = Readonly<{
  page: Page;
  rects: readonly SkRect[];
  half: number;
  /** The face size the stamps were drawn at. */
  size: number;
  identity: LensIdentity;
  at: number;
}>;

/** Every stamp drawn at one face size. */
type Generation = {
  size: number;
  pages: Page[];
  /** By lens (`LENSES` index), then by entity key. */
  stamps: Record<number, Record<string, Stamp>>;
  usedAt: number;
  /** The library walked ahead of need: its keys, and how far it has got. */
  fill: { songs: object | null; keys: string[]; at: number; done: boolean };
};

type Want = { lens: number; entity: string };

/** The cache itself, shared by every `FaceAtlas` that wraps it. */
type AtlasCore = {
  generations: Generation[];
  /** The generation stamps are drawn into: the size the field stands at. */
  target: Generation | null;
  /** The last size asked for, to know when a zoom has come to rest. */
  askedSize: number;
  lenses: readonly number[];
  songs: FaceStamping['songs'];
  paints: MarkPaints | null;
  pixelRatio: number;
  hairlinePx: number;
  wanted: Want[];
  wantedKeys: Record<string, boolean>;
  scheduled: boolean;
  /** The shared value this core is published through, for the worker. */
  shared: SharedValue<FaceAtlas | null>;
  /**
   * The worker, held here because worklets are not hoisted: the scheduler is
   * declared above the worker it wakes.
   */
  pump: (shared: SharedValue<FaceAtlas | null>, budgetMs?: number) => void;
};

/**
 * What the field draws stamps from. A new wrapper is published each time the
 * worker adds stamps, so the face picture records again; the cache inside is
 * the same.
 */
export type FaceAtlas = Readonly<{ core: AtlasCore; version: number }>;

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

function fits(size: number, at: number): boolean {
  'worklet';
  const fit = size / at;
  return fit >= FACE_ATLAS_KNOBS.FIT_LOW && fit <= FACE_ATLAS_KNOBS.FIT_HIGH;
}

function newGeneration(size: number): Generation {
  'worklet';
  return {
    size,
    pages: [],
    stamps: {},
    usedAt: now(),
    fill: { songs: null, keys: [], at: 0, done: false },
  };
}

function dropGeneration(generation: Generation): void {
  'worklet';
  // The pages' pixels go now rather than whenever the collector runs; an
  // image already recorded into a picture keeps its own reference.
  for (let index = 0; index < generation.pages.length; index++) {
    const page = generation.pages[index] as unknown as {
      surface: { dispose?: () => void };
    };
    page.surface.dispose?.();
  }
  generation.pages = [];
  generation.stamps = {};
}

/** A place for a stamp `side` pixels square, on a page with room. */
function placeCell(
  generation: Generation,
  side: number,
): { page: Page; x: number; y: number } | null {
  'worklet';
  const max = FACE_ATLAS_KNOBS.PAGE_PX;
  if (side > max) return null;
  let page =
    generation.pages.length === 0
      ? null
      : generation.pages[generation.pages.length - 1];
  if (page !== null && page.x + side > max) {
    page.x = 0;
    page.y += page.rowHeight;
    page.rowHeight = 0;
  }
  if (page === null || page.y + side > max) {
    if (generation.pages.length >= FACE_ATLAS_KNOBS.MAX_PAGES) return null;
    const surface = Skia.Surface.Make(max, max);
    if (surface === null) return null;
    page = { surface, image: null, dirty: false, x: 0, y: 0, rowHeight: 0 };
    generation.pages.push(page);
  }
  const at = { page, x: page.x, y: page.y };
  page.x += side;
  if (side > page.rowHeight) page.rowHeight = side;
  return at;
}

/**
 * Draw one song's looks under one lens onto the generation's pages; the
 * stamp it makes is returned, to be published once its page is snapshotted.
 * Null when there is nothing to do, or it cannot be stamped.
 */
function stampOne(
  core: AtlasCore,
  generation: Generation,
  lens: number,
  entity: string,
  clock: number,
): Stamp | null {
  'worklet';
  const song = core.songs[entity];
  const paints = core.paints;
  if (song === undefined || paints === null) return null;
  const identity = song.identities[lens];
  const sprites = LENS_UI[lens]?.sprites;
  if (sprites === undefined || identity == null) return null;
  const byEntity = generation.stamps[lens];
  const kept = byEntity === undefined ? undefined : byEntity[entity];
  if (kept !== undefined) {
    if (kept.identity === identity) return null;
    if (clock - kept.at < FACE_ATLAS_KNOBS.RESTOCK_MS) return null;
  }
  const { pixelRatio, hairlinePx } = core;
  const size = generation.size;
  const reach = sprites.reach(identity) * size + hairlinePx;
  const side =
    Math.ceil(reach * 2 * pixelRatio) + FACE_ATLAS_KNOBS.GUTTER_PX * 2;
  // Every look of one stamp on one page, so a run never breaks mid-face: a
  // page that fills between looks is left, and the face starts again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rects: SkRect[] = [];
    let page: Page | null = null;
    let broke = false;
    for (let layer = 0; layer < sprites.layers; layer++) {
      const cell = placeCell(generation, side);
      if (cell === null) return null;
      if (page !== null && cell.page !== page) {
        broke = true;
        break;
      }
      page = cell.page;
      const canvas = page.surface.getCanvas();
      canvas.save();
      canvas.translate(cell.x + side / 2, cell.y + side / 2);
      canvas.scale(pixelRatio, pixelRatio);
      sprites.drawLayer(canvas, identity, layer, size, hairlinePx, paints);
      canvas.restore();
      page.dirty = true;
      rects.push(Skia.XYWHRect(cell.x, cell.y, side, side));
    }
    if (!broke && page !== null) {
      return { page, rects, half: side / 2, size, identity, at: clock };
    }
  }
  return null;
}

/** Ask the worker to run on the next frame, once. */
function scheduleFaceAtlas(core: AtlasCore): void {
  'worklet';
  if (core.scheduled) return;
  const g = globalThis as unknown as {
    requestAnimationFrame?: (callback: () => void) => unknown;
  };
  if (g.requestAnimationFrame === undefined) return;
  core.scheduled = true;
  const shared = core.shared;
  g.requestAnimationFrame(() => {
    'worklet';
    // A palette change dropped this cache: its worker has nothing to do.
    const current = shared.value;
    if (current === null || current.core !== core) return;
    core.pump(shared);
  });
}

/**
 * The worker: draw what the field asked for, then the rest of the library,
 * within this frame's share, and publish the new stamps in one step. Called
 * from `requestAnimationFrame` on the UI thread; `budgetMs` Infinity does all
 * of it at once (tests).
 */
export function pumpFaceAtlas(
  shared: SharedValue<FaceAtlas | null>,
  budgetMs?: number,
): void {
  'worklet';
  const atlas = shared.value;
  if (atlas === null) return;
  const core = atlas.core;
  core.scheduled = false;
  const target = core.target;
  if (target === null || core.paints === null) {
    core.wanted = [];
    core.wantedKeys = {};
    return;
  }
  const start = now();
  const made: { lens: number; entity: string; stamp: Stamp }[] = [];
  // Stamps drawn ahead of need are for faces out of view: the field picks
  // them up the next time it records, and is not made to record for them.
  let seen = false;
  const wantBudget = budgetMs ?? FACE_ATLAS_KNOBS.WANT_BUDGET_MS;
  let index = 0;
  const wanted = core.wanted;
  for (; index < wanted.length; index++) {
    if (now() - start >= wantBudget) break;
    const want = wanted[index];
    delete core.wantedKeys[`${want.lens}:${want.entity}`];
    const stamp = stampOne(core, target, want.lens, want.entity, start);
    if (stamp !== null) {
      made.push({ lens: want.lens, entity: want.entity, stamp });
      seen = true;
    }
  }
  core.wanted = index >= wanted.length ? [] : wanted.slice(index);
  // Ahead of need, once what was asked for is drawn.
  const fill = target.fill;
  if (fill.songs !== core.songs) {
    fill.songs = core.songs;
    fill.keys = Object.keys(core.songs);
    fill.at = 0;
    fill.done = false;
  }
  const fillBudget = budgetMs ?? FACE_ATLAS_KNOBS.FILL_BUDGET_MS;
  if (core.wanted.length === 0) {
    while (
      !fill.done &&
      now() - start < fillBudget &&
      target.pages.length <= FACE_ATLAS_KNOBS.FILL_PAGES
    ) {
      if (fill.at >= fill.keys.length) {
        fill.done = true;
        break;
      }
      const entity = fill.keys[fill.at];
      fill.at += 1;
      for (let l = 0; l < core.lenses.length; l++) {
        const lens = core.lenses[l];
        const stamp = stampOne(core, target, lens, entity, start);
        if (stamp !== null) made.push({ lens, entity, stamp });
      }
    }
    if (target.pages.length > FACE_ATLAS_KNOBS.FILL_PAGES) fill.done = true;
  }
  if (made.length > 0) {
    for (let p = 0; p < target.pages.length; p++) {
      const page = target.pages[p];
      if (!page.dirty) continue;
      page.surface.flush();
      page.image = page.surface.makeImageSnapshot();
      page.dirty = false;
    }
    for (let m = 0; m < made.length; m++) {
      const { lens, entity, stamp } = made[m];
      const byEntity = target.stamps[lens] ?? {};
      target.stamps[lens] = byEntity;
      byEntity[entity] = stamp;
    }
    // A face asked for again and again fills its generation with stale
    // cells: past the cap, the size starts over.
    if (target.pages.length >= FACE_ATLAS_KNOBS.MAX_PAGES) {
      const fresh = newGeneration(target.size);
      core.generations = core.generations.map(g => (g === target ? fresh : g));
      core.target = fresh;
      dropGeneration(target);
    }
    if (seen) shared.value = { core, version: atlas.version + 1 };
  }
  uiSpan('ui.atlasPump', start);
  if (made.length > 0) {
    uiRecord(`ui.atlasMade(pages ${target.pages.length})`, made.length);
  }
  if (core.wanted.length > 0 || !target.fill.done) scheduleFaceAtlas(core);
}

/**
 * The stamps for marks at `size` under these lenses. Never draws: settles
 * which size stamps are drawn at — the one the field stands at, once a zoom
 * has come to rest there — and wakes the worker if it has work.
 */
export function faceAtlasFor(
  stamping: FaceStamping,
  lenses: readonly number[],
  size: number,
  paints: MarkPaints,
): FaceAtlas | null {
  'worklet';
  let atlas = stamping.atlas.value;
  if (atlas === null) {
    atlas = {
      core: {
        generations: [],
        target: null,
        askedSize: -1,
        lenses,
        songs: stamping.songs,
        paints,
        pixelRatio: stamping.pixelRatio,
        hairlinePx: stamping.hairlinePx,
        wanted: [],
        wantedKeys: {},
        scheduled: false,
        shared: stamping.atlas,
        pump: pumpFaceAtlas,
      },
      version: 0,
    };
    stamping.atlas.value = atlas;
  }
  const core = atlas.core;
  core.lenses = lenses;
  core.songs = stamping.songs;
  core.paints = paints;
  core.pixelRatio = stamping.pixelRatio;
  core.hairlinePx = stamping.hairlinePx;
  if (!(size > 0)) return atlas;
  // A zoom passes through every size: stamps are drawn for one only once
  // the size holds still (or there are none yet at all).
  const still = core.askedSize === size;
  core.askedSize = size;
  const target = core.target;
  if (target === null || !fits(size, target.size)) {
    let found: Generation | null = null;
    for (let index = 0; index < core.generations.length; index++) {
      const generation = core.generations[index];
      if (fits(size, generation.size)) found = generation;
    }
    if (found === null && (still || target === null)) {
      found = newGeneration(size);
      core.generations.push(found);
      // The least recently used sizes go.
      while (core.generations.length > FACE_ATLAS_KNOBS.GENERATIONS) {
        let oldest = 0;
        for (let index = 1; index < core.generations.length; index++) {
          if (core.generations[index].usedAt < core.generations[oldest].usedAt) {
            oldest = index;
          }
        }
        const gone = core.generations[oldest];
        core.generations.splice(oldest, 1);
        dropGeneration(gone);
      }
    }
    if (found !== null && found !== target) {
      // The library is walked again at the new size; what is wanted at the
      // old one is not wanted any more.
      core.target = found;
      core.wanted = [];
      core.wantedKeys = {};
    }
  }
  if (core.target !== null) {
    core.target.usedAt = now();
    if (!core.target.fill.done || core.target.fill.songs !== core.songs) {
      scheduleFaceAtlas(core);
    }
  }
  return atlas;
}

/**
 * This face's stamp under `lens` for a mark at `size`, or null — it is then
 * drawn as paths, and asked for, so the worker draws it. A stamp drawn at a
 * bigger size serves a smaller face; one drawn at a smaller size does not.
 */
export function stampFor(
  atlas: FaceAtlas,
  lens: number,
  entityKey: string,
  identity: LensIdentity,
  size: number,
): Stamp | null {
  'worklet';
  const core = atlas.core;
  let best: Stamp | null = null;
  let exact = false;
  for (let index = 0; index < core.generations.length; index++) {
    const generation = core.generations[index];
    const byEntity = generation.stamps[lens];
    const stamp = byEntity === undefined ? undefined : byEntity[entityKey];
    if (stamp === undefined || stamp.identity !== identity) continue;
    if (stamp.page.image === null) continue;
    const fit = size / stamp.size;
    if (fit > FACE_ATLAS_KNOBS.FIT_HIGH) continue;
    if (fit >= FACE_ATLAS_KNOBS.FIT_LOW) {
      best = stamp;
      exact = true;
      break;
    }
    // Of the bigger stamps, the closest.
    if (best === null || stamp.size < best.size) best = stamp;
  }
  const target = core.target;
  if (!exact && target !== null && fits(size, target.size)) {
    const key = `${lens}:${entityKey}`;
    if (core.wantedKeys[key] !== true) {
      core.wantedKeys[key] = true;
      core.wanted.push({ lens, entity: entityKey });
      scheduleFaceAtlas(core);
    }
  }
  return best;
}

/**
 * Stamps waiting to be drawn, in the order the faces were met: entries
 * `start` to `end` of the pool, their source rects, and the page they all
 * come from. A stamp from another page draws the run first, so faces overlap
 * in the order they were met whatever page each is on.
 */
export type StampBatch = {
  pool: StampPool | null;
  canvas: SkCanvas;
  paint: SkPaint;
  page: Page | null;
  rects: SkRect[];
  start: number;
  end: number;
};

export function createStampBatch(
  pool: StampPool | null,
  canvas: SkCanvas,
  paint: SkPaint,
): StampBatch {
  'worklet';
  return { pool, canvas, paint, page: null, rects: [], start: 0, end: 0 };
}

/** Draw what the batch holds, in one call, and empty it. */
export function flushStamps(batch: StampBatch): void {
  'worklet';
  const pool = batch.pool;
  const image = batch.page === null ? null : batch.page.image;
  if (batch.end > batch.start && pool !== null && image !== null) {
    // The picture keeps its own copy of what it is handed, so the pool's
    // entries are free again for the next batch.
    batch.canvas.drawAtlas(
      image,
      batch.rects,
      pool.xforms.slice(batch.start, batch.end),
      batch.paint,
      BlendMode.Modulate,
      pool.colors.slice(batch.start, batch.end),
      { filter: FilterMode.Linear, mipmap: MipmapMode.None },
    );
  }
  batch.rects = [];
  batch.start = batch.end;
}

/**
 * Add one face's layers to the batch from `stamp` (`stampFor`), centred on
 * `(cx, cy)` at `size`.
 */
export function stampFace(
  batch: StampBatch,
  stamp: Stamp,
  cx: number,
  cy: number,
  size: number,
  alphas: readonly number[],
  layers: number,
  pixelRatio: number,
): void {
  'worklet';
  const pool = batch.pool;
  if (pool === null) return;
  if (batch.page !== stamp.page) {
    flushStamps(batch);
    batch.page = stamp.page;
  }
  const k = size / stamp.size / pixelRatio;
  const tx = cx - stamp.half * k;
  const ty = cy - stamp.half * k;
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
}
