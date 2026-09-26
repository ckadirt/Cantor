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
}>;
