import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
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
import type { MotionFrame } from './motion/motionFrame';
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
  /**
   * The sound rises as an iris from the nib, not as a crossfade: two
   * half-inked baths a frame apart read as a ghost (`PlayerPaints.share`).
   * Its widest, over the bath's clip radius: enough to reach the far edge.
   */
  IRIS_REACH: 2.1,
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
  sound: MarbleTimeline | null;
  duration: number;
  /** From the bath's units to px at the mark's size. */
  markScale: number;
  /** The identity at the player's resolution, at mark px. */
  outline: SkPath;
  ink: SkPath;
  baked: SharedValue<MarbleBake | null>;
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
};

const feeds = new WeakMap<object, BathFeed>();
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
  _analysis?: unknown,
  _cover?: unknown,
  track: MotionTrack | null = null,
): MarblePlayer {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${recipe.model}\u001f${
    recipe.durationMs
  }\u001f${recipe.imported === true ? 'i' : ''}\u001f${trackId(track)}`;
  const cached = playerCache.get(key);
  if (cached !== undefined) return cached;
  const identity = marbleIdentity(
    recipe,
    MARBLE_KNOBS.PLAYER_POINTS,
    MARBLE_BATH_KNOBS.SEG_MAX,
  );
  const markScale = MARBLE_MARK_REACH_PX / identity.reach;
  const timeline = track === null ? null : marbleTimeline(recipe, track, identity.reach);
  const player: MarblePlayer = {
    sound: timeline,
    duration: track === null ? recipe.durationMs / 1000 : track.duration,
    markScale,
    outline: marbleRingsPath(identity.surface, markScale, false),
    ink: marbleRingsPath(identity.surface, markScale, true),
    baked: slot<MarbleBake | null>(null),
  };
  if (timeline !== null) {
    feeds.set(player, {
      id: nextBathId++,
      init: { rings: plainRings(identity.surface), ops: timeline.ops, extEnd: timeline.extEnd },
      sent: false,
      wanted: -1,
      landed: -1,
      busy: false,
      warmed: false,
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
  if (feed.wanted >= 0 && feed.wanted !== feed.landed) {
    const k = feed.wanted;
    feed.busy = true;
    onBathRuntime(bathBakeOn, feed.id, feed.sent ? null : feed.init, k).then(
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
  float f = c.r;
  float l = c.g;
  if (found) {
    f = mix(f, dropInk, cov);
    l = max(l * (1.0 - cov), dropLine);
  }
  float a = 1.0 - (1.0 - clamp(f, 0.0, 1.0) * fillA) * (1.0 - clamp(l, 0.0, 1.0) * lineA);
  a *= 1.0 - smoothstep(clipR * ${1 - MARBLE_PLAYER_KNOBS.EDGE_FADE}, clipR, length(p));
  a *= ink.a;
  return half4(ink.rgb * a, a);
}`;

const effect = Skia.RuntimeEffect.Make(MARBLE_SKSL);
if (effect === null) throw new Error('The marbling shader did not compile.');
const MARBLE_EFFECT = effect;

/**
 * The live layer's uniforms for the playhead at `t`: the ops between the bake
 * and the playhead, each as far as it has landed. Writes into `u`; returns
 * how many ops it holds.
 */
export function marbleLiveOps(
  sound: MarbleTimeline,
  bakedKey: number,
  t: number,
  landing: boolean,
  u: number[],
  offset: number,
): number {
  'worklet';
  const LIVE = MARBLE_PLAYER_KNOBS.LIVE_MAX;
  const ops = sound.ops;
  let count = 0;
  if (landing) {
    for (let i = bakedKey; i < ops.length && ops[i].t <= t && count < LIVE; i += 1) {
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

/** The identity, as paths: the player before its sound, and under its iris. */
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

/**
 * The player: the identity until its sound has risen, then the bath at the
 * playhead, revealed from the nib in a widening iris; and the nib, where the
 * next bar's ink falls, on a hairline from the rim (the rim and its heard arc
 * are the renderer's clock, `ClockShape`).
 *
 * `motion` null — reduced motion, or not the song playing — draws the settled
 * bath with nothing landing: it changes once a bar, by a cut (decision 1).
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
): void {
  'worklet';
  const K = MARBLE_PLAYER_KNOBS;
  // Mark px → screen px: the mark grown, and a little more as it arrives.
  const k = size * (1 + (K.GROW - 1) * arrived);
  const inkAlpha = alpha * (fill + (1 - fill) * arrived);
  const lineAlpha = alpha * (weight + (1 - weight) * arrived);
  const sound = player.sound;
  const bake = player.baked.value;
  const rising = sound === null || bake === null ? 0 : soundIn;
  if (rising < 1) {
    drawIdentity(canvas, player, k, lineAlpha, inkAlpha, hairlinePx, paints);
  }
  if (sound === null || bake === null || rising <= 0) return;
  const t =
    motion !== null ? motion.t : heard >= 0 ? heard * player.duration : 0;
  const settled = marbleSettledAt(sound, t);
  // Behind the bake (a seek back that has not been baked yet): draw the bake.
  const landing = motion !== null && bake.key <= settled;
  const ext = landing ? marbleExtAt(sound, t, bake.key) : marbleExtAt(sound, t, settled);
  const reach = sound.ext0;
  const s = player.markScale * k * (reach / ext);
  const clipR = player.markScale * k * reach * K.CLIP_RATIO;
  // In the shader's order: s … lineHalf, count, then the ops.
  const u = new Array<number>(12 + 8 * K.LIVE_MAX).fill(0);
  u[11] = marbleLiveOps(sound, bake.key, t, landing, u, 12);
  const colour = paints.fill.getColor();
  u[0] = s;
  u[1] = bake.scale;
  u[2] = bake.half;
  u[3] = inkAlpha;
  u[4] = lineAlpha;
  u[5] = colour[0];
  u[6] = colour[1];
  u[7] = colour[2];
  u[8] = 1;
  u[9] = clipR;
  u[10] = MARBLE_BATH_KNOBS.BAKE_LINE_PX / 2 / bake.scale;
  const shaderPaint = Skia.Paint();
  shaderPaint.setAntiAlias(true);
  shaderPaint.setShader(MARBLE_EFFECT.makeShaderWithChildren(u, [bake.shader]));
  const head = player.duration > 0 ? Math.min(1, Math.max(0, t / player.duration)) : 0;
  const angle = -Math.PI / 2 + head * Math.PI * 2;
  const nibR = MARBLE_TIMELINE_KNOBS.BAR_AT * reach * player.markScale * k;
  const nibX = Math.cos(angle) * nibR;
  const nibY = Math.sin(angle) * nibR;
  canvas.save();
  if (rising < 1) {
    // The iris: the heard bath opening from the nib over the identity.
    const iris = rising * clipR * K.IRIS_REACH;
    const clip = Skia.PathBuilder.Make().addCircle(nibX, nibY, iris).detach();
    canvas.clipPath(clip, 1, true);
    paints.paper.setAlphaf(alpha);
    canvas.drawCircle(0, 0, clipR + hairlinePx, paints.paper);
  }
  canvas.drawRect(Skia.XYWHRect(-clipR - 1, -clipR - 1, clipR * 2 + 2, clipR * 2 + 2), shaderPaint);
  canvas.restore();
  // The nib and its hairline from the rim, rising with the sound.
  const nibAlpha = alpha * rising * arrived;
  if (nibAlpha <= 0) return;
  const rim =
    (SEAL_PLAYER_KNOBS.RIM_RATIO * NAME_LENS_KNOBS.MARK_RADIUS_PX * size) /
    NAME_LENS_KNOBS.SONG_FACE_RATIO;
  paints.stroke.setAlphaf(nibAlpha * K.NIB_LINE_ALPHA);
  paints.stroke.setStrokeWidth(K.NIB_LINE_PX);
  canvas.drawLine(Math.cos(angle) * rim, Math.sin(angle) * rim, nibX, nibY, paints.stroke);
  const beat = motion === null ? 0 : motion.beat * motion.presence * motion.beatSure;
  const r = K.NIB_RADIUS_PX + K.NIB_BEAT_PX * beat;
  paints.paper.setAlphaf(nibAlpha);
  canvas.drawCircle(nibX, nibY, r + K.NIB_EDGE_PX, paints.paper);
  paints.fill.setAlphaf(nibAlpha);
  canvas.drawCircle(nibX, nibY, r, paints.fill);
}
