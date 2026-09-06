import {
  LEVEL_BOUNDARIES,
  LEVEL_SCALE_RATIOS,
  REPRESENTATION_WINDOWS,
  SONG_ARRIVAL,
  faceArrival,
  isNativeDrawnDistance,
  nameArrival,
  representationAlphas,
  songNameArrival,
  songShapeArrival,
} from '..';
import { writePhase } from '../../motion/text';

const fit = 0.42;

describe('the natively drawn distance', () => {
  /**
   * The whole reason this predicate exists. Two renderers draw the field —
   * `NativeFieldContent`, which knows a face at mark size, a row and the
   * player, and the recorded picture, which knows all four representations —
   * and swapping between them may only happen where they would draw the same
   * thing.
   */
  it('covers every distance that is marks, rows and the player', () => {
    for (const ratio of [0.4, 1.0, 1.19, 2, 3.6, 8, 11.9, 27, 90, 177]) {
      expect(isNativeDrawnDistance(fit * ratio, fit)).toBe(true);
      expect(representationAlphas(fit * ratio, fit).grain).toBe(0);
    }
  });

  it('stops where the grain opens, not where the player does', () => {
    // Asked at a fit of exactly 1, because the boundary itself is the claim:
    // `fit * ratio / fit` is not `ratio` in binary floating point, so at any
    // other fit this reads a scale a hair either side of the edge and answers
    // truthfully about a question nobody asked.
    expect(isNativeDrawnDistance(REPRESENTATION_WINDOWS.grain[0], 1)).toBe(
      false,
    );
    // The boundary it used to stop at. The player runs from here to 178·FIT,
    // and a picture can only carry it by scaling a recording — which is what a
    // zoom made visible, so the native renderer has to own this whole span too.
    expect(isNativeDrawnDistance(REPRESENTATION_WINDOWS.song[0], 1)).toBe(true);
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

describe('a row becoming the player', () => {
  const at = (ratio: number) => fit * ratio;

  it('is the row until the camera leaves the shelf seat', () => {
    expect(songShapeArrival(at(LEVEL_SCALE_RATIOS.shelf), fit)).toBe(0);
    expect(songNameArrival(at(LEVEL_SCALE_RATIOS.shelf), fit)).toBe(0);
  });

  it('is the player by the time the camera lands on the song', () => {
    expect(songShapeArrival(at(LEVEL_SCALE_RATIOS.song), fit)).toBe(1);
    expect(songNameArrival(at(LEVEL_SCALE_RATIOS.song), fit)).toBe(1);
  });

  /**
   * The shape leads and the name follows, and they overlap by one unit of FIT.
   *
   * Run on one number they all moved at once, which is the lurch. Run strictly
   * end-to-end the hand-over reads as a stutter. The name starts where the
   * player first becomes visible at all, just before the shape settles.
   */
  it('seats the picture before it moves the name', () => {
    expect(songShapeArrival(at(LEVEL_BOUNDARIES.shelf), fit)).toBe(1);
    // The name has begun by then, but only just.
    const begun = songNameArrival(at(LEVEL_BOUNDARIES.shelf), fit);
    expect(begun).toBeGreaterThan(0);
    expect(begun).toBeLessThan(0.15);
    // And it had not begun one unit earlier, where the shape still owns the frame.
    expect(songNameArrival(at(REPRESENTATION_WINDOWS.song[0]), fit)).toBe(0);
  });

  /**
   * The whole of the curve fix, as one property.
   *
   * `interpolateCamera` eases once and then walks the scale exponentially, so a
   * pose that advances *linearly in log scale* advances in lockstep with the
   * camera carrying it, and the two motions sum to a straight line. Easing here
   * as well — a smootherstep on a smootherstep — is what made the name stand
   * still through half the descent and then hook across the screen. Halfway in
   * log space must therefore be halfway through the pose, exactly.
   */
  it('advances evenly in log scale rather than easing a second time', () => {
    for (const [opens, lands, arrival] of [
      [...SONG_ARRIVAL.SHAPE_GROW, songShapeArrival],
      [...SONG_ARRIVAL.NAME_TRAVEL, songNameArrival],
    ] as const) {
      // The geometric mean is what halfway means in log scale.
      expect(arrival(at(Math.sqrt(opens * lands)), fit)).toBeCloseTo(0.5, 6);
      const quarter = Math.exp(
        Math.log(opens) + (Math.log(lands) - Math.log(opens)) / 4,
      );
      expect(arrival(at(quarter), fit)).toBeCloseTo(0.25, 6);
    }
  });

  it('answers nothing rather than throwing before a scale exists', () => {
    expect(songShapeArrival(1, 0)).toBe(0);
    expect(songNameArrival(0, 1)).toBe(0);
    expect(songShapeArrival(Number.NaN, 1)).toBe(0);
  });
});
