import type { SkCanvas, SkPaint } from '@shopify/react-native-skia';

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
    hairlinePx: number,
    paints: MarkPaints,
  ) => void;
  /**
   * The song as the player (L2), from where it leaves its row onwards.
   *
   * `player` is what `Lens.player` built, or null for a lens whose player is
   * its mark grown (the circle's). `size`, `alpha`, `weight`, `fill`,
   * `arrived` and `hairlinePx` are `drawMark`'s. `soundIn` is how far the
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
  soundIn: number,
  heard: number,
  hairlinePx: number,
  paints: PlayerPaints,
) => void;
