import {
  FOUND_GROUP_KEY,
  MAX_GATHERED,
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

  it('returns the very same layout when nothing is found', () => {
    const layout = byDate();
    expect(gatherLayout(layout, [])).toBe(layout);
  });
});
