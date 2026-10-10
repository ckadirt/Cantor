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
   * Cells along each side. Forty-eight puts a glyph about 4 dp wide on this
   * phone's player: still a character, and enough of them that a face or a
   * title reads. At thirty-two both sank into the glyphs (tested on real
   * covers, 2026-10-10).
   */
  CELLS: 48,
  /**
   * The share of the picture's darkest and lightest cells taken as its black
   * and white before the levels are cut, so a dim or washed-out thumbnail
   * still spans every glyph rather than three of them.
   */
  STRETCH_CLIP: 0.02,
  /**
   * How far a cell is pushed away from its neighbourhood's brightness, so a
   * face against a dark ground keeps its edges instead of sinking into one
   * field of `#`.
   */
  CONTRAST: 0.8,
  /** The neighbourhood's reach, as a share of the cover's side. */
  CONTRAST_RADIUS: 1 / 16,
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
 * to the picture's own range, sharpened against each cell's neighbourhood,
 * stretched again, inverted into ink, and cut into levels with the error of
 * each cut carried to the cells after it (Floyd–Steinberg), so six glyphs
 * still hold a gradient.
 */
export function coverArtOf(luma: ArrayLike<number>, cells: number): CoverArt {
  if (luma.length !== cells * cells || cells <= 0) {
    throw new RangeError('A cover needs cells × cells brightness values.');
  }
  const stretched = stretch(luma);
  if (stretched === null) {
    // A flat picture has no range to stretch: its one tone stands mid-grey.
    const level = Math.round(
      Math.pow(0.5, COVER_KNOBS.GAMMA) * COVER_KNOBS.LEVELS,
    );
    return { cells, levels: new Uint8Array(luma.length).fill(level) };
  }
  const around = blur(stretched, cells, cells * COVER_KNOBS.CONTRAST_RADIUS);
  const sharpened = stretched.map((light, index) =>
    clamp01(light + COVER_KNOBS.CONTRAST * (light - around[index])),
  );
  const light = stretch(sharpened) ?? sharpened;
  const wanted = light.map(
    value => Math.pow(1 - value, COVER_KNOBS.GAMMA) * COVER_KNOBS.LEVELS,
  );
  const levels = new Uint8Array(luma.length);
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const index = row * cells + column;
      const level = Math.min(
        COVER_KNOBS.LEVELS,
        Math.max(0, Math.round(wanted[index])),
      );
      levels[index] = level;
      const error = wanted[index] - level;
      const right = column + 1 < cells;
      const below = row + 1 < cells;
      if (right) wanted[index + 1] += (error * 7) / 16;
      if (below && column > 0) wanted[index + cells - 1] += (error * 3) / 16;
      if (below) wanted[index + cells] += (error * 5) / 16;
      if (below && right) wanted[index + cells + 1] += error / 16;
    }
  }
  return { cells, levels };
}

/**
 * Brightness stretched so the picture's own darkest and lightest cells
 * (less `STRETCH_CLIP` of each) are black and white; null when it is flat.
 */
function stretch(luma: ArrayLike<number>): Float32Array | null {
  const sorted = Float32Array.from(luma).sort();
  const clip = Math.floor(sorted.length * COVER_KNOBS.STRETCH_CLIP);
  const black = sorted[clip];
  const span = sorted[sorted.length - 1 - clip] - black;
  if (span <= 1e-6) return null;
  return Float32Array.from(luma, value => clamp01((value - black) / span));
}

/** A Gaussian blur of a square grid, its edge cells repeated outward. */
function blur(grid: Float32Array, cells: number, sigma: number): Float32Array {
  const reach = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(reach * 2 + 1);
  let total = 0;
  for (let offset = -reach; offset <= reach; offset += 1) {
    const weight = Math.exp(-0.5 * (offset / sigma) ** 2);
    kernel[offset + reach] = weight;
    total += weight;
  }
  const pass = (source: Float32Array, across: boolean) => {
    const out = new Float32Array(source.length);
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        let sum = 0;
        for (let offset = -reach; offset <= reach; offset += 1) {
          const along = Math.min(
            cells - 1,
            Math.max(0, (across ? column : row) + offset),
          );
          const index = across ? row * cells + along : along * cells + column;
          sum += source[index] * kernel[offset + reach];
        }
        out[row * cells + column] = sum / total;
      }
    }
    return out;
  };
  return pass(pass(grid, true), false);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
