import type { Placement } from '../../field';

/** KNOBS — songs that just arrived open album by album (flow-plan I7j). */
export const OPENING_KNOBS = {
  /** Between one album's opening and the next, at most. */
  ALBUM_MS: 520,
  /**
   * The whole arrival, at most: past this many albums the step shrinks, so a
   * first bring-in of hundreds of albums is a sweep, not a minute and a half.
   */
  TOTAL_MS: 3000,
  /** One mark, from a point to its size: a lens change's coming beat. */
  OPEN_MS: 420,
} as const;

/** When each arriving song opens, in ms after the clock starts. */
export type OpeningPlan = Readonly<{
  at: ReadonlyMap<string, number>;
  /** When the last mark has opened. */
  endMs: number;
}>;

/**
 * Plan an arrival: the new songs grouped by album, the albums in the order
 * the field reads (top to bottom, then left to right, by each album's first
 * placement), each a step after the one before. Songs the layout does not
 * place open with the last album.
 */
export function planOpening(
  ids: readonly string[],
  placements: readonly Placement[],
  albumOf: (id: string) => string | null,
): OpeningPlan | null {
  if (ids.length === 0) return null;
  const wanted = new Set(ids);
  const seat = new Map<string, { y: number; x: number }>();
  for (const placement of placements) {
    if (!wanted.has(placement.entityKey)) continue;
    const at = seat.get(placement.entityKey);
    if (
      at === undefined ||
      placement.targetY < at.y ||
      (placement.targetY === at.y && placement.targetX < at.x)
    ) {
      seat.set(placement.entityKey, {
        y: placement.targetY,
        x: placement.targetX,
      });
    }
  }
  const albums = new Map<string, { y: number; x: number; ids: string[] }>();
  for (const id of ids) {
    const key = albumOf(id) ?? `song:${id}`;
    const at = seat.get(id) ?? { y: Infinity, x: Infinity };
    const album = albums.get(key);
    if (album === undefined) albums.set(key, { ...at, ids: [id] });
    else {
      album.ids.push(id);
      if (at.y < album.y || (at.y === album.y && at.x < album.x)) {
        album.y = at.y;
        album.x = at.x;
      }
    }
  }
  const order = [...albums.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const step = Math.min(
    OPENING_KNOBS.ALBUM_MS,
    OPENING_KNOBS.TOTAL_MS / Math.max(1, order.length),
  );
  const at = new Map<string, number>();
  order.forEach((album, index) => {
    for (const id of album.ids) at.set(id, index * step);
  });
  return { at, endMs: (order.length - 1) * step + OPENING_KNOBS.OPEN_MS };
}

/**
 * How open a mark is, 0..1, `elapsed` ms into the arrival: smootherstep over
 * `OPEN_MS` from its own start. A mark that is not arriving (`openAt` < 0) is
 * open.
 */
export function openedAt(openAt: number, elapsed: number): number {
  'worklet';
  if (openAt < 0) return 1;
  const t = Math.min(
    Math.max((elapsed - openAt) / OPENING_KNOBS.OPEN_MS, 0),
    1,
  );
  return t * t * t * (t * (t * 6 - 15) + 10);
}
