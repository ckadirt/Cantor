import type { SkCanvas, SkPaint } from '@shopify/react-native-skia';
import type { FaceRecipe } from './face';

/**
 * The lens contract: what the field's renderer may ask of a lens.
 *
 * A lens is how a song is drawn — the circle, the seal, the tree after them.
 * The renderer (`features/field/FieldCanvas.tsx`) decides *where* a song is and
 * *how present* it is; the lens decides only what it looks like there. So a new
 * lens is a new file here and one entry in `LENSES`, and nothing under
 * `features/field/` changes. That is the whole point of R6 in
 * `docs/refactor/field-rewrite-log.md`, which also has the port order: this
 * contract grows one method per step as the renderer's lens code moves behind
 * it.
 *
 * A lens comes in two halves, because the drawing runs on the UI thread and the
 * UI thread can only call worklets:
 *
 * - **`identity`, on the JS thread**, once per song and cached: everything the
 *   drawing needs that is expensive to build — paths, arrays — from the recipe
 *   alone. It takes no analysis, so a lens *cannot* draw an identity that
 *   depends on having the audio: the two-layer rule in `cantor/AGENTS.md`
 *   ("Every lens is two layers") is a type here.
 * - **`LensUi`, on the UI thread**: worklets and plain numbers only. A worklet
 *   that captures an object copies it across; a plain function inside that
 *   copy is one the UI thread cannot call. So the renderer captures the array
 *   of these halves (`LENS_UI`) and never the whole `Lens`.
 */

/**
 * What a lens's identity is, from the renderer's side: something it prepared,
 * holds, and hands back. Only the lens that built it knows its shape.
 */
export type LensIdentity = unknown;

/**
 * A song's download, as a lens is told it (`arriving`): a fraction 0..1 while
 * the bytes land, or one of these. A lens draws its own indicator for it — the
 * circle an arc round the face, the seal its dust filling in along its thread —
 * because the reading must survive every lens, not its form (the circle's
 * grey / black / filled hierarchy is the same rule; see `availability.ts`).
 */
export const ARRIVING_NONE = -1;
/** Arriving, but the node offered no size, so progress is unknowable. */
export const ARRIVING_UNKNOWN = -2;
/**
 * KNOB — how much of a download of unknown size a lens shows as landed: a
 * fixed share that says "arriving" without claiming how far (the circle's
 * 70° sweep).
 */
export const ARRIVING_UNKNOWN_SHARE = 70 / 360;

/**
 * A download that stopped part of the way — its node left, or nothing is
 * resuming it — is said as `ARRIVING_HELD_BASE - share`: the arc stays where
 * it stopped and is drawn faint (`folio.html#errors`). One number, so the
 * lens contract's signature does not change.
 */
export const ARRIVING_HELD_BASE = -10;
/** KNOB — how present a stopped download's arc is: faint, not gone. */
export const ARRIVING_HELD_ALPHA = 0.35;

/** `arriving` for a download that stopped at `share` (0..1, or null if unknown). */
export function arrivingHeld(share: number | null): number {
  'worklet';
  return (
    ARRIVING_HELD_BASE -
    (share === null ? ARRIVING_UNKNOWN_SHARE : Math.min(1, Math.max(0, share)))
  );
}

/** Whether `arriving` says a download that has stopped, not one that moves. */
export function isArrivingHeld(arriving: number): boolean {
  'worklet';
  return arriving <= ARRIVING_HELD_BASE;
}

/** How much of a download to show as landed, 0..1; see `ARRIVING_NONE`. */
export function arrivedShare(arriving: number): number {
  'worklet';
  if (arriving === ARRIVING_UNKNOWN) return ARRIVING_UNKNOWN_SHARE;
  if (arriving <= ARRIVING_HELD_BASE)
    return Math.min(1, Math.max(0, ARRIVING_HELD_BASE - arriving));
  return Math.min(1, Math.max(0, arriving));
}

/**
 * The two paints a mark is drawn with. Prepared once by the renderer and
 * mutated per draw — `drawPath` copies the paint's state into the display
 * list at the call, so one paint carries a different alpha for every song.
 */
export type MarkPaints = Readonly<{ fill: SkPaint; stroke: SkPaint }>;

/** A player's paints: a mark's, and the ground, for anything cut out of ink. */
export type PlayerPaints = MarkPaints & Readonly<{ paper: SkPaint }>;

/**
 * What a lens's player draws from, prepared on the JS thread for the one song
 * the camera is in (`Lens.player`). Its shape is the lens's own; the renderer
 * reads only `sound`, which is null until the song has been measured — so it
 * knows when a sound has arrived and should rise rather than appear.
 */
export type LensPlayer = Readonly<{ sound: unknown }>;

/**
 * A lens's clock at the player, as numbers — what the renderer's one clock
 * (`PlayerRing`) is drawn from, and interpolates between two lenses when the
 * lens changes. The circle's arc and hand and the seal's rim and knob are the
 * same clock at two shapes; a lens that lacks a part gives it no ink, and keeps
 * the other lens's width for it, so nothing but its ink changes size.
 */
export type ClockShape = Readonly<{
  /** Where the clock runs, as a fraction of the player's radius. */
  ratio: number;
  /** The heard part of the ring, from twelve o'clock to the playhead. */
  heardWidthPx: number;
  /** The hand's two ends, as fractions of the radius; equal is no hand. */
  handInnerRatio: number;
  handOuterRatio: number;
  handWidthPx: number;
  /** The whole ring under the heard part. */
  rimAlpha: number;
  rimWidthPx: number;
  /** Twelve, three, six and nine, pointing in from the ring. */
  tickAlpha: number;
  tickPx: number;
  /** The knob at the playhead, on the ring; 0 is none. */
  knobRadiusPx: number;
}>;

export type LensUi = Readonly<{
  /**
   * The song as a mark (L0) or the face beside a row (L1).
   *
   * One drawing at two sizes — the row's face *is* the mark's, larger — so
   * one function. Drawn centred on the origin, which the renderer has already
   * moved to the song's seat.
   *
   * - `size`: the scale to draw the identity at, 1 being the mark.
   * - `alpha`: how present the song is (the renderer's bands, ownership, and
   *   the lens change's own ink).
   * - `weight`, `fill`: what the phone holds of the song — the outline's
   *   alpha and how filled it is (`songInkOf`), already carried along the ink
   *   arrival's clock.
   * - `arrived`: 0 for every mark; for the one song growing into the player,
   *   how far its shape has arrived (`songShapeArrival`).
   * - `arriving`: the download, see `ARRIVING_NONE`.
   * - `hairlinePx`: the line width on screen, whatever `size` is.
   */
  drawMark: (
    canvas: SkCanvas,
    identity: LensIdentity,
    size: number,
    alpha: number,
    weight: number,
    fill: number,
    arrived: number,
    arriving: number,
    hairlinePx: number,
    paints: MarkPaints,
  ) => void;
  /**
   * The song as the player (L2), from where it leaves its row onwards.
   *
   * `player` is what `Lens.player` built, or null for a lens whose player is
   * its mark grown (the circle's). `size`, `alpha`, `weight`, `fill`,
   * `arrived`, `arriving` and `hairlinePx` are `drawMark`'s. `soundIn` is how far the
   * song's sound has risen into the drawing (0 until it is measured and the
   * camera has arrived); `heard` is the playhead, 0..1, or -1 when nothing
   * this lens draws needs it (see `hearsPlayhead`).
   */
  drawPlayer: (
    canvas: SkCanvas,
    player: LensPlayer | null,
    identity: LensIdentity,
    size: number,
    alpha: number,
    weight: number,
    fill: number,
    arrived: number,
    arriving: number,
    soundIn: number,
    heard: number,
    hairlinePx: number,
    paints: PlayerPaints,
  ) => void;
  /**
   * 1 if this lens shows the song's measurement as the ring of ticks the
   * renderer draws round the player (`drawSongDetail`), 0 if not.
   *
   * A number, not a drawing, because the ring is not the lens's to draw: it is
   * the grain's coarse layer (it opens out into L3) and it moves with the
   * playhead, which the faces' picture must never read. The circle's sound
   * *is* that ring; the seal's lives in its dots.
   */
  ringTicks: number;
  /**
   * 1 if `drawPlayer` reads `heard`, 0 if not. The faces' picture reads the
   * playhead only while a lens that draws it is showing — otherwise every
   * frame of playback would re-record the whole field for nothing.
   */
  hearsPlayhead: number;
  /** The player's clock; see `ClockShape`. */
  clock: ClockShape;
}>;

/**
 * What a finger landing on the player means, to the lens drawn there.
 *
 * - `seek`: a moment on a ring, and a drag from here keeps seeking
 *   (`LensTouchUi.seekAt`). `fraction` is null where the landing point itself
 *   names no moment — the dead centre of the circle — but the drag still
 *   counts once it reaches the ring.
 * - `tap`: a moment to jump to when the finger lifts, abandoned if it wanders
 *   off first; null if the point under it names nothing.
 */
export type LensTouch = Readonly<
  | { kind: 'seek'; fraction: number | null }
  | { kind: 'tap'; fraction: number | null }
>;

/**
 * A lens's answer to a finger on the player. On the JS half, because the scrub
 * gesture runs on the JS thread. Coordinates are relative to the player's
 * centre and sizes to its radius, so a lens never needs the renderer's poses.
 */
export type LensTouchUi = Readonly<{
  /** How far from the centre the touch box reaches, of the player's radius. */
  reachRatio: number;
  /** What a finger landing here means, or null for "not this lens's". */
  landAt: (
    recipe: FaceRecipe,
    dx: number,
    dy: number,
    radius: number,
  ) => LensTouch | null;
  /** Where a seeking drag is now, or null to skip this point. */
  seekAt: (dx: number, dy: number, radius: number) => number | null;
}>;

/**
 * A hand-written change between two lenses' players, used instead of the
 * generic two beats — the circle's dots walking out into the seal, say. Only
 * the player has one; marks and rows always take the beats.
 *
 * Keyed by lens key in `lenses/pairs.ts`; the registry resolves the keys to
 * positions (`LENS_PAIRS`). `t` runs 0 → 1 toward `b`, whichever way the change
 * is going, and at `t` 0 the morph must look like `a`'s own player — the
 * renderer draws `a` itself there (see `drawFieldFaces`).
 */
export type LensPairMorph = Readonly<{
  a: string;
  b: string;
  drawPlayer: PairDraw;
}>;

export type LensPairUi = Readonly<{
  a: number;
  b: number;
  drawPlayer: PairDraw;
}>;

type PairDraw = (
  canvas: SkCanvas,
  aIdentity: LensIdentity,
  aPlayer: LensPlayer | null,
  bIdentity: LensIdentity,
  bPlayer: LensPlayer | null,
  t: number,
  size: number,
  alpha: number,
  weight: number,
  fill: number,
  arrived: number,
  arriving: number,
  soundIn: number,
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
) => void;
