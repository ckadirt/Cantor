import { byTime, bloomedTargetPoint, layoutField } from '..';
import { containBrowseCamera, inBrowseFrame } from '../browse';
import { groupScenario } from '../fixtures/groupScenarios';

const viewport = { width: 393, height: 793 };
const makeLayout = (counts: number[]) =>
  layoutField({
    entities: groupScenario(counts),
    arrangement: byTime,
    viewport,
  });
it('shows six ordinary groups initially and keeps the oldest group reachable', () => {
  const layout = makeLayout(Array(24).fill(24));
  const visible = new Set(
    layout.placements
      .filter(p => {
        const y =
          bloomedTargetPoint(p).y * layout.fitScale + viewport.height / 2;
        return inBrowseFrame({ x: 0, y }, viewport);
      })
      .map(p => p.groupKey),
  );
  expect(visible.size).toBe(6);
  expect(layout.groups[0].key > layout.groups[23].key).toBe(true);
  for (const p of layout.placements.filter(
    placement => placement.groupKey === layout.groups[23].key,
  )) {
    const y =
      (bloomedTargetPoint(p).y - layout.browseBounds!.maxY) * layout.fitScale +
      viewport.height / 2;
    expect(inBrowseFrame({ x: 0, y }, viewport)).toBe(true);
  }
});
it('adding months or dense weeks never reduces the overview scale', () => {
  expect(makeLayout([24, 24]).fitScale).toBe(
    makeLayout(Array(24).fill(24)).fitScale,
  );
  expect(makeLayout([24, 24]).fitScale).toBe(
    makeLayout(Array(24).fill(44)).fitScale,
  );
  expect(makeLayout(Array(24).fill(44)).browseBounds!.maxY).toBeGreaterThan(
    makeLayout(Array(24).fill(24)).browseBounds!.maxY,
  );
});
it('bounds overview scrolling vertically and leaves zoomed navigation free', () => {
  const bounds = { minY: 0, maxY: 500 };
  expect(containBrowseCamera({ x: 30, y: -100, scale: 1 }, bounds, 1)).toEqual({
    x: 0,
    y: 0,
    scale: 1,
  });
  expect(containBrowseCamera({ x: 30, y: 900, scale: 1 }, bounds, 1)).toEqual({
    x: 0,
    y: 500,
    scale: 1,
  });
  expect(containBrowseCamera({ x: 30, y: 900, scale: 2 }, bounds, 1)).toEqual({
    x: 30,
    y: 900,
    scale: 2,
  });
});
