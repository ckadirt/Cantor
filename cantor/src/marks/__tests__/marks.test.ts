import { modelDots, station } from '../station';
import { PHONE_SEAL_KNOBS, phoneSeal } from '../seal';

const round = (points: readonly (readonly [number, number])[]) =>
  points.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]);

describe('station, a node drawn from its key', () => {
  it('is the same drawing for the same key, and pinned by goldens', () => {
    const a = station('Zm9vYmFyYmF6cXV4cXV1eA==', 1);
    expect(station('Zm9vYmFyYmF6cXV4cXV1eA==', 1)).toEqual(a);
    expect({
      sides: a.sides,
      gate: a.gate,
      outline: round(a.outline),
      dots: round(a.dots),
    }).toMatchSnapshot();
    const b = station('another-node-key', 4);
    expect({
      sides: b.sides,
      gate: b.gate,
      outline: round(b.outline),
      dots: round(b.dots),
    }).toMatchSnapshot();
  });

  it('has three to seven sides and one edge open', () => {
    for (const key of [
      'a',
      'b',
      'c',
      'agentbox',
      'h100',
      'rtx6000',
      'x'.repeat(44),
    ]) {
      const mark = station(key, 0);
      expect(mark.sides).toBeGreaterThanOrEqual(3);
      expect(mark.sides).toBeLessThanOrEqual(7);
      // Every corner once, plus a stub at each side of the gate.
      expect(mark.outline).toHaveLength(mark.sides + 2);
      const [first, last] = [
        mark.outline[0],
        mark.outline[mark.outline.length - 1],
      ];
      // The two stubs do not meet: the gate is open.
      expect(
        Math.hypot(first[0] - last[0], first[1] - last[1]),
      ).toBeGreaterThan(0.1);
    }
  });

  it('draws a dot per model, and stops counting at six', () => {
    expect(modelDots(0)).toEqual([]);
    expect(modelDots(1)).toEqual([[0, 0]]);
    expect(modelDots(3)).toHaveLength(3);
    expect(modelDots(40)).toHaveLength(6);
  });
});

describe("the phone's seal", () => {
  it('is five to eight spokes from its key, pinned by a golden', () => {
    const seal = phoneSeal('9F2C41AB');
    expect(phoneSeal('9F2C41AB')).toEqual(seal);
    expect(seal.spokes.length).toBeGreaterThanOrEqual(5);
    expect(seal.spokes.length).toBeLessThanOrEqual(8);
    expect(
      seal.spokes.map(([from, to]) => round([from, to])),
    ).toMatchSnapshot();
  });

  it('with the spindle: the same spokes, held clear of the ring', () => {
    const dot = phoneSeal('9F2C41AB');
    const spindle = phoneSeal('9F2C41AB', true);
    expect(spindle.spokes).toHaveLength(dot.spokes.length);
    spindle.spokes.forEach(([from, to], index) => {
      // Same outer ends: one seal, two centres.
      expect(to).toEqual(dot.spokes[index][1]);
      expect(Math.hypot(from[0], from[1])).toBeCloseTo(
        PHONE_SEAL_KNOBS.SPINDLE_SPOKE_FROM,
      );
    });
    expect(PHONE_SEAL_KNOBS.SPINDLE_SPOKE_FROM).toBeGreaterThan(
      PHONE_SEAL_KNOBS.SPINDLE_RING,
    );
    expect(
      spindle.spokes.map(([from, to]) => round([from, to])),
    ).toMatchSnapshot();
  });
});
