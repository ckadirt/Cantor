/**
 * An album's cover as ink: a grid of brightness cells, each drawn as a glyph
 * whose density is how dark the cell is — the cover the way a terminal would
 * print it, in the field's own hairline.
 *
 * Never stored (docs/import/plan.md § Decisions 1): the album's small cached
 * thumbnail is reduced natively to `COVER_KNOBS.CELLS`² brightness values
 * (`nativeMedia.artworkLuma`) whenever a song with it is opened, and this
 * turns them into glyph levels. Both steps are milliseconds.
 *
 * Geometry only: no Skia here, so the mapping can be tested without a canvas.
 * The drawing is `coverLens.ts`'s.
 */

/** KNOBS — the cover's grain. */
export const COVER_KNOBS = {
  /**
   * Cells along each side. Thirty-two puts a glyph about 6 dp wide on this
   * phone's player: large enough to read as a character, small enough that
   * the picture survives.
   */
  CELLS: 32,
  /**
   * The share of the picture's darkest and lightest cells taken as its black
   * and white before the levels are cut, so a dim or washed-out thumbnail
   * still spans every glyph rather than three of them.
   */
  STRETCH_CLIP: 0.02,
  /**
   * Past 1, the lighter tones thin out faster than the dark ones: ink on
   * paper already reads darker than the same share of a lit screen.
   */
  GAMMA: 1.25,
  /**
   * Glyph levels past the empty one, lightest first — `·  -  +  ×  #  *`,
   * in order of how much line each is, drawn by `coverLens.ts`. A cell at
   * level 0 is paper.
   */
  LEVELS: 6,
} as const;

/** A cover, ready to draw: one glyph level per cell, row by row. */
export type CoverArt = Readonly<{
  cells: number;
  /** 0 paper … `COVER_KNOBS.LEVELS` densest, row-major from the top left. */
  levels: Uint8Array;
}>;

/**
 * Brightness cells (0 black … 1 white, row-major) as glyph levels: stretched
 * to the picture's own range, inverted into ink, and cut into levels.
 */
export function coverArtOf(luma: ArrayLike<number>, cells: number): CoverArt {
  if (luma.length !== cells * cells || cells <= 0) {
    throw new RangeError('A cover needs cells × cells brightness values.');
  }
  const sorted = Float32Array.from(luma).sort();
  const clip = Math.floor(sorted.length * COVER_KNOBS.STRETCH_CLIP);
  const black = sorted[clip];
  const white = sorted[sorted.length - 1 - clip];
  const span = white - black;
  const levels = new Uint8Array(luma.length);
  for (let index = 0; index < luma.length; index += 1) {
    // A flat picture has no range to stretch: its one tone stands mid-grey.
    const light =
      span > 1e-6
        ? Math.min(1, Math.max(0, (luma[index] - black) / span))
        : 0.5;
    const ink = Math.pow(1 - light, COVER_KNOBS.GAMMA);
    levels[index] = Math.min(
      COVER_KNOBS.LEVELS,
      Math.round(ink * COVER_KNOBS.LEVELS),
    );
  }
  return { cells, levels };
}
