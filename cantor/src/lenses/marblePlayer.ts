import {
  BlendMode,
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkCanvas,
  type SkPath,
  type SkPicture,
  type SkShader,
  type SkSurface,
} from '@shopify/react-native-skia';
import { PixelRatio } from 'react-native';
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import {
  createWorkletRuntime,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';
import type { LensPlayer, PlayerPaints } from './contract';
import type { FaceRecipe } from './face';
import { MARBLE_KNOBS, marbleIdentity, type MarbleSurface } from './marble';
import {
  MARBLE_BATH_KNOBS,
  bathAt,
  bathBake,
  bathBakeOn,
  bathStateOf,
  bathWarmOn,
  plainRings,
  type BakeAsk,
  type BathInit,
  type BathState,
  type MarbleBake,
} from './marbleBath';
import { MARBLE_MARK_REACH_PX, marbleRingsPath } from './marbleMark';
import {
  MARBLE_TIMELINE_KNOBS,
  marbleExtAt,
  marbleLanded,
  marbleSettledAt,
  marbleTimeline,
  type MarbleTimeline,
} from './marbleTimeline';
import {
  buildMarbleMorph,
  cachedMarbleMorph,
  drawMarbleMorphPaths,
  morphShares,
  ringDepths,
  type MarbleMorph,
  type MorphSide,
} from './marbleMorph';
import type { MotionFrame } from './motion/motionFrame';
import type { SongAnalysis } from './analysis';
import type { CoverArt } from './cover';
import { marbleSidesOf } from './marbleSides';
import type { MotionTrack } from './motion/motionTrack';
import { NAME_LENS_KNOBS } from './nameLens';
import { SEAL_PLAYER_KNOBS } from './seal';

/**
 * Marbling as the player: the song so far as one bath, and the strokes still
 * landing on it.
 *
 * Drawn the page's way, marbling is hundreds of filled shapes that all change
 * on every drop — the worst case for `cantor/AGENTS.md`'s rule that a path
 * changing every frame is rasterised on the CPU every frame. So the player is
 * split by how fast things change (docs/interfacealpha/marbling-plan.md):
 *
 * 1. **The settled bath**, on the JS thread (`bakeMarble`): every ring pushed
 *    through every op that has finished landing, drawn once into an image —
 *    ink in its red channel, outlines in its green — and handed across in a
 *    shared value. It changes about once a bar. Keyframes every
 *    `KEYFRAME_EVERY` ops, so a seek never replays the song.
 * 2. **What is landing now**, on the GPU (`MARBLE_SKSL`): for each pixel the
 *    inverse of the few ops still landing, newest first, then the image read
 *    there. A pixel inside a drop still landing takes that drop's colour. The
 *    ops' fractions come from the playhead, so every frame is still a pure
 *    function of it.
 *
 * The image is a mask, not a colour: the shader tints it with the palette's
 * ink and the player's alphas, so one bake serves both palettes, every
 * availability and every hand-over.
 */

/** KNOBS — marbling at the player. */
export const MARBLE_PLAYER_KNOBS = {
  /**
   * How much larger than the mark grown the bath is once the player has
   * arrived, so its edge sits near the seal's rim rather than well inside
   * it. Eased in by `arrived`, so at the hand-off it is the mark.
   */
  GROW: 1.12,
  /**
   * Where the bath ends, over its extent: the oldest ink leaves past it. Its
   * extent is by area, so stretched ink reaches past this; a hard clip read as
   * a cut, so the last `EDGE_FADE` of the radius fades the ink out instead.
   */
  CLIP_RATIO: 1.04,
  EDGE_FADE: 0.14,
  /** The most ops the shader lands at once. */
  LIVE_MAX: 8,
  /**
   * How many settled ops a bake may lag behind: the shader draws the rest,
   * landed, exactly. Re-baking is a long CPU raster on the bath's runtime,
   * which on the Xiaomi cost frames while it ran; every fourth op is once
   * every ~8 s instead of every bar. A bar's drop, its comb and a bullseye's
   * two drops still leave room under `LIVE_MAX`.
   */
  BAKE_EVERY: 4,
  /** The nib: where the next bar's ink falls, on a hairline from the rim. */
  NIB_RADIUS_PX: 2.6,
  NIB_BEAT_PX: 1.6,
  NIB_EDGE_PX: 1.2,
  NIB_LINE_ALPHA: 0.45,
  NIB_LINE_PX: 0.7,
  /*
   * A seek while the song plays — the back button restarting it, a drag on
   * the rim — morphs the bath from where it was to where it lands.
   */
  /** A jump of the playhead between two frames longer than this is a seek, seconds. */
  SEEK_JUMP_S: 1,
  /** How long the bath it was is held, waiting for the new one's bake, at most. */
  SEEK_WAIT_MS: 900,
  /** How long the morph takes once the new bath is here. */
  SEEK_MORPH_MS: 560,
  /** A player not drawn for this long has no "last frame" to jump from. */
  SEEK_STALE_MS: 250,
  /** How far past the bath's edge a morph opens its fade toward another lens. */
  EDGE_OPEN: 0.8,
  /** The most screen px per dp another lens is drawn at to be pushed. */
  PUSH_MAX_DENSITY: 3,
  /** Keyframes are warmed in slices this long, this far apart, on the JS thread. */
  WARM_SLICE_MS: 8,
  WARM_GAP_MS: 40,
} as const;


/**
 * The player's model, built once on the JS thread for the song the camera is
 * in. `sound` is the timeline: null until the motion track lands, and then
 * the player is its identity (decision 2 in the plan).
 */
export type MarblePlayer = Readonly<{
  /** Unique per model, so a morph built for it can be kept between frames. */
  id: number;
  sound: MarbleTimeline | null;
  duration: number;
  /** From the bath's units to px at the mark's size. */
  markScale: number;
  /** The identity at the player's resolution, at mark px. */
  outline: SkPath;
  ink: SkPath;
  /** The identity's ink as rings, in bath units, and how deep each nests, for morphs. */
  identityRings: readonly (readonly number[])[];
  identityDepths: readonly number[];
  baked: SharedValue<MarbleBake | null>;
  /**
   * The identity as the shader reads it (the bath before any op), baked once:
   * what a drop pushes aside when the sound rises, and when this player
   * leaves before it has.
   */
  still: SharedValue<MarbleBake | null>;
}>;

/**
 * What JS keeps for a player's bath: the runtime holds the bath itself
 * (`marbleBath.ts`); this is what to send it, and where the bakes stand.
 */
type BathFeed = {
  id: number;
  init: BathInit;
  /** Whether the runtime has been sent `init`. */
  sent: boolean;
  /** The key last asked for, and the last one landed. */
  wanted: number;
  landed: number;
  /** One call at a time in flight, so a scrub never queues stale bakes. */
  busy: boolean;
  warmed: boolean;
  /** Whether the still bake has been asked for. */
  stilled: boolean;
};

const feeds = new WeakMap<object, BathFeed>();
/** The bath fed last: where the queue stepped from, when the next song's first bake is asked for. */
let lastFed: BathFeed | null = null;
let nextModelId = 1;
let nextBathId = 1;

const PLAYER_CACHE_LIMIT = 8;
const playerCache = new Map<string, MarblePlayer>();
/** A number per track object, so the cache tells two measurements apart. */
const trackIds = new WeakMap<MotionTrack, number>();
let nextTrackId = 1;

function trackId(track: MotionTrack | null): number {
  if (track === null) return 0;
  let id = trackIds.get(track);
  if (id === undefined) {
    id = nextTrackId++;
    trackIds.set(track, id);
  }
  return id;
}

/** A shared value; Reanimated's Jest mock hands back the bare value. */
function slot<T>(value: T): SharedValue<T> {
  const made = makeMutable(value) as SharedValue<T> | T;
  return made !== null && typeof made === 'object' && 'value' in made
    ? (made as SharedValue<T>)
    : ({ value } as SharedValue<T>);
}

/** The model for a recipe and its track; the same object while neither changes. */
export function marblePlayerOf(
  recipe: FaceRecipe,
  analysis?: SongAnalysis,
  cover?: CoverArt | null,
  track: MotionTrack | null = null,
): MarblePlayer {
  // The analysis and the cover only shape the other lenses' sides of a morph.
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${recipe.model}\u001f${
    recipe.durationMs
  }\u001f${recipe.imported === true ? 'i' : ''}\u001f${trackId(track)}\u001f${
    analysis?.measured === true ? 'm' : ''
  }\u001f${cover == null ? '' : 'c'}`;
  const cached = playerCache.get(key);
  if (cached !== undefined) return cached;
  const identity = marbleIdentity(
    recipe,
    MARBLE_KNOBS.PLAYER_POINTS,
    MARBLE_BATH_KNOBS.SEG_MAX,
  );
  const markScale = MARBLE_MARK_REACH_PX / identity.reach;
  const identityRings = identity.surface.rings.filter(ring => ring.toggle).map(ring => Array.from(ring.pts));
  const timeline = track === null ? null : marbleTimeline(recipe, track, identity.reach);
  const player: MarblePlayer = {
    id: nextModelId++,
    sound: timeline,
    duration: track === null ? recipe.durationMs / 1000 : track.duration,
    markScale,
    outline: marbleRingsPath(identity.surface, markScale, false),
    ink: marbleRingsPath(identity.surface, markScale, true),
    identityRings,
    identityDepths: ringDepths(identityRings),
    baked: slot<MarbleBake | null>(null),
    still: slot<MarbleBake | null>(null),
  };
  if (timeline !== null) {
    feeds.set(player, {
      id: nextBathId++,
      init: {
        rings: plainRings(identity.surface),
        ops: timeline.ops,
        extEnd: timeline.extEnd,
        sides: marbleSidesOf(recipe, analysis, cover ?? null, MARBLE_PLAYER_KNOBS.GROW),
      },
      sent: false,
      wanted: -1,
      landed: -1,
      busy: false,
      warmed: false,
      stilled: false,
    });
  }
  if (playerCache.size >= PLAYER_CACHE_LIMIT) {
    const oldest = playerCache.keys().next().value;
    if (oldest !== undefined) playerCache.delete(oldest);
  }
  playerCache.set(key, player);
  return player;
}

/**
 * Which bake the playhead at `seconds` needs: the settled ops, rounded down
 * to `BAKE_EVERY`, or -1 without a sound.
 */
export function marbleBakeKey(player: LensPlayer | null, seconds: number): number {
  'worklet';
  if (player === null) return -1;
  const sound = (player as MarblePlayer).sound;
  if (sound === null) return -1;
  const settled = marbleSettledAt(sound, seconds);
  return settled - (settled % MARBLE_PLAYER_KNOBS.BAKE_EVERY);
}

/** A bath on this thread, for tests and tools: the same worklets, inline. */
const local = new WeakMap<object, BathState>();

function localState(player: MarblePlayer): BathState {
  const feed = feeds.get(player);
  if (feed === undefined) throw new Error('This player has no sound to bake.');
  let state = local.get(player);
  if (state === undefined) {
    state = bathStateOf(feed.init);
    local.set(player, state);
  }
  return state;
}

/** The settled bath after `k` ops, on this thread. */
export function marbleBathAt(player: MarblePlayer, k: number): MarbleSurface {
  return bathAt(localState(player), k);
}

/** The settled bath after `k` ops as the shader reads it, drawn on this thread. */
export function marbleBakeImage(player: MarblePlayer, k: number): MarbleBake {
  // The identity's own bake, which the sound's rise pushes aside, comes with it.
  if (player.still.value === null) player.still.value = bathBake(localState(player), 0);
  return bathBake(localState(player), k);
}

let runtime: WorkletRuntime | null | undefined;

/** The bath's own runtime, made the first time it is needed; null where there is none. */
function bathRuntime(): WorkletRuntime | null {
  if (runtime === undefined) {
    try {
      runtime = createWorkletRuntime({ name: 'marble-bath' }) ?? null;
    } catch {
      runtime = null;
    }
  }
  return runtime;
}

function onBathRuntime<Args extends unknown[], R>(
  worklet: (...args: Args) => R,
  ...args: Args
): Promise<R> {
  const here = bathRuntime();
  if (here === null) {
    try {
      return Promise.resolve(worklet(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return runOnRuntimeAsync(here, worklet, ...args);
}

/**
 * Keep the bath moving: the latest key asked for, else a slice of warming,
 * one call at a time.
 */
function pump(player: MarblePlayer, feed: BathFeed): void {
  if (feed.busy) return;
  if (!feed.stilled) {
    // The identity first: cheap, and the sound cannot rise without it.
    feed.stilled = true;
    feed.busy = true;
    onBathRuntime(bathBakeOn, feed.id, feed.sent ? null : feed.init, 0).then(
      bake => {
        feed.busy = false;
        if (bake === null) {
          feed.sent = false;
          feed.stilled = false;
        } else {
          feed.sent = true;
          player.still.value = bake;
        }
        pump(player, feed);
      },
      () => {
        feed.busy = false;
      },
    );
    return;
  }
  if (feed.wanted >= 0 && feed.wanted !== feed.landed) {
    const k = feed.wanted;
    feed.busy = true;
    // The morphs into this bake: the rise on its first, a seek's when the
    // key is not the next one along, a step's when another song's bath came
    // before it. Built on the bath's runtime with it.
    const first = feed.landed < 0;
    const before = lastFed;
    const ask: BakeAsk = {
      pairs: true,
      rise: first,
      seekFrom:
        !first && k !== feed.landed + MARBLE_PLAYER_KNOBS.BAKE_EVERY ? feed.landed : -1,
      stepFrom:
        first && before !== null && before !== feed && before.landed >= 0
          ? { id: before.id, key: before.landed }
          : null,
    };
    lastFed = feed;
    onBathRuntime(bathBakeOn, feed.id, feed.sent ? null : feed.init, k, ask).then(
      bake => {
        feed.busy = false;
        if (bake === null) {
          // The runtime let it go: send the bath again.
          feed.sent = false;
        } else {
          feed.sent = true;
          feed.landed = bake.key;
          player.baked.value = bake;
        }
        pump(player, feed);
      },
      () => {
        feed.busy = false;
        feed.landed = k;
      },
    );
    return;
  }
  if (!feed.warmed && feed.sent) {
    feed.busy = true;
    onBathRuntime(bathWarmOn, feed.id, MARBLE_PLAYER_KNOBS.WARM_SLICE_MS).then(
      done => {
        feed.busy = false;
        feed.warmed = done;
        if (!done) setTimeout(() => pump(player, feed), MARBLE_PLAYER_KNOBS.WARM_GAP_MS);
        else pump(player, feed);
      },
      () => {
        feed.busy = false;
        feed.warmed = true;
      },
    );
  }
}

/**
 * `Lens.bake`: bring the player's settled bath to `key`. Calls arrive as the
 * playhead crosses bars — faster during a scrub than a bath can be drawn —
 * so only the latest is drawn; once there, the runtime warms keyframes for
 * the rest of the song between bars.
 */
export function bakeMarble(model: LensPlayer, key: number): void {
  const player = model as MarblePlayer;
  const feed = feeds.get(player);
  if (feed === undefined || key < 0) return;
  feed.wanted = key;
  pump(player, feed);
}

/*
 * The live layer. `p` is in player px about its centre. Ops are newest last;
 * each is a drop (opB.x 0: opA = centre, radius, ink) or a tine (opB.x 1:
 * opA = direction, offset, pull × fraction; opB.y = its reach). A drop's
 * radius already carries its fraction (√landed).
 *
 * `mode` 0 reads the child as a bath mask (ink in red, outlines in green) and
 * tints it; `mode` 1 reads it as colour — another lens's player, recorded,
 * pushed aside by marbling's drop as it arrives (`drawPushedPicture`).
 */
export const MARBLE_SKSL = `
uniform shader bath;
uniform float s;
uniform float bakeScale;
uniform float bakeHalf;
uniform float fillA;
uniform float lineA;
uniform float4 ink;
uniform float clipR;
uniform float lineHalf;
uniform float count;
uniform float mode;
uniform float4 opA[${MARBLE_PLAYER_KNOBS.LIVE_MAX}];
uniform float4 opB[${MARBLE_PLAYER_KNOBS.LIVE_MAX}];
half4 main(float2 p) {
  float2 q = p / s;
  float aa = 0.6 / s;
  float cov = 0.0;
  float dropInk = 0.0;
  float dropLine = 0.0;
  bool found = false;
  for (int i = ${MARBLE_PLAYER_KNOBS.LIVE_MAX - 1}; i >= 0; i--) {
    if (float(i) >= count) continue;
    float4 a = opA[i];
    float4 b = opB[i];
    if (b.x < 0.5) {
      float2 d = q - a.xy;
      float L = length(d);
      float r = a.z;
      if (!found && L < r + aa) {
        found = true;
        cov = 1.0 - smoothstep(r - aa, r + aa, L);
        dropInk = a.w;
        dropLine = 1.0 - smoothstep(lineHalf, lineHalf + aa * 2.0, abs(L - r));
      }
      float k = sqrt(max(0.0, 1.0 - (r * r) / max(L * L, 1e-12)));
      q = a.xy + d * k;
    } else {
      float dd = abs(-q.x * a.y + q.y * a.x - a.z);
      q -= a.xy * a.w * exp(-dd / b.y);
    }
  }
  half4 c = bath.eval(q * bakeScale + float2(bakeHalf, bakeHalf));
  float edge = 1.0 - smoothstep(clipR * ${1 - MARBLE_PLAYER_KNOBS.EDGE_FADE}, clipR, length(p));
  if (mode > 0.5) {
    if (found) c *= 1.0 - cov;
    c *= edge;
    float la = found ? dropLine * lineA * edge : 0.0;
    return c * (1.0 - la) + half4(ink.rgb * la, la);
  }
  float f = c.r;
  float l = c.g;
  if (found) {
    f = mix(f, dropInk, cov);
    l = max(l * (1.0 - cov), dropLine);
  }
  float a = 1.0 - (1.0 - clamp(f, 0.0, 1.0) * fillA) * (1.0 - clamp(l, 0.0, 1.0) * lineA);
  a *= edge * ink.a;
  return half4(ink.rgb * a, a);
}`;

/** The bath's edge as a mask: opaque inside, fading over its last `EDGE_FADE`. */
const EDGE_SKSL = `
uniform float clipR;
half4 main(float2 p) {
  float a = 1.0 - smoothstep(clipR * ${1 - MARBLE_PLAYER_KNOBS.EDGE_FADE}, clipR, length(p));
  return half4(a, a, a, a);
}`;
const edge = Skia.RuntimeEffect.Make(EDGE_SKSL);
if (edge === null) throw new Error('The marbling edge did not compile.');
const EDGE_EFFECT = edge;

const effect = Skia.RuntimeEffect.Make(MARBLE_SKSL);
if (effect === null) throw new Error('The marbling shader did not compile.');
const MARBLE_EFFECT = effect;

/** Where the ops start in the uniforms: after `s` … `mode`. */
const OPS_AT = 13;

/**
 * The live layer's uniforms for the playhead at `t`: the ops between the bake
 * and the playhead, each as far as it has landed, at most `max`. Writes into
 * `u`; returns how many ops it holds.
 */
export function marbleLiveOps(
  sound: MarbleTimeline,
  bakedKey: number,
  t: number,
  landing: boolean,
  u: number[],
  offset: number,
  max: number = MARBLE_PLAYER_KNOBS.LIVE_MAX,
): number {
  'worklet';
  const LIVE = MARBLE_PLAYER_KNOBS.LIVE_MAX;
  const ops = sound.ops;
  let count = 0;
  if (landing) {
    for (let i = bakedKey; i < ops.length && ops[i].t <= t && count < max; i += 1) {
      const fraction = marbleLanded(ops[i], t);
      const op = ops[i].op;
      const a = offset + count * 4;
      const b = offset + LIVE * 4 + count * 4;
      if (op.kind === 'drop') {
        u[a] = op.x;
        u[a + 1] = op.y;
        u[a + 2] = op.r * Math.sqrt(fraction);
        u[a + 3] = op.ink ? 1 : 0;
        u[b] = 0;
        u[b + 1] = 1;
      } else {
        u[a] = op.mx;
        u[a + 1] = op.my;
        u[a + 2] = op.off;
        u[a + 3] = op.z * fraction;
        u[b] = 1;
        u[b + 1] = op.lambda;
      }
      u[b + 2] = 0;
      u[b + 3] = 0;
      count += 1;
    }
  }
  return count;
}

/** One more drop on the uniforms, after `count` ops: clear water at the centre. */
function pushDrop(u: number[], count: number, radius: number): number {
  'worklet';
  const LIVE = MARBLE_PLAYER_KNOBS.LIVE_MAX;
  const a = OPS_AT + count * 4;
  const b = OPS_AT + LIVE * 4 + count * 4;
  u[a] = 0;
  u[a + 1] = 0;
  u[a + 2] = radius;
  u[a + 3] = 0;
  u[b] = 0;
  u[b + 1] = 1;
  return count + 1;
}

/** Mark px → screen px at the player: the mark grown, and a little more as it arrives. */
function marbleScale(size: number, arrived: number): number {
  'worklet';
  return size * (1 + (MARBLE_PLAYER_KNOBS.GROW - 1) * arrived);
}

/**
 * px per the bath's own unit (a bath's rings over its extent) at the player:
 * what a morph the bath runtime built is drawn at.
 */
export function marbleUnitPx(size: number, arrived: number): number {
  'worklet';
  return MARBLE_MARK_REACH_PX * marbleScale(size, arrived);
}

/** Where the bath ends at the player, px from its centre: its edge fades to here. */
export function marbleClipPx(size: number, arrived: number): number {
  'worklet';
  return MARBLE_MARK_REACH_PX * marbleScale(size, arrived) * MARBLE_PLAYER_KNOBS.CLIP_RATIO;
}

/**
 * How far marbling's arriving drop has opened at `t` (0..1), px: its area
 * grows on the eased clock, as every drop in the bath lands. At 1 it is the
 * whole bath, and everything it pushed is past the edge.
 */
export function marbleDropRadius(t: number, clipR: number): number {
  'worklet';
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return clipR * Math.sqrt(c * c * c * (c * (6 * c - 15) + 10));
}

/**
 * Open marbling's drop: what is drawn until `leaveDrop` lands inside it — on
 * paper, scaled from the centre so that at the drop's full size it is itself.
 * Returns false (and opens nothing) while the drop is still a point.
 */
export function enterDrop(
  canvas: SkCanvas,
  radius: number,
  clipR: number,
  alpha: number,
  paints: PlayerPaints,
): boolean {
  'worklet';
  if (radius <= 0.01) return false;
  canvas.save();
  const disc = Skia.PathBuilder.Make().addCircle(0, 0, radius).detach();
  canvas.clipPath(disc, 1, true);
  paints.paper.setAlphaf(alpha);
  canvas.drawCircle(0, 0, radius, paints.paper);
  const k = radius / clipR;
  canvas.scale(k, k);
  return true;
}

export function leaveDrop(canvas: SkCanvas): void {
  'worklet';
  canvas.restore();
}

/** The shader's uniforms, before the ops. */
function uniformsOf(
  s: number,
  bakeScale: number,
  bakeHalf: number,
  fillA: number,
  lineA: number,
  colour: Float32Array,
  inkA: number,
  clipR: number,
  lineHalf: number,
  mode: number,
): number[] {
  'worklet';
  const u = new Array<number>(OPS_AT + 8 * MARBLE_PLAYER_KNOBS.LIVE_MAX).fill(0);
  u[0] = s;
  u[1] = bakeScale;
  u[2] = bakeHalf;
  u[3] = fillA;
  u[4] = lineA;
  u[5] = colour[0];
  u[6] = colour[1];
  u[7] = colour[2];
  u[8] = inkA;
  u[9] = clipR;
  u[10] = lineHalf;
  u[12] = mode;
  return u;
}

function drawShaded(canvas: SkCanvas, u: number[], child: SkShader, clipR: number): void {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setShader(MARBLE_EFFECT.makeShaderWithChildren(u, [child]));
  canvas.drawRect(Skia.XYWHRect(-clipR - 1, -clipR - 1, clipR * 2 + 2, clipR * 2 + 2), paint);
}

/**
 * A bath through the shader: the song's (`sound` given: its live ops at `t`)
 * or the identity's still bake (`sound` null), pushed aside by a clear drop
 * at the centre `push` px wide (0: none).
 */
function drawBath(
  canvas: SkCanvas,
  player: MarblePlayer,
  bake: MarbleBake,
  sound: MarbleTimeline | null,
  t: number,
  landing: boolean,
  k: number,
  inkAlpha: number,
  lineAlpha: number,
  push: number,
  paints: PlayerPaints,
): void {
  'worklet';
  const K = MARBLE_PLAYER_KNOBS;
  const reach = MARBLE_MARK_REACH_PX / player.markScale;
  let ext = reach;
  let behind = false;
  if (sound !== null) {
    const settled = marbleSettledAt(sound, t);
    behind = !landing || bake.key > settled;
    ext = behind ? marbleExtAt(sound, t, settled) : marbleExtAt(sound, t, bake.key);
  }
  const s = player.markScale * k * (reach / ext);
  const clipR = MARBLE_MARK_REACH_PX * k * K.CLIP_RATIO;
  const u = uniformsOf(
    s,
    bake.scale,
    bake.half,
    inkAlpha,
    lineAlpha,
    paints.fill.getColor(),
    1,
    clipR,
    MARBLE_BATH_KNOBS.BAKE_LINE_PX / 2 / bake.scale,
    0,
  );
  let count = 0;
  if (sound !== null && !behind) {
    count = marbleLiveOps(sound, bake.key, t, true, u, OPS_AT, push > 0 ? K.LIVE_MAX - 1 : K.LIVE_MAX);
  }
  if (push > 0) count = pushDrop(u, count, push / s);
  u[11] = count;
  drawShaded(canvas, u, bake.shader, clipR);
}

/** Screen px per dp: the field's recording is played back at this scale. */
const DENSITY = PixelRatio.get();

/** The surface another lens is drawn into to be pushed, kept between frames on the UI thread. */
function pushSurface(side: number): SkSurface | null {
  'worklet';
  const g = globalThis as unknown as { __marblePush?: { side: number; surface: SkSurface | null } };
  if (g.__marblePush === undefined || g.__marblePush.side !== side) {
    g.__marblePush = {
      side,
      surface: Skia.Surface.MakeOffscreen(side, side) ?? Skia.Surface.Make(side, side),
    };
  }
  return g.__marblePush.surface;
}

/**
 * Another lens's player, recorded, pushed aside by marbling's drop `push` px
 * wide and faded past the bath's edge: how anything that is not marbling
 * leaves when marbling arrives (`pairs.ts`). The picture is recorded with its
 * centre at (`reach`, `reach`).
 *
 * Drawn into an image at the screen's own density first, and read by the
 * shader with coordinates it maps itself, as the bath is: a picture shader as
 * the shader's child was sampled without the screen's scale on the phone (a
 * magnified corner of it), since this is recorded into the field's picture
 * and played back at the density later.
 */
export function drawPushedPicture(
  canvas: SkCanvas,
  picture: SkPicture,
  reach: number,
  clipR: number,
  push: number,
  lineAlpha: number,
  paints: PlayerPaints,
): void {
  'worklet';
  const m = canvas.getTotalMatrix().get();
  const scale = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
  const d = Math.min(MARBLE_PLAYER_KNOBS.PUSH_MAX_DENSITY, Math.max(1, scale * DENSITY));
  const side = Math.ceil(2 * reach * d);
  const surface = pushSurface(side);
  if (surface === null) {
    canvas.save();
    canvas.translate(-reach, -reach);
    canvas.drawPicture(picture);
    canvas.restore();
    return;
  }
  const target = surface.getCanvas();
  target.clear(Skia.Color('transparent'));
  target.save();
  target.scale(d, d);
  target.drawPicture(picture);
  target.restore();
  surface.flush();
  const image = surface.makeImageSnapshot();
  const child = image.makeShaderOptions(TileMode.Decal, TileMode.Decal, FilterMode.Linear, MipmapMode.None);
  const u = uniformsOf(1, d, reach * d, 1, lineAlpha, paints.fill.getColor(), 1, clipR, 0.5, 1);
  u[11] = push > 0 ? pushDrop(u, 0, push) : 0;
  drawShaded(canvas, u, child, reach);
}

/**
 * A marbling player as a morph's side: its bath's ink rings (or its
 * identity's, without one) in px about the centre, at the view the bath is
 * drawn at.
 */
export function marbleSide(
  player: MarblePlayer,
  size: number,
  arrived: number,
  bath: MarbleBake | null,
): MorphSide {
  'worklet';
  const k = marbleScale(size, arrived);
  const sound = player.sound;
  if (bath === null || sound === null) {
    const s0 = player.markScale * k;
    return {
      rings: player.identityRings.map(ring => ring.map(v => v * s0)),
      alpha: 1,
      depth: player.identityDepths,
    };
  }
  const reach = MARBLE_MARK_REACH_PX / player.markScale;
  const ext = bath.key < sound.ops.length ? sound.ops[bath.key].ext : sound.extEnd;
  const s = player.markScale * k * (reach / ext);
  return { rings: bath.rings.map(ring => ring.map(v => v * s)), alpha: 1, depth: bath.depths };
}

/** A morph's ink, faded at the bath's edge as the bath itself is. */
export function drawMarbleMorphFaded(
  canvas: SkCanvas,
  morph: MarbleMorph,
  /** The morph's clock, linear: each ring eases through its own window. */
  t: number,
  alpha: number,
  paints: PlayerPaints,
  clipR: number,
  live: readonly number[] | null = null,
  liveRing = -1,
  /**
   * How far the edge is opened, 0..1: the bath fades at its edge, another
   * lens does not, so a morph with one opens the fade toward that lens's end.
   */
  open = 0,
  hairlinePx = 1,
  /** px per the morph's own unit (`marbleUnitPx` for one the bath runtime built). */
  scale = 1,
  /** The `from` side's place in time to read alphas by, and the grey of what is still to come. */
  head = -1,
  quiet = 1,
): void {
  'worklet';
  if (alpha <= 0) return;
  const edgeR = clipR * (1 + MARBLE_PLAYER_KNOBS.EDGE_OPEN * open);
  const bounds = Skia.XYWHRect(-edgeR - 2, -edgeR - 2, edgeR * 2 + 4, edgeR * 2 + 4);
  canvas.saveLayer(undefined, bounds);
  drawMarbleMorphPaths(canvas, morph, t, alpha, paints, live, liveRing, hairlinePx, scale, head, quiet);
  const mask = Skia.Paint();
  mask.setBlendMode(BlendMode.DstIn);
  mask.setShader(EDGE_EFFECT.makeShader([edgeR]));
  canvas.drawRect(bounds, mask);
  canvas.restore();
}

/** The identity, as paths: the player before its sound, exactly the mark grown. */
function drawIdentity(
  canvas: SkCanvas,
  player: MarblePlayer,
  k: number,
  lineAlpha: number,
  inkAlpha: number,
  hairlinePx: number,
  paints: PlayerPaints,
): void {
  'worklet';
  canvas.save();
  canvas.scale(k, k);
  if (inkAlpha > 0) {
    paints.fill.setAlphaf(inkAlpha);
    canvas.drawPath(player.ink, paints.fill);
  }
  if (lineAlpha > 0) {
    paints.stroke.setAlphaf(lineAlpha);
    paints.stroke.setStrokeWidth((hairlinePx * 0.6) / k);
    canvas.drawPath(player.outline, paints.stroke);
  }
  canvas.restore();
}

/** The nib, where the next bar's ink falls, on a hairline from the rim. */
function drawNib(
  canvas: SkCanvas,
  player: MarblePlayer,
  size: number,
  k: number,
  t: number,
  alpha: number,
  motion: MotionFrame | null,
  paints: PlayerPaints,
): void {
  'worklet';
  if (alpha <= 0) return;
  const K = MARBLE_PLAYER_KNOBS;
  const head = player.duration > 0 ? Math.min(1, Math.max(0, t / player.duration)) : 0;
  const angle = -Math.PI / 2 + head * Math.PI * 2;
  const nibR = MARBLE_TIMELINE_KNOBS.BAR_AT * MARBLE_MARK_REACH_PX * k;
  const nibX = Math.cos(angle) * nibR;
  const nibY = Math.sin(angle) * nibR;
  const rim =
    (SEAL_PLAYER_KNOBS.RIM_RATIO * NAME_LENS_KNOBS.MARK_RADIUS_PX * size) /
    NAME_LENS_KNOBS.SONG_FACE_RATIO;
  paints.stroke.setAlphaf(alpha * K.NIB_LINE_ALPHA);
  paints.stroke.setStrokeWidth(K.NIB_LINE_PX);
  canvas.drawLine(Math.cos(angle) * rim, Math.sin(angle) * rim, nibX, nibY, paints.stroke);
  const beat = motion === null ? 0 : motion.beat * motion.presence * motion.beatSure;
  const r = K.NIB_RADIUS_PX + K.NIB_BEAT_PX * beat;
  paints.paper.setAlphaf(alpha);
  canvas.drawCircle(nibX, nibY, r + K.NIB_EDGE_PX, paints.paper);
  paints.fill.setAlphaf(alpha);
  canvas.drawCircle(nibX, nibY, r, paints.fill);
}

/** What a player drew last frame, and a seek in flight: kept on the UI thread. */
type SeekState = {
  lastT: number;
  lastAt: number;
  lastBake: MarbleBake | null;
  /** The bath it was when the playhead jumped, and where; null when no seek is in flight. */
  from: MarbleBake | null;
  fromT: number;
  asked: number;
  /** When the morph began (the new bath here), or -1 while it waits for it. */
  start: number;
};

function seekState(id: number): SeekState {
  'worklet';
  const g = globalThis as unknown as { __marbleSeek?: Map<number, SeekState> };
  if (g.__marbleSeek === undefined) g.__marbleSeek = new Map();
  let state = g.__marbleSeek.get(id);
  if (state === undefined) {
    state = { lastT: -1, lastAt: 0, lastBake: null, from: null, fromT: 0, asked: 0, start: -1 };
    g.__marbleSeek.set(id, state);
    if (g.__marbleSeek.size > 4) {
      const oldest = g.__marbleSeek.keys().next().value;
      if (oldest !== undefined && oldest !== id) g.__marbleSeek.delete(oldest);
    }
  }
  return state;
}

/**
 * A seek while the song plays: the bath it was, held still until the bake
 * for where the playhead landed is here, then morphed into it ring by ring
 * on the clock (the playhead itself just jumped, so it cannot time it).
 * Returns whether it drew the bath this frame. Paused or reduced (no
 * `motion`), a seek is a cut: there are no frames to animate it on, and a
 * paused seek is a finger on the rim.
 */
function drawMarbleSeek(
  canvas: SkCanvas,
  player: MarblePlayer,
  bake: MarbleBake,
  sound: MarbleTimeline,
  t: number,
  motion: MotionFrame | null,
  size: number,
  arrived: number,
  k: number,
  clipR: number,
  inkAlpha: number,
  lineAlpha: number,
  hairlinePx: number,
  paints: PlayerPaints,
): boolean {
  'worklet';
  const K = MARBLE_PLAYER_KNOBS;
  const now = Date.now();
  const st = seekState(player.id);
  const fresh = now - st.lastAt < K.SEEK_STALE_MS;
  if (motion === null || !fresh) {
    st.from = null;
  } else if (st.from === null && st.lastBake !== null && Math.abs(t - st.lastT) > K.SEEK_JUMP_S) {
    st.from = st.lastBake;
    st.fromT = st.lastT;
    st.asked = now;
    st.start = -1;
  }
  st.lastT = t;
  st.lastAt = now;
  const from = st.from;
  if (from === null) {
    st.lastBake = bake;
    return false;
  }
  if (st.start < 0) {
    // A seek within the bake it was drawn from has no other bath to become.
    if (marbleBakeKey(player, t) === from.key) {
      st.from = null;
      st.lastBake = bake;
      return false;
    }
    // Here once the bake is the one for where the playhead landed.
    const settled = marbleSettledAt(sound, t);
    const here = bake !== from && bake.key <= settled && settled - bake.key < K.LIVE_MAX;
    if (!here) {
      if (now - st.asked > K.SEEK_WAIT_MS) {
        st.from = null;
        st.lastBake = bake;
        return false;
      }
      // Held exactly as it was last drawn until the new bath is here.
      drawBath(canvas, player, from, sound, st.fromT, true, k, inkAlpha, lineAlpha, 0, paints);
      return true;
    }
    st.start = now;
  }
  const p = (now - st.start) / K.SEEK_MORPH_MS;
  if (p >= 1) {
    st.from = null;
    st.lastBake = bake;
    return false;
  }
  const shares = morphShares(p);
  if (shares.from > 0) {
    drawBath(canvas, player, from, sound, st.fromT, true, k, inkAlpha * shares.from, lineAlpha * shares.from, 0, paints);
  }
  if (shares.to > 0) {
    drawBath(canvas, player, bake, sound, t, true, k, inkAlpha * shares.to, lineAlpha * shares.to, 0, paints);
  }
  if (shares.morph > 0) {
    // Built with the bake on the bath's runtime, or here if it came without.
    const built = bake.morphs !== null && bake.morphs.seek !== null && bake.morphs.seek.fromKey === from.key ? bake.morphs.seek.morph : null;
    const morph =
      built ??
      cachedMarbleMorph(`seek:${player.id}:${from.key}:${bake.key}:${Math.round(size * 100)}`, () =>
        buildMarbleMorph(marbleSide(player, size, arrived, from), marbleSide(player, size, arrived, bake), clipR),
      );
    drawMarbleMorphFaded(canvas, morph, p, inkAlpha * shares.morph, paints, clipR, null, -1, 0, hairlinePx, built === null ? 1 : marbleUnitPx(size, arrived));
  }
  return true;
}

/**
 * The player: the identity until its sound has risen, then the bath at the
 * playhead; and the nib (the rim and its heard arc are the renderer's clock,
 * `ClockShape`).
 *
 * The sound rises as a morph: the identity's rings flow into the bath the
 * song has made so far (`marbleMorph.ts`). No crossfade of the two: two
 * half-inked baths read as a ghost.
 *
 * `push` (px) is the same drop arriving from outside — the next song, another
 * lens — pushing this player out. `motion` null (reduced motion, or not the
 * song playing) draws the settled bath with nothing landing: it changes once
 * a bake lands, by a cut (decision 1).
 */
export function drawMarblePlayer(
  canvas: SkCanvas,
  player: MarblePlayer,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  soundIn: number,
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
  motion: MotionFrame | null,
  push = 0,
): void {
  'worklet';
  const k = marbleScale(size, arrived);
  const clipR = marbleClipPx(size, arrived);
  const inkAlpha = alpha * (fill + (1 - fill) * arrived);
  const lineAlpha = alpha * (weight + (1 - weight) * arrived);
  const sound = player.sound;
  const bake = player.baked.value;
  const still = player.still.value;
  const rising = sound === null || bake === null ? 0 : Math.min(1, Math.max(0, soundIn));
  const t = motion !== null ? motion.t : heard >= 0 ? heard * player.duration : 0;
  const landing = motion !== null;
  const nib = alpha * rising * arrived * (push > 0 ? 1 - push / clipR : 1);
  if (push > 0) {
    // Leaving: what is drawn now, pushed aside.
    if (rising > 0 && bake !== null) {
      drawBath(canvas, player, bake, sound, t, landing, k, inkAlpha, lineAlpha, push, paints);
    } else if (still !== null) {
      drawBath(canvas, player, still, null, 0, false, k, inkAlpha, lineAlpha, push, paints);
    } else {
      drawIdentity(canvas, player, k, lineAlpha, inkAlpha, hairlinePx, paints);
    }
    drawNib(canvas, player, size, k, t, nib, motion, paints);
    return;
  }
  if (rising <= 0 || bake === null) {
    drawIdentity(canvas, player, k, lineAlpha, inkAlpha, hairlinePx, paints);
    return;
  }
  if (
    rising >= 1 &&
    sound !== null &&
    drawMarbleSeek(canvas, player, bake, sound, t, motion, size, arrived, k, clipR, inkAlpha, lineAlpha, hairlinePx, paints)
  ) {
    drawNib(canvas, player, size, k, t, nib, motion, paints);
    return;
  }
  if (rising < 1 && bake.key > 0) {
    // The identity becoming the song so far: the engine's silhouette morph,
    // ring by ring, each end handing over to the real drawing under it.
    const shares = morphShares(rising);
    if (shares.from > 0) {
      drawIdentity(canvas, player, k, lineAlpha * shares.from, inkAlpha * shares.from, hairlinePx, paints);
    }
    if (shares.to > 0) {
      drawBath(canvas, player, bake, sound, t, landing, k, inkAlpha * shares.to, lineAlpha * shares.to, 0, paints);
    }
    if (shares.morph > 0) {
      const built = bake.morphs === null ? null : bake.morphs.rise;
      const morph =
        built ??
        cachedMarbleMorph(`rise:${player.id}:${bake.key}:${Math.round(size * 100)}`, () =>
          buildMarbleMorph(marbleSide(player, size, arrived, null), marbleSide(player, size, arrived, bake), clipR),
        );
      drawMarbleMorphFaded(canvas, morph, rising, inkAlpha * shares.morph, paints, clipR, null, -1, 0, hairlinePx, built === null ? 1 : marbleUnitPx(size, arrived));
    }
  } else {
    // Nothing settled yet: the bath is the identity, and what lands, lands.
    drawBath(canvas, player, bake, sound, t, landing, k, inkAlpha, lineAlpha, 0, paints);
  }
  drawNib(canvas, player, size, k, t, nib, motion, paints);
}
