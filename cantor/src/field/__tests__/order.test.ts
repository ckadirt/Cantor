import {
  DEFAULT_ORDER_KEY,
  SONG_ORDERS,
  layoutField,
  orderByKey,
  orderMembers,
  type FieldEntity,
} from '..';
import { byTime } from '../arrangements';

const viewport = { width: 380, height: 800 };

function entity(
  id: string,
  createdAtMs: number,
  durationMs: number,
): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs,
    durationMs,
    tags: [],
  };
}

// One week, so every song lands in one cluster and order is the only variable.
const day = 24 * 60 * 60 * 1000;
const monday = Date.parse('2026-08-24T12:00:00Z');
const songs = [
  entity('c', monday + 2 * day, 30_000),
  entity('a', monday, 240_000),
  entity('b', monday + day, 120_000),
];
const byKey = new Map(songs.map(song => [song.key, song]));

describe('the three orders', () => {
  it('registers exactly the three the design ships, and defaults to date', () => {
    expect(SONG_ORDERS.map(order => order.key)).toEqual([
      'date',
      'random',
      'duration',
    ]);
    expect(orderByKey(DEFAULT_ORDER_KEY).key).toBe('date');
    // An order key from restored state that no longer exists must not crash
    // the field; the default is the honest fallback.
    expect(orderByKey('manual').key).toBe('date');
  });

  it('seats by date, oldest first', () => {
    const seated = orderMembers(
      songs.map(song => song.key),
      byKey,
      orderByKey('date'),
      0,
    );
    expect(seated).toEqual(['node-a:a', 'node-a:b', 'node-a:c']);
  });

  it('seats by duration, shortest first', () => {
    const seated = orderMembers(
      songs.map(song => song.key),
      byKey,
      orderByKey('duration'),
      0,
    );
    expect(seated).toEqual(['node-a:c', 'node-a:b', 'node-a:a']);
  });

  it('holds a random order still while the seed is held', () => {
    const keys = songs.map(song => song.key);
    const first = orderMembers(keys, byKey, orderByKey('random'), 41822);
    const again = orderMembers(keys, byKey, orderByKey('random'), 41822);

    expect(again).toEqual(first);
    // …and it is an order, not the input order.
    expect(first).toHaveLength(3);
    expect([...first].sort()).toEqual([...keys].sort());
  });

  it('re-forms when the seed changes, which is what asking again means', () => {
    const keys = [...Array(24).keys()].map(index => `node-a:song-${index}`);
    const many = new Map(
      keys.map(key => [key, entity(key.split(':')[1], monday, 60_000)]),
    );
    const first = orderMembers(keys, many, orderByKey('random'), 1);
    const second = orderMembers(keys, many, orderByKey('random'), 2);

    expect(second).not.toEqual(first);
  });

  it('is total: equal ranks still resolve to one stable order', () => {
    const tied = [entity('b', monday, 60_000), entity('a', monday, 60_000)];
    const tiedByKey = new Map(tied.map(song => [song.key, song]));
    const keys = tied.map(song => song.key);

    for (const order of SONG_ORDERS) {
      const first = orderMembers(keys, tiedByKey, order, 7);
      const reversed = orderMembers([...keys].reverse(), tiedByKey, order, 7);
      expect(reversed).toEqual(first);
    }
  });
});

describe('order is position', () => {
  it('re-seats a cluster’s members rather than relabelling them', () => {
    const dated = layoutField({
      entities: songs,
      arrangement: byTime,
      viewport,
      order: orderByKey('date'),
    });
    const byDuration = layoutField({
      entities: songs,
      arrangement: byTime,
      viewport,
      order: orderByKey('duration'),
    });

    const seatOf = (layout: typeof dated, entityKey: string) =>
      layout.placements.find(placement => placement.entityKey === entityKey)
        ?.targetY;

    // The longest song sat first by date and sits last by duration: the seat
    // moved, which is what the tween animates.
    expect(seatOf(dated, 'node-a:a')).toBeLessThan(
      seatOf(dated, 'node-a:c') as number,
    );
    expect(seatOf(byDuration, 'node-a:a')).toBeGreaterThan(
      seatOf(byDuration, 'node-a:c') as number,
    );
  });

  it('gives every member a seat under every order, losing none', () => {
    for (const order of SONG_ORDERS) {
      const layout = layoutField({
        entities: songs,
        arrangement: byTime,
        viewport,
        order,
        orderSeed: 3,
      });
      expect(layout.placements).toHaveLength(songs.length);
      expect(new Set(layout.placements.map(p => p.entityKey)).size).toBe(
        songs.length,
      );
    }
  });
});
