import type { FieldLayout, Placement } from './types';

/**
 * The shelf is the queue.
 *
 * There is no list to manage anywhere in Cantor: a song is started from a mark,
 * the mark sits in a cluster, and the cluster's seating *is* the order it plays
 * in — `layoutField` seats a member at its index, so what you see is what comes
 * next. A queue is therefore only a pointer back into the field: which cluster
 * the song was started from, and the order that cluster had at that instant.
 *
 * The group key is what makes a playlist play. A song in three playlists is
 * three marks in three clusters, and the one that was pressed decides which of
 * the three runs on after it.
 */
export type ShelfQueue = Readonly<{
  groupKey: string;
  /**
   * The seating when the song began, held for one reason: the cluster may be
   * gone when the song ends — the arrangement changed, or the song left it —
   * and a queue that forgets its neighbours then would stop for no reason a
   * person could see.
   */
  entityKeys: readonly string[];
}>;

/** One step's answer: the song to play next and the mark it plays from. */
export type QueueStep = Readonly<{
  entityKey: string;
  /** The live mark, or null when the cluster is no longer on the field. */
  placement: Placement | null;
}>;

/** The queue a song started from `placement` runs through. */
export function queueFrom(
  layout: FieldLayout,
  placement: Placement,
): ShelfQueue {
  const group = layout.groups.find(
    candidate => candidate.key === placement.groupKey,
  );
  return {
    groupKey: placement.groupKey,
    entityKeys: group?.entityKeys ?? [placement.entityKey],
  };
}

/**
 * The order to walk *now*.
 *
 * The live seating wins whenever it still holds the song: re-sorting a cluster
 * mid-song re-forms it on screen, and the next song has to be the one that is
 * now sitting under it, or "the order you see is the order it plays" is only
 * true until someone touches the order dial.
 */
export function liveOrder(
  queue: ShelfQueue,
  layout: FieldLayout | null,
  entityKey: string,
): readonly string[] {
  const group = layout?.groups.find(
    candidate => candidate.key === queue.groupKey,
  );
  if (group !== undefined && group.entityKeys.includes(entityKey)) {
    return group.entityKeys;
  }
  return queue.entityKeys;
}

/**
 * The nearest playable neighbour of `entityKey`, one way along the shelf.
 *
 * `direction` is +1 for the song under it and −1 for the one above. Marks that
 * cannot play — a generation that failed, a song whose delivery has not landed
 * — are stepped over rather than stopped at, because a failed run sitting in a
 * week is not the end of that week's music. The ends of the cluster are the
 * end: nothing wraps, and nothing runs on into the next group.
 *
 * `except` is for the skip after a failure: songs that already refused to play
 * in this advance are passed over as if they could not.
 */
export function stepFrom(
  queue: ShelfQueue,
  layout: FieldLayout | null,
  entityKey: string,
  direction: 1 | -1,
  playable: (entityKey: string) => boolean,
  except: ReadonlySet<string> = new Set(),
): QueueStep | null {
  const order = liveOrder(queue, layout, entityKey);
  const at = order.indexOf(entityKey);
  if (at < 0) return null;
  for (
    let index = at + direction;
    index >= 0 && index < order.length;
    index += direction
  ) {
    const candidate = order[index];
    if (except.has(candidate) || !playable(candidate)) continue;
    return {
      entityKey: candidate,
      placement: placementOf(layout, queue.groupKey, candidate),
    };
  }
  return null;
}

/** The mark `entityKey` has in `groupKey`, if the field still draws it there. */
export function placementOf(
  layout: FieldLayout | null,
  groupKey: string,
  entityKey: string,
): Placement | null {
  return (
    layout?.placements.find(
      placement =>
        placement.groupKey === groupKey && placement.entityKey === entityKey,
    ) ?? null
  );
}
