import {
  byDate,
  layoutField,
  placementFlightAt,
  planPlacementFlights,
  type FieldEntity,
  type Placement,
} from '..';

const placement = (
  key: string,
  entityKey: string,
  x: number,
  y: number,
): Placement => ({
  key,
  entityKey,
  groupKey: key,
  x,
  y,
  fromX: x,
  fromY: y,
  targetX: x,
  targetY: y,
  bloomX: 0,
  bloomY: 0,
  fromBloomX: 0,
  fromBloomY: 0,
  targetBloomX: 0,
  targetBloomY: 0,
});

describe('field re-cut placement flights', () => {
  it('fans one owned mark into playlist copies without a dark first frame', () => {
    const source = placement('date:a', 'song-a', 0, 0);
    const targets = [
      placement('playlist:drive:a', 'song-a', -100, 80),
      placement('playlist:focus:a', 'song-a', 100, -80),
    ];
    const flights = planPlacementFlights([source], targets, 1);
    const start = flights.map(flight => placementFlightAt(flight, 0));
    const end = flights.map(flight => placementFlightAt(flight, 1));

    expect(start).toHaveLength(2);
    expect(start.map(item => item.opacity).sort()).toEqual([0, 1]);
    expect(
      start.every(item => item.x === source.x && item.y === source.y),
    ).toBe(true);
    expect(end.map(item => item.opacity)).toEqual([1, 1]);
    expect(end.map(item => item.x).sort((a, b) => a - b)).toEqual([-100, 100]);
  });

  it('keeps every playlist owner while copies fold into one date mark', () => {
    const sources = [
      placement('playlist:drive:a', 'song-a', -100, 80),
      placement('playlist:focus:a', 'song-a', 100, -80),
    ];
    const target = placement('date:a', 'song-a', 0, 0);
    const flights = planPlacementFlights(sources, [target], 2);
    const start = flights.map(flight => placementFlightAt(flight, 0));
    const end = flights.map(flight => placementFlightAt(flight, 1));

    expect(start.map(item => item.opacity)).toEqual([1, 1]);
    expect(new Set(start.map(item => `${item.x},${item.y}`)).size).toBe(2);
    expect(end.filter(item => item.opacity === 1)).toHaveLength(1);
    expect(end.filter(item => item.opacity === 0)).toHaveLength(1);
    expect(end.every(item => item.x === 0 && item.y === 0)).toBe(true);
  });

  it('retargets from captured mid-flight geometry and opacity', () => {
    const source = placement('week:a', 'song-a', -120, -80);
    const month = placement('month:a', 'song-a', 80, 120);
    const year = placement('year:a', 'song-a', 0, -160);
    const first = planPlacementFlights([source], [month], 1)[0];
    const captured = placementFlightAt(first, 0.37);
    const second = planPlacementFlights([captured], [year], 2)[0];
    const restarted = placementFlightAt(second, 0);

    expect(restarted).toMatchObject({
      x: captured.x,
      y: captured.y,
      bloomX: captured.bloomX,
      bloomY: captured.bloomY,
      opacity: captured.opacity,
    });
  });

  it('gives every Week, Month, and Year re-cut a continuous source pose', () => {
    const fieldEntities: FieldEntity[] = [
      [2025, 12, 29],
      [2026, 1, 12],
      [2026, 8, 30],
      [2027, 2, 1],
    ].map(([year, month, day], index) => ({
      key: `node-a:song-${index}`,
      nodePublicKey: 'node-a',
      entityId: `song-${index}`,
      kind: 'song' as const,
      createdAtMs: new Date(year, month - 1, day, 12).getTime(),
      tags: [],
    }));
    const viewport = { width: 380, height: 800 };
    const layouts = (['week', 'month', 'year'] as const).map(resolution =>
      layoutField({
        entities: fieldEntities,
        arrangement: byDate(resolution),
        viewport,
      }),
    );

    for (let index = 1; index < layouts.length; index += 1) {
      const before = layouts[index - 1].placements;
      const after = layouts[index].placements;
      const start = planPlacementFlights(before, after, index).map(flight =>
        placementFlightAt(flight, 0),
      );
      for (const item of start) {
        const source = before.find(
          candidate => candidate.entityKey === item.entityKey,
        );
        expect(source).toBeDefined();
        expect(item).toMatchObject({
          x: source!.x,
          y: source!.y,
          bloomX: source!.bloomX,
          bloomY: source!.bloomY,
        });
      }
    }
  });
});
