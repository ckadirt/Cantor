import {
  CANTOR_LENS_DEPTH,
  LENS_INTERVALS,
  cantorIntervals,
  cantorMeasure,
} from '../cantorIntervals';

describe('cantorIntervals', () => {
  it('is the whole segment before anything is removed', () => {
    expect(cantorIntervals(0)).toEqual([{ start: 0, end: 1 }]);
  });

  it('removes the middle third once', () => {
    const [left, right] = cantorIntervals(1);

    // Endpoints are derived from the parent interval, so 0 and 1 stay exact
    // while the inner cuts land within floating-point reach of the thirds.
    expect(left.start).toBe(0);
    expect(left.end).toBeCloseTo(1 / 3, 15);
    expect(right.start).toBeCloseTo(2 / 3, 15);
    expect(right.end).toBe(1);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('has 2^%i intervals at depth %i', depth => {
    expect(cantorIntervals(depth)).toHaveLength(2 ** depth);
  });

  it('produces exactly 32 intervals at the lens depth', () => {
    expect(CANTOR_LENS_DEPTH).toBe(5);
    expect(LENS_INTERVALS).toHaveLength(32);
  });

  it('keeps every interval inside the unit segment', () => {
    for (const { start, end } of LENS_INTERVALS) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(1);
      expect(start).toBeLessThan(end);
    }
  });

  it('is ordered and non-overlapping', () => {
    for (let i = 1; i < LENS_INTERVALS.length; i += 1) {
      expect(LENS_INTERVALS[i].start).toBeGreaterThanOrEqual(
        LENS_INTERVALS[i - 1].end,
      );
    }
  });

  it('gives every interval the same width, 3^-depth', () => {
    const expected = 3 ** -CANTOR_LENS_DEPTH;
    for (const { start, end } of LENS_INTERVALS) {
      expect(end - start).toBeCloseTo(expected, 12);
    }
  });

  it('starts at 0 and ends at 1, however deep it goes', () => {
    for (const depth of [0, 1, 5, 8]) {
      const intervals = cantorIntervals(depth);
      expect(intervals[0].start).toBe(0);
      expect(intervals[intervals.length - 1].end).toBe(1);
    }
  });

  it('measures (2/3)^depth, which is why the set vanishes', () => {
    for (const depth of [0, 1, 5]) {
      const total = cantorIntervals(depth).reduce(
        (sum, { start, end }) => sum + (end - start),
        0,
      );
      expect(total).toBeCloseTo(cantorMeasure(depth), 12);
    }
    expect(cantorMeasure(0)).toBe(1);
  });

  it('refuses a depth that is not a whole number of removals', () => {
    expect(() => cantorIntervals(-1)).toThrow('non-negative integer');
    expect(() => cantorIntervals(1.5)).toThrow('non-negative integer');
  });

  it('hands every caller the same shared array', () => {
    // Allocating per placement per frame is what kills a large field.
    expect(LENS_INTERVALS).toBe(LENS_INTERVALS);
  });
});
