import { cantorSegments } from '../cantorBars';

describe('the Cantor set as a row', () => {
  it('drops the middle third once per level of depth', () => {
    expect(cantorSegments(0)).toEqual([[0, 1]]);
    expect(cantorSegments(1)).toEqual([
      [0, 1 / 3],
      [2 / 3, 1 / 3],
    ]);
    // Three cuts leaves eight bars, which is what the origin mark draws.
    expect(cantorSegments(3)).toHaveLength(8);
  });

  it('stays inside the unit box and never lets two bars touch', () => {
    for (const depth of [0, 1, 2, 3, 4]) {
      const segments = cantorSegments(depth);
      expect(segments).toHaveLength(2 ** depth);
      let previousEnd = -1;
      for (const [x, width] of segments) {
        expect(x).toBeGreaterThan(previousEnd - 1e-9);
        expect(x + width).toBeLessThanOrEqual(1 + 1e-9);
        expect(width).toBeCloseTo(1 / 3 ** depth, 10);
        previousEnd = x + width;
      }
      // The set is closed at both ends, at every depth.
      expect(segments[0][0]).toBe(0);
      expect(segments[segments.length - 1][0] + segments[segments.length - 1][1]).toBeCloseTo(1, 10);
    }
  });

  it('treats a nonsense depth as no cuts at all', () => {
    expect(cantorSegments(-2)).toEqual([[0, 1]]);
    expect(cantorSegments(1.7)).toEqual(cantorSegments(1));
  });
});
