import type { Placement } from '../../../field';
import { OPENING_KNOBS, openedAt, planOpening } from '../opening';

function placement(entityKey: string, x: number, y: number): Placement {
  return {
    key: `p-${entityKey}`,
    entityKey,
    groupKey: 'g',
    x,
    y,
    fromX: x,
    fromY: y,
    targetX: x,
    targetY: y,
  } as unknown as Placement;
}

describe('planOpening', () => {
  const albums: Record<string, string> = {
    a1: 'shade',
    a2: 'shade',
    b1: 'pink moon',
    c1: 'ruins',
  };
  const placements = [
    placement('b1', 0, 10),
    placement('a1', 5, 0),
    placement('a2', 6, 0),
    placement('c1', -3, 10),
    placement('old', -9, -9),
  ];

  it('opens album by album, in reading order, an album together', () => {
    const plan = planOpening(
      ['a1', 'a2', 'b1', 'c1'],
      placements,
      id => albums[id] ?? null,
    )!;
    const step = OPENING_KNOBS.ALBUM_MS;
    expect(plan.at.get('a1')).toBe(0);
    expect(plan.at.get('a2')).toBe(0);
    // Same row: left first.
    expect(plan.at.get('c1')).toBe(step);
    expect(plan.at.get('b1')).toBe(2 * step);
    expect(plan.at.has('old')).toBe(false);
    expect(plan.endMs).toBe(2 * step + OPENING_KNOBS.OPEN_MS);
  });

  it('keeps a first bring-in of many albums to a few seconds', () => {
    const ids = Array.from({ length: 169 }, (_, i) => `s${i}`);
    const plan = planOpening(
      ids,
      ids.map((id, i) => placement(id, 0, i)),
      id => id,
    )!;
    expect(plan.endMs).toBeLessThanOrEqual(
      OPENING_KNOBS.TOTAL_MS + OPENING_KNOBS.OPEN_MS,
    );
  });

  it('opens unplaced songs last, and plans nothing for nothing', () => {
    const plan = planOpening(['x', 'a1'], placements, () => null)!;
    expect(plan.at.get('x')).toBeGreaterThan(plan.at.get('a1')!);
    expect(planOpening([], placements, () => null)).toBeNull();
  });
});

describe('openedAt', () => {
  it('opens each mark from its own start', () => {
    expect(openedAt(-1, 0)).toBe(1);
    expect(openedAt(500, 400)).toBe(0);
    expect(openedAt(500, 500 + OPENING_KNOBS.OPEN_MS / 2)).toBeCloseTo(0.5);
    expect(openedAt(500, 5000)).toBe(1);
  });
});
