import {
  byTime,
  flightCameraAt,
  gatherFraction,
  layoutField,
  LEVEL_SCALE_RATIOS,
  placementPoint,
  shelfSeats,
  seatCameraAround,
} from '..';
import { groupScenario } from '../fixtures/groupScenarios';

const viewport = { width: 384, height: 780 };
const layout = layoutField({
  entities: groupScenario(Array(12).fill(30)),
  arrangement: byTime,
  viewport,
});
// A song far down the map, under clusters that grow into tall columns.
const held = layout.placements[layout.placements.length - 1];
const fit = layout.fitScale;
const point = (scale: number) =>
  placementPoint(held, gatherFraction(scale, fit));
const from = { ...point(fit), scale: fit };
const seat = shelfSeats(layout).find(each => each.key === held.groupKey)!;
const to = seatCameraAround(
  seat,
  held.targetY,
  viewport,
  fit * LEVEL_SCALE_RATIOS.shelf,
);
const offsetAt = (eased: number, anchored: boolean) => {
  const camera = flightCameraAt(
    from,
    to,
    eased,
    anchored ? { bloomX: held.targetBloomX, bloomY: held.targetBloomY } : null,
    fit,
  );
  const song = point(camera.scale);
  return { x: song.x - camera.x, y: song.y - camera.y, camera };
};

it('lands where a plain flight lands, at both ends', () => {
  for (const eased of [0, 1]) {
    const anchored = offsetAt(eased, true).camera;
    const plain = offsetAt(eased, false).camera;
    expect(anchored.x).toBeCloseTo(plain.x, 9);
    expect(anchored.y).toBeCloseTo(plain.y, 9);
    expect(anchored.scale).toBeCloseTo(plain.scale, 12);
  }
});

it('carries the held song on the straight line between its two ends', () => {
  const start = offsetAt(0, true);
  const end = offsetAt(1, true);
  let plainWorst = 0;
  for (const eased of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
    const anchored = offsetAt(eased, true);
    expect(anchored.x).toBeCloseTo(start.x + (end.x - start.x) * eased, 6);
    expect(anchored.y).toBeCloseTo(start.y + (end.y - start.y) * eased, 6);
    const plain = offsetAt(eased, false);
    const straight = start.y + (end.y - start.y) * eased;
    plainWorst = Math.max(
      plainWorst,
      Math.abs(plain.y - straight) * plain.camera.scale,
    );
  }
  // Without the anchor the same flight swings the song a long way off that
  // line on the screen — the bug this exists for.
  expect(plainWorst).toBeGreaterThan(200);
});
