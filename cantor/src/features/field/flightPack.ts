import type {
  FlightOwnership,
  FlightTiming,
  PlacementFlight,
} from '../../field';

/**
 * A cut's flights, packed for the trip to the UI thread.
 *
 * Every re-cut sends all of its flights — a letter typed into find, a filter,
 * an order — and the UI thread rebuilt them field by field from the transfer:
 * at 872 songs ~100 ms of the Xiaomi's UI thread per letter, before the cut
 * could even start, the frames standing still meanwhile. Packed, the numbers
 * cross as one buffer and the keys as one string, and the UI thread rebuilds
 * the same objects in a plain loop (`unpackFlights`), a few milliseconds.
 */
export type PackedFlights = Readonly<{
  count: number;
  /** `STRIDE` numbers a flight; see the `AT` offsets. */
  numbers: Float64Array;
  /** key, entity, group and target of every flight, joined by `SEP`. */
  keys: string;
}>;

const STRIDE = 27;
/** Between two keys; no key holds it. */
const SEP = '\u0001';
/** A target key that is null. */
const NONE = '\u0002';

const OWNERSHIPS: readonly FlightOwnership[] = [
  'carry',
  'branch',
  'fold',
  'enter',
  'exit',
];

export function packFlights(flights: readonly PlacementFlight[]): PackedFlights {
  const count = flights.length;
  const numbers = new Float64Array(count * STRIDE);
  const keys: string[] = [];
  for (let index = 0; index < count; index++) {
    const f = flights[index];
    const o = index * STRIDE;
    numbers[o] = f.x;
    numbers[o + 1] = f.y;
    numbers[o + 2] = f.fromX;
    numbers[o + 3] = f.fromY;
    numbers[o + 4] = f.targetX;
    numbers[o + 5] = f.targetY;
    numbers[o + 6] = f.bloomX;
    numbers[o + 7] = f.bloomY;
    numbers[o + 8] = f.fromBloomX;
    numbers[o + 9] = f.fromBloomY;
    numbers[o + 10] = f.targetBloomX;
    numbers[o + 11] = f.targetBloomY;
    // Absent is NaN: no flight carries a NaN opacity.
    numbers[o + 12] = f.opacity === undefined ? NaN : f.opacity;
    numbers[o + 13] = f.fromAlpha;
    numbers[o + 14] = f.targetAlpha;
    numbers[o + 15] = OWNERSHIPS.indexOf(f.ownership);
    const t = f.timing;
    numbers[o + 16] = t === undefined ? 0 : 1;
    if (t !== undefined) {
      numbers[o + 17] = t.start;
      numbers[o + 18] = t.end;
      numbers[o + 19] = t.bowPx;
      numbers[o + 20] = t.name;
      numbers[o + 21] = t.nameStart;
      numbers[o + 22] = t.nameEnd;
      numbers[o + 23] = t.fromFound ? 1 : 0;
      numbers[o + 24] = t.nameFrom;
      numbers[o + 25] = t.inkFrom;
      numbers[o + 26] = t.sideFrom;
    }
    keys.push(
      f.key,
      f.entityKey,
      f.groupKey,
      f.targetPlacementKey === null || f.targetPlacementKey === undefined
        ? NONE
        : f.targetPlacementKey,
    );
  }
  return { count, numbers, keys: keys.join(SEP) };
}

/** The flights `packFlights` packed, as they were. On the UI thread. */
export function unpackFlights(packed: PackedFlights): PlacementFlight[] {
  'worklet';
  const { count, numbers } = packed;
  const keys = packed.keys.length === 0 ? [] : packed.keys.split(SEP);
  const flights: PlacementFlight[] = [];
  for (let index = 0; index < count; index++) {
    const o = index * STRIDE;
    const k = index * 4;
    const target = keys[k + 3];
    const flight: Record<string, unknown> = {
      key: keys[k],
      entityKey: keys[k + 1],
      groupKey: keys[k + 2],
      x: numbers[o],
      y: numbers[o + 1],
      fromX: numbers[o + 2],
      fromY: numbers[o + 3],
      targetX: numbers[o + 4],
      targetY: numbers[o + 5],
      bloomX: numbers[o + 6],
      bloomY: numbers[o + 7],
      fromBloomX: numbers[o + 8],
      fromBloomY: numbers[o + 9],
      targetBloomX: numbers[o + 10],
      targetBloomY: numbers[o + 11],
      fromAlpha: numbers[o + 13],
      targetAlpha: numbers[o + 14],
      ownership: OWNERSHIPS[numbers[o + 15]],
      targetPlacementKey: target === NONE ? null : target,
    };
    const opacity = numbers[o + 12];
    if (opacity === opacity) flight.opacity = opacity;
    if (numbers[o + 16] === 1) {
      const timing: FlightTiming = {
        start: numbers[o + 17],
        end: numbers[o + 18],
        bowPx: numbers[o + 19],
        name: numbers[o + 20],
        nameStart: numbers[o + 21],
        nameEnd: numbers[o + 22],
        fromFound: numbers[o + 23] === 1,
        nameFrom: numbers[o + 24],
        inkFrom: numbers[o + 25],
        sideFrom: numbers[o + 26],
      };
      flight.timing = timing;
    }
    flights.push(flight as PlacementFlight);
  }
  return flights;
}
