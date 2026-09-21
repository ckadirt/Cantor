import { byTime, bloomedTargetPoint, layoutField } from '..';
import { browseOffsets, inBrowseFrame } from '../browse';
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

it('gives sparse groups more air and compresses dense particles without coincident seats', () => {
  const nearest = (count: number) => {
    const points = browseOffsets(count, '2026-W38');
    return points.map((point, index) =>
      Math.min(
        ...points
          .filter((_, other) => other !== index)
          .map(other => Math.hypot(point.x - other.x, point.y - other.y)),
      ),
    );
  };
  const sparse = nearest(4);
  const dense = nearest(44);
  expect(Math.min(...sparse)).toBeGreaterThan(Math.max(...dense));
  expect(Math.min(...dense)).toBeGreaterThan(15);
  expect(Math.min(...dense)).toBeLessThan(30);
});
it('keeps particle layouts stable, varied by group, and free of grid rows', () => {
  const points = browseOffsets(24, '2026-W38');
  expect(browseOffsets(24, '2026-W38')).toEqual(points);
  expect(browseOffsets(24, '2026-W37')).not.toEqual(points);
  expect(
    new Set(points.map(point => Math.round(point.y))).size,
  ).toBeGreaterThan(15);
  expect(browseOffsets(0, 'empty')).toEqual([]);
  expect(browseOffsets(1, 'solo')).toEqual([{ x: 0, y: 0 }]);
});
