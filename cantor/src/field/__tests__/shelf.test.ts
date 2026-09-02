import {
  LAYOUT_KNOBS,
  SHELF_KNOBS,
  containToSeat,
  isShelfDistance,
  layoutField,
  nearestSeat,
  orderByKey,
  DEFAULT_ORDER_KEY,
  rubberBand,
  seatAfterRelease,
  seatCameraBounds,
  shelfSeats,
  type FieldEntity,
} from '..';
import { byTime } from '../arrangements';

const viewport = { width: 412, height: 892 };
const day = 24 * 60 * 60 * 1000;
const week = 7 * day;
const monday = Date.parse('2026-08-24T12:00:00Z');

function entity(id: string, createdAtMs: number): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs,
    durationMs: 120_000,
    tags: [],
  };
}

/** Three weeks of four songs: enough clusters to have neighbours in both axes. */
function threeWeeks() {
  const entities: FieldEntity[] = [];
  for (let cluster = 0; cluster < 3; cluster += 1) {
    for (let song = 0; song < 4; song += 1) {
      entities.push(
        entity(`w${cluster}s${song}`, monday + cluster * week + song * day),
      );
    }
  }
  return layoutField({
    entities,
    arrangement: byTime,
    viewport,
    order: orderByKey(DEFAULT_ORDER_KEY),
    orderSeed: 0,
  });
}

describe('seats', () => {
  it('gives every cluster the column its members are gathered into', () => {
    const layout = threeWeeks();
    const seats = shelfSeats(layout);
    expect(seats).toHaveLength(layout.groups.length);
    for (const seat of seats) {
      const group = layout.groups.find(candidate => candidate.key === seat.key);
      expect(group).toBeDefined();
      expect(seat.cx).toBe(group?.cx);
      const members = layout.placements.filter(
        placement => placement.groupKey === seat.key,
      );
      expect(seat.top).toBe(Math.min(...members.map(m => m.targetY)));
      expect(seat.bottom).toBe(Math.max(...members.map(m => m.targetY)));
      // Four songs, `SONG_GAP_WORLD` apart.
      expect(seat.bottom - seat.top).toBeCloseTo(
        3 * LAYOUT_KNOBS.SONG_GAP_WORLD,
      );
    }
  });

  it('answers with the column the camera is standing in', () => {
    const layout = threeWeeks();
    const seats = shelfSeats(layout);
    for (let index = 0; index < seats.length; index += 1) {
      const seat = seats[index];
      const camera = {
        x: seat.cx,
        y: (seat.top + seat.bottom) / 2,
        scale: layout.fitScale * 5,
      };
      expect(nearestSeat(seats, camera)).toBe(index);
    }
  });

  it('has no answer when there is nothing to stand in', () => {
    expect(nearestSeat([], { x: 0, y: 0, scale: 1 })).toBe(-1);
  });
});

describe('the shelf distance', () => {
  it('is the same window `levelOf` calls a shelf', () => {
    const fit = 0.5;
    expect(isShelfDistance(fit * 1.9, fit)).toBe(false);
    expect(isShelfDistance(fit * 2, fit)).toBe(true);
    expect(isShelfDistance(fit * 5, fit)).toBe(true);
    expect(isShelfDistance(fit * 12.9, fit)).toBe(true);
    expect(isShelfDistance(fit * 13, fit)).toBe(false);
  });

  // A worklet that throws inside a gesture handler takes the gesture with it,
  // so this one answers rather than asserting.
  it('answers false for a scale that has not settled yet', () => {
    expect(isShelfDistance(1, 0)).toBe(false);
    expect(isShelfDistance(0, 1)).toBe(false);
    expect(isShelfDistance(Number.NaN, 1)).toBe(false);
  });
});

describe('the rubber band', () => {
  it('starts free, never reaches the limit, and is odd about zero', () => {
    expect(rubberBand(0, 100)).toBe(0);
    // f'(0) = 1: the first pixel of a drag is not damped.
    expect(rubberBand(0.01, 100)).toBeCloseTo(0.01, 4);
    expect(rubberBand(100, 100)).toBeCloseTo(50);
    expect(rubberBand(300, 100)).toBeCloseTo(75);
    expect(rubberBand(1e9, 100)).toBeLessThan(100);
    expect(rubberBand(-300, 100)).toBeCloseTo(-75);
  });

  it('is zero for a limit that does not exist', () => {
    expect(rubberBand(50, 0)).toBe(0);
    expect(rubberBand(Number.NaN, 100)).toBe(0);
  });
});

describe('camera bounds inside a seat', () => {
  it('keeps the end rows a margin clear of the edges', () => {
    const layout = threeWeeks();
    const seat = shelfSeats(layout)[0];
    // A tall column: a range only exists when the run is longer than the screen
    // it is read through, less the margin at each end.
    const scale = (viewport.height * 2) / (seat.bottom - seat.top);
    const bounds = seatCameraBounds(seat, viewport, scale);
    const margin = (viewport.height * SHELF_KNOBS.END_MARGIN_RATIO) / scale;
    const half = viewport.height / 2 / scale;
    expect(bounds.min).toBeCloseTo(seat.top + half - margin);
    expect(bounds.max).toBeCloseTo(seat.bottom - half + margin);
    // At the top bound the screen's edge sits exactly one margin above the
    // first row, and at the bottom bound one margin below the last.
    expect(bounds.min - half).toBeCloseTo(seat.top - margin);
    expect(bounds.max + half).toBeCloseTo(seat.bottom + margin);
  });

  it('collapses to the middle when the column is shorter than the screen', () => {
    const layout = threeWeeks();
    const seat = shelfSeats(layout)[0];
    const bounds = seatCameraBounds(seat, viewport, layout.fitScale * 5);
    expect(bounds.min).toBe(bounds.max);
    expect(bounds.min).toBeCloseTo((seat.top + seat.bottom) / 2);
  });
});

describe('containment', () => {
  const layout = threeWeeks();
  const seats = shelfSeats(layout);
  const seat = seats[0];
  const scale = layout.fitScale * 5;
  const gap = LAYOUT_KNOBS.SHELF_GAP_WORLD;

  it('never lets a sideways drag reach the neighbouring column', () => {
    const escape = gap * SHELF_KNOBS.ESCAPE_FRACTION;
    for (const distance of [10, 100, 1000, 100_000]) {
      const held = containToSeat(
        { x: seat.cx + distance, y: seat.top, scale },
        seat,
        viewport,
        gap,
      );
      expect(held.x - seat.cx).toBeGreaterThan(0);
      expect(held.x - seat.cx).toBeLessThan(escape);
      expect(held.x - seat.cx).toBeLessThan(gap / 2);
    }
  });

  it('damps rather than freezes: more drag is always more movement', () => {
    const near = containToSeat(
      { x: seat.cx + 20, y: seat.top, scale },
      seat,
      viewport,
      gap,
    );
    const far = containToSeat(
      { x: seat.cx + 200, y: seat.top, scale },
      seat,
      viewport,
      gap,
    );
    expect(far.x).toBeGreaterThan(near.x);
  });

  it('holds a short column at its middle however hard it is dragged', () => {
    const middle = (seat.top + seat.bottom) / 2;
    const held = containToSeat(
      { x: seat.cx, y: middle + 100_000, scale },
      seat,
      viewport,
      gap,
    );
    const overscroll =
      (viewport.height * SHELF_KNOBS.OVERSCROLL_RATIO) / scale;
    expect(held.y).toBeGreaterThan(middle);
    expect(held.y).toBeLessThan(middle + overscroll);
  });

  it('leaves the scale alone — containment is not a zoom', () => {
    const held = containToSeat(
      { x: seat.cx + 500, y: seat.top - 500, scale },
      seat,
      viewport,
      gap,
    );
    expect(held.scale).toBe(scale);
  });
});

describe('what a release means', () => {
  const layout = threeWeeks();
  const seats = shelfSeats(layout);
  const gap = LAYOUT_KNOBS.SHELF_GAP_WORLD;
  const scale = layout.fitScale * 5;
  const escape = gap * SHELF_KNOBS.ESCAPE_FRACTION;

  it('returns to the seat it came from when the drag was a wander', () => {
    const from = 0;
    const released = {
      x: seats[from].cx + escape * 0.9,
      y: seats[from].top,
      scale,
    };
    expect(seatAfterRelease(seats, released, from, gap)).toBe(from);
  });

  it('leaves for the neighbour in the direction of travel', () => {
    // The two clusters that share a grid row, so one is genuinely sideways.
    const left = seats.findIndex(seat => seat.cx < 0);
    const right = seats.findIndex(seat => seat.cx > 0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(0);
    const released = {
      x: seats[left].cx + escape * 1.5,
      y: seats[left].top,
      scale,
    };
    expect(seatAfterRelease(seats, released, left, gap)).toBe(right);
  });

  it('stays put when there is nothing in that direction', () => {
    const rightmost = seats.reduce(
      (best, seat, index) => (seat.cx > seats[best].cx ? index : best),
      0,
    );
    const released = {
      x: seats[rightmost].cx + escape * 4,
      y: seats[rightmost].top,
      scale,
    };
    expect(seatAfterRelease(seats, released, rightmost, gap)).toBe(rightmost);
  });

  it('has nothing to say about a gesture that started outside a seat', () => {
    expect(seatAfterRelease(seats, { x: 0, y: 0, scale }, -1, gap)).toBe(-1);
  });
});
