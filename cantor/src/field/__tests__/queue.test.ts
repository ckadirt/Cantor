import {
  layoutField,
  liveOrder,
  orderByKey,
  queueFrom,
  stepFrom,
  type FieldEntity,
  type FieldLayout,
} from '..';
import { byTime } from '../arrangements';

const viewport = { width: 412, height: 892 };
const day = 24 * 60 * 60 * 1000;
const monday = Date.parse('2026-08-24T12:00:00Z');

function entity(id: string, createdAtMs: number, durationMs: number): FieldEntity {
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

/** One week of four songs whose date order and duration order disagree. */
const week = [
  entity('a', monday, 240_000),
  entity('b', monday + day, 60_000),
  entity('c', monday + 2 * day, 180_000),
  entity('d', monday + 3 * day, 120_000),
];

function lay(orderKey: string, entities = week): FieldLayout {
  return layoutField({
    entities,
    arrangement: byTime,
    viewport,
    order: orderByKey(orderKey),
  });
}

const all = () => true;

function startedAt(layout: FieldLayout, entityKey: string) {
  const placement = layout.placements.find(p => p.entityKey === entityKey);
  if (placement === undefined) throw new Error(`no mark for ${entityKey}`);
  return { placement, queue: queueFrom(layout, placement) };
}

describe('the shelf is the queue', () => {
  it('plays on in the order the cluster is seated', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[0]);

    const next = stepFrom(queue, layout, order[0], 1, all);
    expect(next?.entityKey).toBe(order[1]);
    expect(next?.placement?.entityKey).toBe(order[1]);
    expect(next?.placement?.groupKey).toBe(queue.groupKey);
  });

  it('steps back up the cluster for the previous song', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[2]);

    expect(stepFrom(queue, layout, order[2], -1, all)?.entityKey).toBe(order[1]);
  });

  it('stops at either end of the cluster rather than wrapping', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[order.length - 1]);

    expect(stepFrom(queue, layout, order[order.length - 1], 1, all)).toBeNull();
    expect(stepFrom(queue, layout, order[0], -1, all)).toBeNull();
  });

  it('steps over marks that cannot play', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[0]);
    const silent = new Set([order[1], order[2]]);

    const next = stepFrom(queue, layout, order[0], 1, key => !silent.has(key));
    expect(next?.entityKey).toBe(order[3]);
  });

  it('passes over songs that already refused in this advance', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[0]);

    const next = stepFrom(queue, layout, order[0], 1, all, new Set([order[1]]));
    expect(next?.entityKey).toBe(order[2]);
  });

  it('follows a re-sort made while the song was playing', () => {
    const byDate = lay('date');
    const { queue } = startedAt(byDate, 'node-a:b');
    // By date, b is followed by a or c; by duration (b 1:00, d 2:00) by d.
    expect(stepFrom(queue, byDate, 'node-a:b', 1, all)?.entityKey).not.toBe(
      'node-a:d',
    );
    const byDuration = lay('duration');

    expect(liveOrder(queue, byDuration, 'node-a:b')).toBe(
      byDuration.groups[0].entityKeys,
    );
    expect(stepFrom(queue, byDuration, 'node-a:b', 1, all)?.entityKey).toBe(
      'node-a:d',
    );
  });

  it('keeps the order it started with when the cluster is gone', () => {
    const layout = lay('date');
    const order = layout.groups[0].entityKeys;
    const { queue } = startedAt(layout, order[0]);
    // The song left the field: its cluster no longer holds it.
    const without = lay(
      'date',
      week.filter(item => item.key !== order[0]),
    );

    const next = stepFrom(queue, without, order[0], 1, all);
    expect(next?.entityKey).toBe(order[1]);
  });

  it('answers nothing for a song the queue never held', () => {
    const layout = lay('date');
    const { queue } = startedAt(layout, 'node-a:a');

    expect(stepFrom(queue, layout, 'node-a:zz', 1, all)).toBeNull();
  });
});
