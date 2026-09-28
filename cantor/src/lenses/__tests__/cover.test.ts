import { Skia } from '@shopify/react-native-skia';
import { COVER_KNOBS, coverArtOf } from '../cover';
import { coverLens, coverPath } from '../coverLens';
import { faceSeed } from '../face';

describe('coverArtOf', () => {
  it('inks the dark cells and leaves the light ones as paper', () => {
    const art = coverArtOf([0, 1, 1, 0], 2);
    expect(Array.from(art.levels)).toEqual([
      COVER_KNOBS.LEVELS,
      0,
      0,
      COVER_KNOBS.LEVELS,
    ]);
  });

  it('stretches a dim picture across every level', () => {
    const cells = 10;
    const dim = Array.from(
      { length: cells * cells },
      (_, index) => 0.3 + (0.1 * index) / (cells * cells - 1),
    );
    const levels = new Set(coverArtOf(dim, cells).levels);
    expect(levels.has(0)).toBe(true);
    expect(levels.has(COVER_KNOBS.LEVELS)).toBe(true);
    expect(levels.size).toBe(COVER_KNOBS.LEVELS + 1);
  });

  it('draws a flat picture as one mid tone, and refuses a torn grid', () => {
    const flat = coverArtOf(new Array(16).fill(0.7), 4);
    expect(new Set(flat.levels).size).toBe(1);
    expect(() => coverArtOf([0, 1, 1], 2)).toThrow(RangeError);
  });
});

describe('the cover lens', () => {
  /** How much ink one cell drawn at a level holds, rasterised large. */
  function inkOf(level: number): number {
    const art = { cells: 1, levels: Uint8Array.of(level) };
    const surface = Skia.Surface.Make(100, 100)!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('white'));
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('black'));
    paint.setAntiAlias(true);
    paint.setStyle(1);
    paint.setStrokeWidth(2);
    canvas.translate(50, 50);
    canvas.drawPath(coverPath(art, 100), paint);
    surface.flush();
    const pixels = surface.makeImageSnapshot().readPixels() as Uint8Array;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      ink += 255 - Number(pixels[index]);
    }
    surface.dispose();
    return ink;
  }

  it('orders its glyphs by how much ink they hold', () => {
    const inks = Array.from({ length: COVER_KNOBS.LEVELS + 1 }, (_, level) =>
      inkOf(level),
    );
    expect(inks[0]).toBe(0);
    for (let level = 1; level < inks.length; level += 1) {
      expect(inks[level]).toBeGreaterThan(inks[level - 1]);
    }
  });

  it('has a player only for a song with a cover, and marks like the circle', () => {
    const recipe = {
      seed: faceSeed({ seed: 7, id: 'd1', model: 'device', durationMs: 1 }),
      id: 'd1',
      model: 'device',
      durationMs: 30_000,
      imported: true,
    };
    expect(coverLens.player(recipe, undefined, null)).toBeNull();
    const art = coverArtOf([0, 1, 1, 0], 2);
    expect(coverLens.player(recipe, undefined, art)?.sound).not.toBeNull();
    // The same cover builds its path once.
    expect(coverLens.player(recipe, undefined, art)?.sound).toBe(
      coverLens.player(recipe, undefined, art)?.sound,
    );
  });
});
