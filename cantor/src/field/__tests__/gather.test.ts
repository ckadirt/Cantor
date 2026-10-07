import {
  FLIGHT_NAME,
  FOUND_GROUP_KEY,
  GATHER_KNOBS,
  MAX_GATHERED,
  bowOffsetAt,
  foundKeysOf,
  linearOfEased,
  placementFlightAtClock,
  planGatherCut,
  byPlaylist,
  byTime,
  gatherLayout,
  layoutField,
  mapFrame,
  planPlacementFlights,
  queueFrom,
  shelfRowGapWorld,
  shelfSeats,
  stepFrom,
  type FieldEntity,
  type FieldLayout,
  type Placement,
} from '..';

const viewport = { width: 392, height: 852 };
const day = 24 * 60 * 60 * 1000;
const start = Date.parse('2026-08-03T12:00:00Z');

function song(id: string, createdAtMs: number, tags: readonly string[] = []): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs,
    durationMs: 60_000,
    tags,
  };
}

/** Four weeks of three songs. */
const weeks = Array.from({ length: 12 }, (_, index) =>
  song(`s${index}`, start + Math.floor(index / 3) * 7 * day + (index % 3) * day),
);

const byDate = () =>
  layoutField({ entities: weeks, arrangement: byTime, viewport });

/** Every other placement, in field order, as `findIn` would return them. */
const everyOther = (layout: FieldLayout): readonly Placement[] =>
  layout.placements.filter((_, index) => index % 2 === 0);

const foundGroup = (layout: FieldLayout) =>
  layout.groups.find(group => group.key === FOUND_GROUP_KEY);

describe('gatherLayout', () => {
  it('moves the found songs out of their groups into FOUND, in the order given', () => {
    const layout = byDate();
    const found = [...everyOther(layout)].reverse();
    const gathered = gatherLayout(layout, found);

    const shelf = foundGroup(gathered);
    expect(shelf?.entityKeys).toEqual(found.map(p => p.entityKey));
    const column = gathered.placements.filter(
      p => p.groupKey === FOUND_GROUP_KEY,
    );
    expect(column.map(p => p.entityKey)).toEqual(shelf?.entityKeys);
    // One column, top to bottom, at the shelf's own pitch.
    const gap = shelfRowGapWorld(layout.fitScale);
    column.forEach((p, index) => {
      expect(p.x).toBe(shelf?.cx);
      expect(p.bloomX).toBe(0);
      expect(p.bloomY).toBe(0);
      if (index > 0) expect(p.y - column[index - 1].y).toBeCloseTo(gap);
    });
    expect(shelf?.topGathered).toBe(column[0].y);

    const moved = new Set(found.map(p => p.entityKey));
    for (const group of gathered.groups) {
      if (group.key === FOUND_GROUP_KEY) continue;
      expect(group.entityKeys.some(key => moved.has(key))).toBe(false);
    }
    expect(gathered.placements).toHaveLength(layout.placements.length);
  });

  it('leaves every other placement and group seat exactly as it was', () => {
    const layout = byDate();
    const found = everyOther(layout);
    const gathered = gatherLayout(layout, found);
    const moved = new Set(found.map(p => p.key));
    const kept = layout.placements.filter(p => !moved.has(p.key));
    expect(
      gathered.placements.filter(p => p.groupKey !== FOUND_GROUP_KEY),
    ).toEqual(kept);
    // The same objects: a copy, not a re-pack.
    kept.forEach((p, index) => expect(gathered.placements[index]).toBe(p));
    layout.groups.forEach((group, index) => {
      const after = gathered.groups[index];
      expect(after.key).toBe(group.key);
      expect([after.cx, after.cy, after.top]).toEqual([
        group.cx,
        group.cy,
        group.top,
      ]);
    });
    expect(gathered.targetBounds).toBe(layout.targetBounds);
    expect(gathered.fitScale).toBe(layout.fitScale);
  });

  it('plans one carry per found song and nothing else', () => {
    const layout = byDate();
    const found = everyOther(layout);
    const gathered = gatherLayout(layout, found);
    const flights = planPlacementFlights(
      layout.placements,
      gathered.placements,
      1,
    );
    const moving = flights.filter(
      f => f.fromX !== f.targetX || f.fromY !== f.targetY,
    );
    expect(moving.map(f => f.entityKey).sort()).toEqual(
      found.map(p => p.entityKey).sort(),
    );
    expect(moving.every(f => f.ownership === 'carry')).toBe(true);
    expect(flights.every(f => f.ownership === 'carry')).toBe(true);

    // And taking the shelf away flies them home the same way.
    const home = planPlacementFlights(gathered.placements, layout.placements, 2);
    expect(home.every(f => f.ownership === 'carry')).toBe(true);
    expect(
      home.filter(f => f.fromX !== f.targetX || f.fromY !== f.targetY),
    ).toHaveLength(found.length);
  });

  it('seats the column clear of the map, at the height it is asked for', () => {
    const layout = byDate();
    const gathered = gatherLayout(layout, everyOther(layout), {
      centerY: 140,
    });
    const frame = mapFrame(layout);
    const shelf = foundGroup(gathered);
    expect(frame).not.toBeNull();
    expect(shelf).toBeDefined();
    if (frame === null || shelf === undefined) return;
    expect(shelf.cx).toBeLessThan(frame.left);
    expect(frame.left - shelf.cx).toBeGreaterThanOrEqual(300);
    expect(shelf.cy).toBe(140);
  });

  it('is a shelf to the seats and the queue', () => {
    const layout = byDate();
    const found = everyOther(layout);
    const gathered = gatherLayout(layout, found);
    const seat = shelfSeats(gathered).find(s => s.key === FOUND_GROUP_KEY);
    const column = gathered.placements.filter(
      p => p.groupKey === FOUND_GROUP_KEY,
    );
    expect(seat?.top).toBe(column[0].y);
    expect(seat?.bottom).toBe(column[column.length - 1].y);

    const queue = queueFrom(gathered, column[0]);
    expect(queue.groupKey).toBe(FOUND_GROUP_KEY);
    expect(queue.entityKeys).toEqual(found.map(p => p.entityKey));
    const next = stepFrom(queue, gathered, column[0].entityKey, 1, () => true);
    expect(next?.entityKey).toBe(column[1].entityKey);
    expect(next?.placement).toBe(column[1]);
  });

  it('gathers one copy per song on the playlist axis, the first in field order', () => {
    const entities = [
      song('everywhere', start, ['p/Late', 'p/Early', 'p/Dusk']),
      song('quiet', start, ['p/Late', 'p/Dusk']),
      song('alone', start, ['p/Early']),
    ];
    const layout = layoutField({ entities, arrangement: byPlaylist, viewport });
    const found = layout.placements.filter(
      p => p.entityKey !== 'node-a:alone',
    );
    const gathered = gatherLayout(layout, found);
    expect(foundGroup(gathered)?.entityKeys).toEqual([
      found[0].entityKey,
      found.find(p => p.entityKey !== found[0].entityKey)?.entityKey,
    ]);
    // The other copies stay in their playlists, so only the gathered ones fly.
    const copies = (key: string) =>
      gathered.placements.filter(p => p.entityKey === key).length;
    expect(copies('node-a:everywhere')).toBe(3);
    expect(copies('node-a:quiet')).toBe(2);
    const flights = planPlacementFlights(
      layout.placements,
      gathered.placements,
      1,
    );
    expect(flights.every(f => f.ownership === 'carry')).toBe(true);
    const moving = flights.filter(
      f => f.fromX !== f.targetX || f.fromY !== f.targetY,
    );
    expect(moving.map(f => f.groupKey)).toEqual([
      FOUND_GROUP_KEY,
      FOUND_GROUP_KEY,
    ]);
  });

  it('flies the gathered copy itself, not the copy nearest the column', () => {
    // The found key sorts before every playlist's, so it plans first; the
    // copy it takes must be the one that left, wherever the others sit.
    const entities = [song('twice', start, ['p/Alpha', 'p/Zulu'])];
    const layout = layoutField({ entities, arrangement: byPlaylist, viewport });
    const [first, second] = layout.placements;
    for (const leaving of [first, second]) {
      const gathered = gatherLayout(layout, [leaving]);
      const flights = planPlacementFlights(
        layout.placements,
        gathered.placements,
        1,
      );
      const flying = flights.filter(
        f => f.fromX !== f.targetX || f.fromY !== f.targetY,
      );
      expect(flying).toHaveLength(1);
      expect([flying[0].fromX, flying[0].fromY]).toEqual([
        leaving.x,
        leaving.y,
      ]);
    }
  });

  it(`holds at most ${MAX_GATHERED} faces, the first in field order`, () => {
    const many = Array.from({ length: 90 }, (_, index) =>
      song(`m${index}`, start + Math.floor(index / 15) * 7 * day + index),
    );
    const layout = layoutField({ entities: many, arrangement: byTime, viewport });
    const gathered = gatherLayout(layout, layout.placements);
    expect(foundGroup(gathered)?.entityKeys).toEqual(
      layout.placements.slice(0, MAX_GATHERED).map(p => p.entityKey),
    );
    expect(gathered.placements).toHaveLength(layout.placements.length);
  });

  it('keeps every group\'s song count, so the heads behind it never change', () => {
    const layout = byDate();
    const gathered = gatherLayout(layout, everyOther(layout));
    for (const group of layout.groups) {
      const kept = gathered.groups.find(other => other.key === group.key);
      expect(kept?.songCount).toBe(group.songCount);
    }
  });

  it('returns the very same layout when nothing is found', () => {
    const layout = byDate();
    expect(gatherLayout(layout, [])).toBe(layout);
  });
});

describe('planGatherCut', () => {
  const flightsInto = (layout: FieldLayout, gathered: FieldLayout) =>
    planPlacementFlights(layout.placements, gathered.placements, 1);

  it('leaves an ordinary re-cut alone', () => {
    const layout = byDate();
    expect(planGatherCut(flightsInto(layout, layout), [], [])).toBeNull();
  });

  it('staggers arrivals in shelf order, bowed out, names writing as they land', () => {
    const layout = byDate();
    const found = everyOther(layout);
    const gathered = gatherLayout(layout, found);
    const cut = planGatherCut(
      flightsInto(layout, gathered),
      [],
      foundKeysOf(gathered),
    );
    expect(cut).not.toBeNull();
    if (cut === null) return;
    const arriving = cut.flights
      .filter(f => f.groupKey === FOUND_GROUP_KEY)
      .sort(
        (a, b) =>
          found.findIndex(p => p.entityKey === a.entityKey) -
          found.findIndex(p => p.entityKey === b.entityKey),
      );
    const ms = (fraction: number) => fraction * cut.durationMs;
    arriving.forEach((f, index) => {
      expect(f.timing?.bowPx).toBe(GATHER_KNOBS.BOW_OUT_PX);
      expect(f.timing?.name).toBe(FLIGHT_NAME.WRITE);
      expect(ms(f.timing?.start ?? -1)).toBeCloseTo(
        index * GATHER_KNOBS.STAGGER_MS,
      );
      expect(ms((f.timing?.end ?? 0) - (f.timing?.start ?? 0))).toBeCloseTo(
        GATHER_KNOBS.FLIGHT_MS,
      );
      expect(ms(f.timing?.nameStart ?? 0)).toBeCloseTo(
        index * GATHER_KNOBS.STAGGER_MS +
          GATHER_KNOBS.FLIGHT_MS * GATHER_KNOBS.NAME_WRITE_FROM,
      );
    });
    // Every window ends inside the clock.
    expect(
      cut.flights.every(f => f.timing === undefined || f.timing.end <= 1),
    ).toBe(true);
    // The rest of the map has the whole cut, and recedes.
    expect(
      cut.flights.filter(f => f.timing === undefined).length,
    ).toBe(layout.placements.length - found.length);
    expect([cut.recedeFrom, cut.recedeTo]).toEqual([
      1,
      GATHER_KNOBS.RECEDE_INK,
    ]);
  });

  it('sends leavers home on the other bow and lets the rest close ranks after', () => {
    const layout = byDate();
    const wide = gatherLayout(layout, layout.placements.slice(0, 4));
    const narrow = gatherLayout(layout, layout.placements.slice(1, 3));
    const cut = planGatherCut(
      planPlacementFlights(wide.placements, narrow.placements, 2),
      foundKeysOf(wide),
      foundKeysOf(narrow),
    );
    if (cut === null) throw new Error('no cut');
    const leaving = cut.flights.filter(
      f => f.timing?.name === FLIGHT_NAME.ERASE,
    );
    expect(leaving.map(f => f.entityKey).sort()).toEqual(
      [layout.placements[0], layout.placements[3]]
        .map(p => p.entityKey)
        .sort(),
    );
    expect(leaving.every(f => f.timing?.bowPx === GATHER_KNOBS.BOW_HOME_PX)).toBe(
      true,
    );
    leaving.forEach(f => {
      const timing = f.timing;
      if (timing === undefined) return;
      expect((timing.nameEnd - timing.nameStart) * cut.durationMs).toBeCloseTo(
        GATHER_KNOBS.NAME_ERASE_MS,
      );
    });
    const staying = cut.flights.filter(
      f => f.groupKey === FOUND_GROUP_KEY,
    );
    staying.forEach(f =>
      expect((f.timing?.start ?? 0) * cut.durationMs).toBeCloseTo(
        GATHER_KNOBS.CLOSE_RANKS_DELAY_MS,
      ),
    );
    expect([cut.recedeFrom, cut.recedeTo]).toEqual([
      GATHER_KNOBS.RECEDE_INK,
      GATHER_KNOBS.RECEDE_INK,
    ]);
  });

  it('resumes faces caught before they landed from how they stood', () => {
    const layout = byDate();
    const wide = gatherLayout(layout, layout.placements.slice(0, 4));
    const narrow = gatherLayout(layout, layout.placements.slice(1, 3));
    const [leaver, stayer, landed] = [0, 1, 2].map(
      index => layout.placements[index].entityKey,
    );
    // The leaver never got off the map; the stayer was half written.
    const held = new Map([
      [leaver, { name: 0, ink: 0.4, side: 0.1 }],
      [stayer, { name: 0.5, ink: 0.8, side: 0.9 }],
    ]);
    const cut = planGatherCut(
      planPlacementFlights(wide.placements, narrow.placements, 2),
      foundKeysOf(wide),
      foundKeysOf(narrow),
      undefined,
      held,
    );
    if (cut === null) throw new Error('no cut');
    const timingOf = (entityKey: string) =>
      cut.flights.find(
        f => f.entityKey === entityKey && f.timing !== undefined,
      )?.timing;
    expect(timingOf(leaver)).toMatchObject({
      name: FLIGHT_NAME.ERASE,
      nameFrom: 0,
      inkFrom: 0.4,
      sideFrom: 0.1,
      fromFound: true,
    });
    expect(timingOf(stayer)).toMatchObject({
      name: FLIGHT_NAME.WRITE,
      nameFrom: 0.5,
      inkFrom: 0.8,
      sideFrom: 0.9,
      fromFound: true,
    });
    // One that had landed rides, whole.
    expect(timingOf(landed)).toMatchObject({
      name: FLIGHT_NAME.RIDE,
      nameFrom: 1,
      inkFrom: 1,
      sideFrom: 1,
    });
  });

  it('keeps a long stagger inside its span', () => {
    const many = Array.from({ length: 90 }, (_, index) =>
      song(`m${index}`, start + Math.floor(index / 15) * 7 * day + index),
    );
    const layout = layoutField({ entities: many, arrangement: byTime, viewport });
    const gathered = gatherLayout(layout, layout.placements);
    const cut = planGatherCut(
      planPlacementFlights(layout.placements, gathered.placements, 1),
      [],
      foundKeysOf(gathered),
    );
    expect(cut?.durationMs).toBeCloseTo(
      GATHER_KNOBS.FLIGHT_MS + GATHER_KNOBS.MAX_STAGGER_SPAN_MS,
    );
  });
});

describe('a timed flight on the linear clock', () => {
  it('starts and lands where it should, and bows between', () => {
    const layout = byDate();
    const gathered = gatherLayout(layout, everyOther(layout));
    const cut = planGatherCut(
      planPlacementFlights(layout.placements, gathered.placements, 1),
      [],
      foundKeysOf(gathered),
    );
    const flight = cut?.flights.find(f => f.timing !== undefined);
    if (flight === undefined) throw new Error('no timed flight');
    const at = (linear: number) => placementFlightAtClock(flight, linear, 2);
    expect([at(0).x, at(0).y]).toEqual([flight.fromX, flight.fromY]);
    expect(at(1).x).toBeCloseTo(flight.targetX);
    expect(at(1).y).toBeCloseTo(flight.targetY);
    const timing = flight.timing;
    if (timing === undefined) return;
    const mid = at((timing.start + timing.end) / 2);
    const straightX = (flight.fromX + flight.targetX) / 2;
    const straightY = (flight.fromY + flight.targetY) / 2;
    // Half the bow, in world units at 2 px each.
    expect(Math.hypot(mid.x - straightX, mid.y - straightY)).toBeCloseTo(
      GATHER_KNOBS.BOW_OUT_PX / 2 / 2,
    );
  });

  it('bows out and home on opposite sides of the chord', () => {
    const out = bowOffsetAt(-100, 40, 70, 0.5);
    const home = bowOffsetAt(100, -40, -50, 0.5);
    expect(out.x).toBeLessThan(0);
    expect(home.x).toBeGreaterThan(0);
  });

  it('recovers the linear clock under the eased one', () => {
    for (const t of [0, 0.1, 0.37, 0.5, 0.82, 1]) {
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      expect(linearOfEased(eased)).toBeCloseTo(t, 5);
    }
  });
});
