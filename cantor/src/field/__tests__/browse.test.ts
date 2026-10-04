import {
  BROWSE_KNOBS,
  OVERVIEW_KNOBS,
  byTime,
  bloomedTargetPoint,
  hubRadiusWorld,
  layoutField,
  mapNameAlpha,
  overviewShrink,
  overviewWordAlpha,
} from '..';
import {
  browseCluster,
  browseOffsets,
  inBrowseFrame,
  mapCameraAround,
  mapCameraRange,
  mapFrame,
  overviewMinRatio,
} from '../browse';
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
  expect(width).toBeLessThanOrEqual(
    2 * BROWSE_KNOBS.CLUSTER_MAX_RADIUS_X_WORLD,
  );
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

it('hands a cluster its seats top to bottom, so a gather keeps the height order', () => {
  for (const hub of [false, true]) {
    const { points } = browseCluster(40, '2026-W38', hub);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index].y).toBeGreaterThanOrEqual(points[index - 1].y);
    }
  }
  const layout = makeLayout([40, 7]);
  for (const group of layout.groups) {
    const members = layout.placements.filter(p => p.groupKey === group.key);
    for (let index = 1; index < members.length; index += 1) {
      // Row `i` of the column is the `i`-th mark from the top of the bloom.
      expect(members[index].targetY).toBeGreaterThan(
        members[index - 1].targetY,
      );
      expect(bloomedTargetPoint(members[index]).y).toBeGreaterThanOrEqual(
        bloomedTargetPoint(members[index - 1]).y,
      );
    }
  }
});

it('rests the map camera where the layout says a tall field runs, and at home across', () => {
  const layout = makeLayout(Array(24).fill(24));
  const range = mapCameraRange(mapFrame(layout)!, viewport, layout.fitScale);
  expect(range.minY).toBeCloseTo(layout.fieldCenter.y, 6);
  expect(range.maxY).toBeCloseTo(layout.browseBounds!.maxY, 6);
  // Two columns fit across at FIT: there is nowhere to go sideways.
  expect(range.minX).toBe(layout.fieldCenter.x);
  expect(range.maxX).toBe(layout.fieldCenter.x);
  // Closer in, the same content outruns the screen both ways.
  const closer = mapCameraRange(
    mapFrame(layout)!,
    viewport,
    layout.fitScale * 1.9,
  );
  expect(closer.maxX).toBeGreaterThan(closer.minX);
  expect(closer.maxY - closer.minY).toBeGreaterThan(range.maxY - range.minY);
});

it('rests a short field at home', () => {
  const layout = makeLayout([3, 2]);
  const range = mapCameraRange(mapFrame(layout)!, viewport, layout.fitScale);
  expect(range).toEqual({
    minX: layout.fieldCenter.x,
    maxX: layout.fieldCenter.x,
    minY: layout.fieldCenter.y,
    maxY: layout.fieldCenter.y,
  });
});

it('climbs out to a camera with the cluster on screen, inside the map', () => {
  const layout = makeLayout(Array(24).fill(24));
  const range = mapCameraRange(mapFrame(layout)!, viewport, layout.fitScale);
  for (const group of layout.groups) {
    const around = mapCameraAround(layout, group.key, viewport)!;
    expect(around.scale).toBe(layout.fitScale);
    expect(around.y).toBeGreaterThanOrEqual(range.minY - 1e-9);
    expect(around.y).toBeLessThanOrEqual(range.maxY + 1e-9);
    // Its name, which hangs above its highest mark, is under the header.
    const name = (group.top - around.y) * layout.fitScale + viewport.height / 2;
    expect(name).toBeGreaterThanOrEqual(
      BROWSE_KNOBS.TOP_PX + BROWSE_KNOBS.LABEL_SPACE_PX - 1e-6,
    );
    expect(name).toBeLessThan(viewport.height - BROWSE_KNOBS.FOOT_PX);
  }
});

describe('an album cluster', () => {
  it('puts the cover on top and its songs in centred rows under it', () => {
    const { points, hub } = browseCluster(6, 'album:kind of blue', true);
    const half = hubRadiusWorld();
    expect(hub).toEqual({ x: 0, y: half });
    const perRow =
      Math.floor(
        BROWSE_KNOBS.HUB_SIDE_WORLD / BROWSE_KNOBS.HUB_SONG_PITCH_WORLD,
      ) + 1;
    const rows = new Map<number, number[]>();
    for (const point of points) {
      // Every song clears the cover by at least a mark's reach.
      expect(point.y - (hub.y + half)).toBeGreaterThanOrEqual(
        BROWSE_KNOBS.MARK_REACH_WORLD,
      );
      rows.set(point.y, [...(rows.get(point.y) ?? []), point.x]);
    }
    const counts = [...rows.values()].map(xs => xs.length);
    expect(counts).toEqual([perRow, 6 - perRow]);
    for (const xs of rows.values()) {
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 9);
    }
    const lone = browseCluster(1, 'album:single', true).points;
    expect(lone).toEqual([
      {
        x: 0,
        y: BROWSE_KNOBS.HUB_SIDE_WORLD + BROWSE_KNOBS.HUB_SONG_GAP_WORLD,
      },
    ]);
  });
});

describe('the overview', () => {
  it('zooms out until the whole map fits, never past its floor, and not at all for a short map', () => {
    const short = makeLayout([3, 2]);
    expect(overviewMinRatio(mapFrame(short)!, viewport)).toBe(1);
    const long = makeLayout(Array(24).fill(24));
    expect(overviewMinRatio(mapFrame(long)!, viewport)).toBe(
      OVERVIEW_KNOBS.MIN_RATIO,
    );
    const middling = makeLayout(Array(12).fill(12));
    const ratio = overviewMinRatio(mapFrame(middling)!, viewport);
    expect(ratio).toBeGreaterThan(OVERVIEW_KNOBS.MIN_RATIO);
    expect(ratio).toBeLessThan(1);
    // At that ratio the whole map stands in the band, exactly.
    const range = mapCameraRange(
      mapFrame(middling)!,
      viewport,
      middling.fitScale * ratio,
    );
    expect(range.maxY - range.minY).toBeCloseTo(0, 6);
  });

  it('centres a map that fits once zoomed out, rather than hanging it from home', () => {
    const layout = makeLayout(Array(12).fill(12));
    const frame = mapFrame(layout)!;
    const scale = layout.fitScale * OVERVIEW_KNOBS.MIN_RATIO;
    const range = mapCameraRange(frame, viewport, scale);
    expect(range.minY).toBe(range.maxY);
    const screen = (worldY: number) =>
      (worldY - range.minY) * scale + viewport.height / 2;
    const above =
      screen(frame.top) - BROWSE_KNOBS.LABEL_SPACE_PX - BROWSE_KNOBS.TOP_PX;
    const below =
      viewport.height -
      BROWSE_KNOBS.FOOT_PX -
      (screen(frame.bottom) + BROWSE_KNOBS.MARK_CLEARANCE_PX);
    expect(above).toBeGreaterThan(0);
    expect(below).toBeCloseTo(above, 0);
  });
});

it('shrinks marks with the world only below the map, and hands names over to the margin', () => {
  expect(overviewShrink(0.3, 1)).toBeCloseTo(0.3, 9);
  expect(overviewShrink(1, 1)).toBe(1);
  expect(overviewShrink(4, 1)).toBe(1);
  expect(mapNameAlpha(1, 1)).toBe(1);
  expect(mapNameAlpha(0.5, 1)).toBe(0);
  expect(overviewWordAlpha(1, 1)).toBe(0);
  expect(overviewWordAlpha(0.4, 1)).toBe(1);
});
