import {
  LEVEL_BOUNDARIES,
  LEVEL_SCALE_RATIOS,
  REPRESENTATION_WINDOWS,
  faceArrival,
  isNativeDrawnDistance,
  nameArrival,
  representationAlphas,
} from '..';
import { writePhase } from '../../motion/text';

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

/**
 * A mark becoming a row: the face steps aside, then the name is written.
 *
 * Both halves are the camera's own distance rather than a timer, so the pen is
 * the pinch — and the whole gesture is a function of where the camera is, which
 * is what makes it reversible.
 */
describe('a mark becoming a row', () => {
  const walked = (ratio: number) => faceArrival(fit * ratio, fit);
  const written = (ratio: number) => writePhase(nameArrival(fit * ratio, fit));

  it('seats the face before it writes a letter', () => {
    // Everywhere the face is still walking, nothing of the name is drawn.
    for (const ratio of [1.2, 1.4, 1.7, 1.99]) {
      expect(walked(ratio)).toBeLessThan(1);
      expect(written(ratio).borderEnd).toBe(0);
    }
    // And it is seated exactly where the field stops being a map.
    expect(walked(LEVEL_BOUNDARIES.field)).toBe(1);
  });

  it('has neither started while the field is only a map of dots', () => {
    expect(walked(REPRESENTATION_WINDOWS.row[0])).toBe(0);
    expect(written(REPRESENTATION_WINDOWS.row[0]).fillAlpha).toBe(0);
  });

  it('is tracing its outline for the first half of the descent', () => {
    const middle = written(3);
    expect(middle.borderEnd).toBeGreaterThan(0);
    expect(middle.borderEnd).toBeLessThan(1);
    expect(middle.fillAlpha).toBe(0);
  });

  it('is settled ink by the time the shelf is where you stand', () => {
    const seated = written(LEVEL_SCALE_RATIOS.shelf);
    expect(seated.settled).toBe(true);
    expect(seated.fillAlpha).toBe(1);
    expect(seated.borderAlpha).toBe(0);
  });

  /**
   * The same gesture backwards. Both halves are monotone in the distance, so
   * zooming out unwrites the name and walks the face home rather than fading:
   * every distance has one state, whichever direction it was reached from.
   */
  it('unwrites and steps back on the way out', () => {
    expect(written(3.5).borderEnd).toBeGreaterThan(written(2.5).borderEnd);
    expect(written(4.5).fillAlpha).toBeGreaterThan(written(3.8).fillAlpha);
    expect(walked(1.4)).toBeLessThan(walked(1.8));
    expect(written(LEVEL_BOUNDARIES.field).borderEnd).toBe(0);
  });

  it('answers nothing rather than throwing before a scale exists', () => {
    expect(faceArrival(0, 0)).toBe(0);
    expect(nameArrival(Number.NaN, 1)).toBe(0);
  });
});
