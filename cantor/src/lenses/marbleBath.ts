import {
  BlendMode,
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkImage,
  type SkShader,
} from '@shopify/react-native-skia';
import {
  applyMarbleOpRefined,
  copySurface,
  type MarbleSurface,
} from './marble';
import { marbleRingsPath } from './marbleMark';
import { buildMarbleMorph, ringDepths, type MarbleMorph, type MorphSide } from './marbleMorph';
import type { MarbleTimedOp } from './marbleTimeline';

/**
 * Marbling's settled bath: every ring pushed through every op that has
 * finished landing, drawn into an image the player's shader reads.
 *
 * All of it runs on a worklet runtime of its own (`marblePlayer.ts`), never
 * the JS or the UI thread: a bar late in a long song is tens of milliseconds
 * of geometry and well over a hundred of rasterising on the phone — on the UI
 * thread even through a GPU surface, since a path this complex is masked in
 * software — and either thread would drop frames for it once a bar. So these
 * are worklets over a state object the runtime keeps; JS sends a key and gets
 * an image back. Where there is no such runtime (Jest) the same functions run
 * inline.
 */

/** KNOBS — the bath. */
export const MARBLE_BATH_KNOBS = {
  /**
   * The longest a ring's segment may be, over the bath's extent, before an op
   * splits it (`applyMarbleOpRefined`): about 3 px at the player.
   */
  SEG_MAX: 0.012,
  /** The baked image's side, px, and how far it reaches, over the extent. */
  BAKE_PX: 1200,
  BAKE_REACH: 1.4,
  /** An outline's width in the baked image, px. */
  BAKE_LINE_PX: 1.4,
  /** How often the settled bath is kept, in ops, so a seek starts near. */
  KEYFRAME_EVERY: 8,
  /** How many songs' baths the runtime keeps. */
  KEEP: 4,
} as const;

/** The settled bath at `key` ops, as the shader reads it. */
export type MarbleBake = Readonly<{
  key: number;
  image: SkImage;
  shader: SkShader;
  /** Image px per bath unit, and where the bath's centre is in the image. */
  scale: number;
  half: number;
  /**
   * The ink as rings, in bath units: every ring whose colour differs from
   * its parent's, interleaved x, y — the even-odd path the image was drawn
   * from. What a morph to or from this bath flows (`marbleMorph.ts`).
   */
  rings: readonly (readonly number[])[];
  /** How deep each of `rings` nests: even is ink, odd a hole (`ringDepths`). */
  depths: readonly number[];
  /** Morphs into this bath, built with it; null for a bake asked for none. */
  morphs: BakeMorphs | null;
}>;

/** A ring as plain numbers, to cross into the runtime. */
export type PlainRing = Readonly<{ pts: number[]; ink: boolean; toggle: boolean }>;

/** What a bath is built from: the identity, and the song's strokes. */
export type BathInit = Readonly<{
  rings: readonly PlainRing[];
  ops: readonly MarbleTimedOp[];
  extEnd: number;
  /** The other lenses as morph sides, in the bath's unit (`marbleSides.ts`). */
  sides?: Readonly<Record<string, MorphSide>>;
}>;

/** Which morphs into a bake to build with it, beside the other lenses'. */
export type BakeAsk = Readonly<{
  /** Into it from another lens: only for a bake the player will draw, not the still one. */
  pairs: boolean;
  /** From the identity: the sound's rise. */
  rise: boolean;
  /** From the bath at this key: the playhead jumped (a seek); −1 for none. */
  seekFrom: number;
  /** From another player's bath: the queue stepped to this song; null for none. */
  stepFrom: Readonly<{ id: number; key: number }> | null;
}>;

/**
 * Morphs into a bake, built by the bath runtime in the bath's unit (a bath's
 * rings over its extent) so the UI thread only lerps them.
 */
export type BakeMorphs = Readonly<{
  pairs: Readonly<Record<string, MarbleMorph>>;
  rise: MarbleMorph | null;
  seek: Readonly<{ fromKey: number; morph: MarbleMorph }> | null;
  step: Readonly<{ fromId: number; fromKey: number; morph: MarbleMorph }> | null;
}>;

export type BathState = {
  sides: Readonly<Record<string, MorphSide>>;
  identity: MarbleSurface;
  ops: readonly MarbleTimedOp[];
  extEnd: number;
  cursor: { k: number; surface: MarbleSurface };
  keyframes: Map<number, MarbleSurface>;
  /** How far the background walk has got, and its own bath. */
  warmK: number;
  warmSurface: MarbleSurface;
};

/** The identity's rings, to send. */
export function plainRings(surface: MarbleSurface): PlainRing[] {
  return surface.rings.map(ring => ({
    pts: Array.from(ring.pts),
    ink: ring.ink,
    toggle: ring.toggle,
  }));
}

export function bathStateOf(init: BathInit): BathState {
  'worklet';
  const identity: MarbleSurface = {
    rings: init.rings.map(ring => ({
      pts: Float64Array.from(ring.pts),
      ink: ring.ink,
      toggle: ring.toggle,
    })),
  };
  return {
    sides: init.sides ?? {},
    identity,
    ops: init.ops,
    extEnd: init.extEnd,
    cursor: { k: 0, surface: copySurface(identity) },
    keyframes: new Map([[0, copySurface(identity)]]),
    warmK: 0,
    warmSurface: copySurface(identity),
  };
}

/** One op, landed and refined, on a bath: the bath's own step. */
function landOp(surface: MarbleSurface, op: MarbleTimedOp): void {
  'worklet';
  applyMarbleOpRefined(
    surface,
    op.op,
    MARBLE_BATH_KNOBS.SEG_MAX * op.ext,
    MARBLE_BATH_KNOBS.BAKE_REACH * op.ext,
  );
}

/**
 * The settled bath after `k` ops: from the nearest keyframe or the cursor at
 * or before it, keeping a keyframe every `KEYFRAME_EVERY` ops on the way.
 * Pure in `k`; the keyframes only make it cheap.
 */
export function bathAt(state: BathState, k: number): MarbleSurface {
  'worklet';
  const ops = state.ops;
  const target = Math.max(0, Math.min(ops.length, k));
  let from = 0;
  for (const at of state.keyframes.keys()) if (at <= target && at > from) from = at;
  let surface: MarbleSurface;
  if (state.cursor.k <= target && state.cursor.k >= from) {
    surface = state.cursor.surface;
    from = state.cursor.k;
  } else {
    surface = copySurface(state.keyframes.get(from)!);
  }
  const every = MARBLE_BATH_KNOBS.KEYFRAME_EVERY;
  for (let i = from; i < target; i += 1) {
    landOp(surface, ops[i]);
    if ((i + 1) % every === 0 && !state.keyframes.has(i + 1)) {
      state.keyframes.set(i + 1, copySurface(surface));
    }
  }
  state.cursor = { k: target, surface };
  return surface;
}

/**
 * Walk the song ahead for about `budgetMs`, leaving a keyframe every
 * `KEYFRAME_EVERY` ops, so a seek anywhere starts near. On its own bath, so
 * the cursor bakes use is never disturbed. True once it has reached the end.
 */
export function bathWarm(state: BathState, budgetMs: number): boolean {
  'worklet';
  const ops = state.ops;
  const every = MARBLE_BATH_KNOBS.KEYFRAME_EVERY;
  const until = Date.now() + budgetMs;
  while (state.warmK < ops.length && Date.now() < until) {
    landOp(state.warmSurface, ops[state.warmK]);
    state.warmK += 1;
    if (state.warmK % every === 0 && !state.keyframes.has(state.warmK)) {
      state.keyframes.set(state.warmK, copySurface(state.warmSurface));
    }
  }
  if (state.warmK < ops.length) return false;
  state.warmSurface = { rings: [] };
  return true;
}

/**
 * Draw the settled bath after `k` ops into an image: ink in its red channel,
 * outlines in its green (added, so the two stay apart). A mask, not a colour:
 * the shader tints it, so one bake serves every palette and alpha.
 */
export function bathBake(state: BathState, k: number): MarbleBake {
  'worklet';
  const K = MARBLE_BATH_KNOBS;
  const surface = bathAt(state, k);
  const ext = k < state.ops.length ? state.ops[k].ext : state.extEnd;
  const half = K.BAKE_PX / 2;
  const scale = half / (ext * K.BAKE_REACH);
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  fill.setColor(Skia.Color('#FF0000'));
  const line = Skia.Paint();
  line.setAntiAlias(true);
  line.setColor(Skia.Color('#00FF00'));
  line.setStyle(1);
  line.setStrokeWidth(K.BAKE_LINE_PX);
  line.setBlendMode(BlendMode.Plus);
  const target = Skia.Surface.Make(K.BAKE_PX, K.BAKE_PX);
  if (target === null) throw new Error('Could not make a surface to bake the bath on.');
  const canvas = target.getCanvas();
  canvas.clear(Skia.Color('transparent'));
  canvas.translate(half, half);
  canvas.drawPath(marbleRingsPath(surface, scale, true), fill);
  canvas.drawPath(marbleRingsPath(surface, scale, false), line);
  target.flush();
  const image = target.makeImageSnapshot();
  const rings: number[][] = [];
  for (const ring of surface.rings) if (ring.toggle) rings.push(Array.from(ring.pts));
  return {
    key: k,
    image,
    shader: image.makeShaderOptions(TileMode.Decal, TileMode.Decal, FilterMode.Linear, MipmapMode.None),
    scale,
    half,
    rings,
    depths: ringDepths(rings),
    morphs: null,
  };
}

/** The runtime's own baths, by player id: a few songs' worth, oldest dropped. */
function bathsHere(): Map<number, BathState> {
  'worklet';
  const holder = globalThis as unknown as { __marbleBaths?: Map<number, BathState> };
  if (holder.__marbleBaths === undefined) holder.__marbleBaths = new Map();
  return holder.__marbleBaths;
}

/**
 * On the bath's runtime: bake player `id`'s bath at `k`, building its state
 * from `init` the first time. Null when the runtime no longer holds it and no
 * `init` came: send it again.
 */
/** A bath's ink as a morph side, in its own unit: rings over its extent at `k`. */
function bathSide(state: BathState, surface: MarbleSurface, k: number): MorphSide {
  'worklet';
  const ext = k < state.ops.length ? state.ops[k].ext : state.extEnd;
  const rings: number[][] = [];
  for (const ring of surface.rings) {
    if (!ring.toggle) continue;
    const out: number[] = [];
    for (let i = 0; i < ring.pts.length; i++) out.push(ring.pts[i] / ext);
    rings.push(out);
  }
  return { rings, alpha: 1, depth: ringDepths(rings) };
}

/**
 * On the bath's runtime: bake player `id`'s bath at `k`, building its state
 * from `init` the first time, and the morphs `ask` names into it. Null when
 * the runtime no longer holds it and no `init` came: send it again.
 */
export function bathBakeOn(
  id: number,
  init: BathInit | null,
  k: number,
  ask: BakeAsk | null = null,
): MarbleBake | null {
  'worklet';
  const baths = bathsHere();
  let state = baths.get(id);
  if (state === undefined) {
    if (init === null) return null;
    state = bathStateOf(init);
    baths.set(id, state);
    while (baths.size > MARBLE_BATH_KNOBS.KEEP) {
      const oldest = baths.keys().next().value;
      if (oldest === undefined) break;
      baths.delete(oldest);
    }
  }
  if (ask === null) return bathBake(state, k);
  // The other sides first: `bathBake` leaves the cursor at `k`.
  const rise = ask.rise ? bathSide(state, state.identity, 0) : null;
  let seekSide: MorphSide | null = null;
  if (ask.seekFrom >= 0) seekSide = bathSide(state, copySurface(bathAt(state, ask.seekFrom)), ask.seekFrom);
  let stepSide: MorphSide | null = null;
  if (ask.stepFrom !== null) {
    const other = baths.get(ask.stepFrom.id);
    if (other !== undefined) stepSide = bathSide(other, copySurface(bathAt(other, ask.stepFrom.key)), ask.stepFrom.key);
  }
  const bake = bathBake(state, k);
  const ext = k < state.ops.length ? state.ops[k].ext : state.extEnd;
  const here: MorphSide = {
    rings: bake.rings.map(ring => ring.map(v => v / ext)),
    alpha: 1,
    depth: bake.depths,
  };
  const pairs: Record<string, MarbleMorph> = {};
  if (ask.pairs) for (const key of Object.keys(state.sides)) pairs[key] = buildMarbleMorph(state.sides[key], here, 1);
  return {
    ...bake,
    morphs: {
      pairs,
      rise: rise === null || k === 0 ? null : buildMarbleMorph(rise, here, 1),
      seek: seekSide === null ? null : { fromKey: ask.seekFrom, morph: buildMarbleMorph(seekSide, here, 1) },
      step:
        stepSide === null || ask.stepFrom === null
          ? null
          : { fromId: ask.stepFrom.id, fromKey: ask.stepFrom.key, morph: buildMarbleMorph(stepSide, here, 1) },
    },
  };
}

/** On the bath's runtime: warm player `id`'s keyframes; true once done (or gone). */
export function bathWarmOn(id: number, budgetMs: number): boolean {
  'worklet';
  const state = bathsHere().get(id);
  return state === undefined ? true : bathWarm(state, budgetMs);
}
