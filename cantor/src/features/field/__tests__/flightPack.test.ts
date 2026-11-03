/**
 * A cut's flights cross to the UI thread packed (`flightPack.ts`) and come
 * out as they went in: every field, every absent field still absent.
 */
import {
  byDate,
  gatherLayout,
  layoutField,
  planGatherCut,
  planPlacementFlights,
  type FieldEntity,
} from '../../../field';
import { packFlights, unpackFlights } from '../flightPack';

const viewport = { width: 380, height: 800 };
const entities: FieldEntity[] = Array.from({ length: 90 }, (_, index) => ({
  key: `node-a:song-${index}`,
  nodePublicKey: 'node-a',
  entityId: `song-${index}`,
  kind: 'song' as const,
  createdAtMs: Date.UTC(2026, 7, 8) - index * ((index % 4) + 2) * 86_400_000,
  durationMs: 0,
  tags: [],
}));
const weeks = layoutField({ entities, arrangement: byDate('week'), viewport });
const years = layoutField({ entities, arrangement: byDate('year'), viewport });

describe('packed flights', () => {
  it('unpack to the flights of a re-cut, exactly', () => {
    const flights = planPlacementFlights(weeks.placements, years.placements, 2);
    expect(flights.length).toBeGreaterThan(0);
    expect(unpackFlights(packFlights(flights))).toStrictEqual(flights);
  });

  it('unpack to a gather, timings and all', () => {
    const found = weeks.placements.filter((_, index) => index % 5 === 0);
    const gathered = gatherLayout(weeks, found);
    const cut = planGatherCut(
      planPlacementFlights(weeks.placements, gathered.placements, 3),
      [],
      found.map(placement => placement.entityKey),
    )!;
    expect(cut.flights.some(flight => flight.timing !== undefined)).toBe(true);
    expect(unpackFlights(packFlights(cut.flights))).toStrictEqual(cut.flights);
  });

  it('unpack nothing to nothing', () => {
    expect(unpackFlights(packFlights([]))).toStrictEqual([]);
  });
});
