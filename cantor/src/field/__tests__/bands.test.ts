import {
  REPRESENTATION_WINDOWS,
  isNativeDrawnDistance,
  representationAlphas,
} from '..';

const fit = 0.42;

describe('the natively drawn distance', () => {
  /**
   * The whole reason this predicate exists. Two renderers draw the field —
   * `NativeFieldContent`, which knows a face at mark size and a row, and the
   * recorded picture, which knows all four representations — and swapping
   * between them may only happen where they would draw the same thing.
   */
  it('covers every distance that is only marks and rows', () => {
    for (const ratio of [0.4, 1.0, 1.19, 2, 3.6, 8, 11.9]) {
      expect(isNativeDrawnDistance(fit * ratio, fit)).toBe(true);
      const alphas = representationAlphas(fit * ratio, fit);
      expect(alphas.song).toBe(0);
      expect(alphas.grain).toBe(0);
    }
  });

  it('stops where the player opens, not where the row band does', () => {
    expect(
      isNativeDrawnDistance(fit * REPRESENTATION_WINDOWS.song[0], fit),
    ).toBe(false);
    // The boundary it used to stop at. Rows run from here to 3.6·FIT, and a
    // picture can only carry them by scaling a recording — which is what a
    // zoom made visible, so the native renderer has to own this whole span.
    const atRowEntry = representationAlphas(
      fit * REPRESENTATION_WINDOWS.row[0],
      fit,
    );
    expect(atRowEntry.song).toBe(0);
    expect(isNativeDrawnDistance(fit * REPRESENTATION_WINDOWS.row[0], fit)).toBe(
      true,
    );
  });

  it('answers false rather than throwing before a scale exists', () => {
    expect(isNativeDrawnDistance(1, 0)).toBe(false);
    expect(isNativeDrawnDistance(0, 1)).toBe(false);
    expect(isNativeDrawnDistance(Number.NaN, 1)).toBe(false);
  });
});
