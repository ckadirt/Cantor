import { useCallback, useEffect, useRef } from 'react';
import {
  queueFrom,
  stepFrom,
  type FieldLayout,
  type Placement,
  type QueueStep,
  type ShelfQueue,
} from '../../field';
import type {
  AfterSong,
  PlayerController,
  PlayerPort,
  PlayerSnapshot,
} from '../../player';
import { audioRefOf, type FieldPresentation } from './useFieldController';

/** KNOBS — how the shelf plays on. */
export const SHELF_QUEUE_KNOBS = {
  /**
   * How far into a song "previous" means "from the top" rather than "the song
   * before". Every player does this, and a person pressing back mid-song
   * almost always wants the song they are in.
   */
  RESTART_WITHIN_SECONDS: 3,
  /**
   * How many songs in a row may refuse — the node is offline, the file will
   * not open — before an advance gives up and lets the shelf stop. Enough to
   * step over a bad patch; few enough not to walk an offline week to its end.
   */
  MAX_REFUSALS: 3,
} as const;

type Options = {
  player: PlayerPort;
  transport: PlayerController;
  afterSong: AfterSong;
  layout: FieldLayout | null;
  presentations: ReadonlyMap<string, FieldPresentation>;
  /**
   * A verified local path for this song, fetching it first if the phone does
   * not have it. Throws when the song cannot be had.
   */
  fetchPath: (presentation: FieldPresentation) => Promise<string>;
  /** Fetch ahead, without playing. Failure is silent: the advance retries. */
  prefetch: (presentation: FieldPresentation) => Promise<void>;
  /**
   * The queue is moving from one song to another, before the new one has
   * loaded — the moment to move the camera, so the wait is watched on the song
   * being waited for.
   */
  onMove: (fromEntityKey: string, to: QueueStep) => void;
  onError: (message: string | null) => void;
};

export type ShelfQueueController = {
  /** Play a song from its mark, making that mark's shelf the queue. */
  start(presentation: FieldPresentation, placement: Placement): Promise<void>;
  /**
   * The transport's steps. `origin` is the mark the press was made on; when
   * it is not the song playing, its shelf becomes the queue first.
   */
  skip(direction: 1 | -1, origin?: Placement | null): Promise<void>;
};

/**
 * The shelf, played through.
 *
 * Owns the one piece of state the field does not already hold — which shelf
 * the current song was started from — and every way of moving along it: a
 * song running off its end, the transport's steps, and the lock screen's.
 *
 * **Ended is heard on the port, not in an effect.** The song that matters most
 * ends in a pocket, with the screen off. A React effect only runs after a
 * commit the scheduler may not get to while the app is backgrounded, so the
 * advance listens to `PlayerPort.subscribe` directly, which the adapter calls
 * synchronously from the element's own `onEnded`.
 *
 * **Every play takes a ticket.** An advance spends most of its time waiting on
 * a download, and a person can tap another song meanwhile; the stale advance
 * must not land on top of their choice. Each start or step takes the next
 * number and only the holder of the newest one may open a track.
 */
export function useShelfQueue({
  player,
  transport,
  afterSong,
  layout,
  presentations,
  fetchPath,
  prefetch,
  onMove,
  onError,
}: Options): ShelfQueueController {
  const queue = useRef<Readonly<{ shelf: ShelfQueue; entityKey: string }> | null>(
    null,
  );
  const ticket = useRef(0);
  const prefetching = useRef(new Map<string, Promise<void>>());

  // Everything an advance reads, read at the moment it runs rather than at the
  // render that created it: the advance may fire long after that render.
  const latest = useRef({
    afterSong,
    layout,
    presentations,
    fetchPath,
    prefetch,
    onMove,
    onError,
    transport,
  });
  latest.current = {
    afterSong,
    layout,
    presentations,
    fetchPath,
    prefetch,
    onMove,
    onError,
    transport,
  };

  const playable = useCallback((entityKey: string) => {
    const presentation = latest.current.presentations.get(entityKey);
    return presentation !== undefined && presentation.playable;
  }, []);

  /** Fetch, then open — unless a newer play has been asked for meanwhile. */
  const open = useCallback(
    async (presentation: FieldPresentation, held: number): Promise<boolean> => {
      const key = presentation.entity.key;
      const ahead = prefetching.current.get(key);
      if (ahead !== undefined) await ahead.catch(() => undefined);
      const path = await latest.current.fetchPath(presentation);
      if (held !== ticket.current) return false;
      const ref = audioRefOf(presentation);
      if (ref === null) throw new Error('This song has no audio yet.');
      await latest.current.transport.open(ref, path, {
        title: presentation.title,
        artist: presentation.label,
      });
      if (player.snapshot().state === 'error') {
        throw new Error(player.snapshot().error ?? 'This song would not open.');
      }
      return true;
    },
    [player],
  );

  const start = useCallback(
    async (presentation: FieldPresentation, placement: Placement) => {
      const field = latest.current.layout;
      const held = (ticket.current += 1);
      queue.current = {
        shelf:
          field === null
            ? { groupKey: placement.groupKey, entityKeys: [placement.entityKey] }
            : queueFrom(field, placement),
        entityKey: placement.entityKey,
      };
      latest.current.onError(null);
      try {
        await open(presentation, held);
      } catch (error) {
        if (held === ticket.current) latest.current.onError(readError(error));
      }
    },
    [open],
  );

  /**
   * Walk one way from the current song to the first that will play.
   *
   * Returns whether anything started. A song that refuses is stepped over, up
   * to `MAX_REFUSALS`, and the error that stopped the walk is the one shown.
   */
  const advance = useCallback(
    async (direction: 1 | -1): Promise<boolean> => {
      const current = queue.current;
      if (current === null) return false;
      const held = (ticket.current += 1);
      const refused = new Set<string>();
      let lastError: unknown = null;
      // Where the last move left the camera: after a refusal, that is the
      // song that refused, not the one the walk began from.
      let leaving = current.entityKey;
      while (refused.size < SHELF_QUEUE_KNOBS.MAX_REFUSALS) {
        const next = stepFrom(
          current.shelf,
          latest.current.layout,
          current.entityKey,
          direction,
          playable,
          refused,
        );
        const presentation =
          next === null ? undefined : latest.current.presentations.get(next.entityKey);
        if (next === null || presentation === undefined) break;
        latest.current.onMove(leaving, next);
        leaving = next.entityKey;
        queue.current = { shelf: current.shelf, entityKey: next.entityKey };
        try {
          if (!(await open(presentation, held))) return false;
          latest.current.onError(null);
          return true;
        } catch (error) {
          if (held !== ticket.current) return false;
          lastError = error;
          refused.add(next.entityKey);
        }
      }
      if (lastError !== null) latest.current.onError(readError(lastError));
      return false;
    },
    [open, playable],
  );

  const skip = useCallback(
    async (direction: 1 | -1, origin: Placement | null = null) => {
      const field = latest.current.layout;
      const held = player.snapshot();
      const isCurrent =
        origin === null ||
        (queue.current !== null && queue.current.entityKey === origin.entityKey);
      if (!isCurrent && origin !== null && field !== null) {
        queue.current = {
          shelf: queueFrom(field, origin),
          entityKey: origin.entityKey,
        };
      }
      // Asked of the port *now*, not of the visual clock: the port's position
      // follows the element's own position events, which keep arriving with
      // the screen off, while the visual clock is an animation that only
      // moves when frames are drawn — and the lock screen's back button is
      // pressed exactly when none are.
      const at = held.positionSeconds;
      const restart = () =>
        held.state === 'ended' ? player.play() : player.seek(0);
      if (
        direction === -1 &&
        isCurrent &&
        held.track !== null &&
        at > SHELF_QUEUE_KNOBS.RESTART_WITHIN_SECONDS
      ) {
        await restart();
        return;
      }
      const moved = await advance(direction);
      // Back from the first song on the shelf is the top of that song.
      if (!moved && direction === -1 && isCurrent && held.track !== null) {
        await restart();
      }
    },
    [advance, player],
  );

  // A song ran off its end. Heard once per ending: the adapter may publish
  // `ended` again before anything else happens, and one ending is one advance.
  useEffect(() => {
    let previous: PlayerSnapshot = player.snapshot();
    return player.subscribe(snapshot => {
      const ended = snapshot.state === 'ended' && previous.state !== 'ended';
      previous = snapshot;
      if (!ended) return;
      const mode = latest.current.afterSong;
      if (mode === 'repeat') {
        // `play` from `ended` starts from the top: the port promises it.
        player.play().catch(() => undefined);
      } else if (mode === 'continue') {
        advance(1).catch(() => undefined);
      }
    });
  }, [advance, player]);

  // Fetch the next song while this one plays, so the advance is a swap and
  // not a wait. One song ahead, into the cache — a loan the budget may reclaim,
  // which is what "cached is what you get by listening" already means.
  const track = transport.snapshot.track;
  const trackKey = track === null ? null : `${track.nodeKey}:${track.songId}`;
  const upcoming =
    afterSong !== 'continue' || queue.current === null || trackKey === null
      ? null
      : queue.current.entityKey !== trackKey
      ? null
      : stepFrom(queue.current.shelf, layout, trackKey, 1, playable);
  const upcomingPresentation =
    upcoming === null ? undefined : presentations.get(upcoming.entityKey);
  const upcomingState = upcomingPresentation?.localAudio.state;
  useEffect(() => {
    if (upcomingPresentation === undefined) return;
    if (upcomingState === 'cached' || upcomingState === 'pinned') return;
    const key = upcomingPresentation.entity.key;
    if (prefetching.current.has(key)) return;
    const run = latest.current
      .prefetch(upcomingPresentation)
      .catch(() => undefined)
      .finally(() => prefetching.current.delete(key));
    prefetching.current.set(key, run);
    // Keyed on the song and its state, not the presentation object, which is
    // rebuilt on every progress sample of the very download started here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingPresentation?.entity.key, upcomingState]);

  return { start, skip };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
