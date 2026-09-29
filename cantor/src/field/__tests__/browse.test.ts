import { BROWSE_KNOBS, byTime, bloomedTargetPoint, layoutField } from '..';
import { browseCluster, browseOffsets, inBrowseFrame } from '../browse';
import { groupScenario } from '../fixtures/groupScenarios';

const viewport = { width: 393, height: 793 };
const makeLayout = (counts: number[]) =>
  layoutField({
    entities: groupScenario(counts),
    arrangement: byTime,
    viewport,
  });
it('shows at least six ordinary groups initially and keeps the oldest group reachable', () => {
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
  // Rows are as tall as their clusters, so three rows of 24 leave room for
  // part of a fourth.
  expect(visible.size).toBeGreaterThanOrEqual(6);
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

it('sizes a cluster by its count, at one spacing, without coincident seats', () => {
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
  const extent = (count: number) => {
    const points = browseOffsets(count, '2026-W38');
    return Math.max(...points.map(point => point.y));
  };
  // A pair is a small pair, not two marks spread over a seat cut for forty.
  expect(extent(4)).toBeLessThan(extent(44) / 2);
  for (const count of [4, 12, 44]) {
    expect(Math.min(...nearest(count))).toBeGreaterThan(15);
    expect(Math.min(...nearest(count))).toBeLessThan(30);
  }
  // Past the column's width a cluster grows down, not across.
  const wide = browseOffsets(150, '2026-W38');
  const width =
    Math.max(...wide.map(point => point.x)) -
    Math.min(...wide.map(point => point.x));
  expect(width).toBeLessThanOrEqual(2 * BROWSE_KNOBS.CLUSTER_MAX_RADIUS_X_WORLD);
});

it('keeps the middle of a hub cluster clear, with the hub inside its seat', () => {
  const { points, hub } = browseCluster(6, 'album:kind of blue', true);
  expect(hub.y).toBeGreaterThan(0);
  for (const point of points) {
    expect(Math.hypot(point.x - hub.x, point.y - hub.y)).toBeGreaterThan(20);
    expect(point.y).toBeGreaterThanOrEqual(0);
  }
  const lone = browseCluster(1, 'album:single', true);
  expect(lone.points).toHaveLength(1);
  expect(lone.hub).not.toEqual(lone.points[0]);
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
