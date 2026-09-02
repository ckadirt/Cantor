import {
  LEVEL_BOUNDARIES,
  REPRESENTATION_WINDOWS,
  isMarksOnlyDistance,
  representationAlphas,
} from '..';

const fit = 0.42;

describe('the marks-only distance', () => {
  /**
   * The whole reason this predicate exists. Two renderers draw the field —
   * `NativeFieldContent`, which knows only a face at mark size, and the
   * recorded picture, which knows all four representations — and swapping
   * between them may only happen where they would draw the same thing.
   */
  it('is exactly where nothing but the dot band is drawn', () => {
    for (const ratio of [0.4, 0.9, 1.0, 1.1, 1.19]) {
      expect(isMarksOnlyDistance(fit * ratio, fit)).toBe(true);
      const alphas = representationAlphas(fit * ratio, fit);
      expect(alphas.dot).toBe(1);
      expect(alphas.row).toBe(0);
      expect(alphas.song).toBe(0);
      expect(alphas.grain).toBe(0);
    }
  });

  it('stops at the row band, not at the field/shelf boundary', () => {
    expect(isMarksOnlyDistance(fit * REPRESENTATION_WINDOWS.row[0], fit)).toBe(
      false,
    );
    // The boundary it used to be tested at. A row is a quarter drawn here, so
    // handing over to a renderer that draws no rows would pop that quarter out.
    const atLevelBoundary = representationAlphas(
      fit * LEVEL_BOUNDARIES.field,
      fit,
    );
    expect(atLevelBoundary.row).toBeGreaterThan(0.2);
    expect(isMarksOnlyDistance(fit * LEVEL_BOUNDARIES.field, fit)).toBe(false);
  });

  it('answers false rather than throwing before a scale exists', () => {
    expect(isMarksOnlyDistance(1, 0)).toBe(false);
    expect(isMarksOnlyDistance(0, 1)).toBe(false);
    expect(isMarksOnlyDistance(Number.NaN, 1)).toBe(false);
  });
});
