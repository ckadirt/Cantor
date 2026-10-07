import {
  MAX_GATHERED,
  gatherLayout,
  isFoundGroup,
  orderByKey,
  orderMembers,
  shelfRowGapWorld,
  type DateResolution,
  type FieldEntity,
  type FieldLayout,
  type Placement,
  type Viewport,
} from '../../field';
import { findIn, type FindIndex, type FindResult } from '../../library/find';
import { axisNoun } from '../field/FieldOverlay';
import { formatClock } from '../field/NativePlayer';
import { shelfLabel } from '../field/shelfLabels';
import type { FieldPresentation } from '../field/useFieldController';

/**
 * Find's chain for one query, as a function rather than a run of memos:
 * the keystroke calls it before React renders, to send the field its cut at
 * once, and the render calls it after with the same inputs (`FieldScreen`'s
 * `findFor` holds the one result both read).
 */

/** What find is asked: the query, the shelf it is scoped to, where it stands. */
export type FindQuery = Readonly<{
  query: string;
  scopeKey: string | null;
  /** The camera's height on entry: the found column stands there. */
  centerY: number;
}>;

/** Everything else the chain reads; equal worlds give equal answers. */
export type FindWorld = Readonly<{
  mapLayout: FieldLayout | null;
  findIndex: FindIndex;
  fieldEntities: readonly FieldEntity[];
  orderKey: string;
  orderSeed: number;
  viewport: Viewport | null;
  presentations: ReadonlyMap<string, FieldPresentation>;
  nowMs: number;
  arrangementKey: string;
  dateResolution: DateResolution;
}>;

/** The found shelf's songs, seated in its ORDER; see `findChain`. */
export type FoundShelf = Readonly<{
  placements: readonly Placement[];
  /** What the cap left out. */
  more: number;
  /** What the scope left out. */
  outside: number;
  labels: ReadonlyMap<string, string>;
}>;

export type FindChainResult = Readonly<{
  found: FindResult | null;
  shelf: FoundShelf | null;
  /** The map with the found songs standing together; null with no query. */
  gathered: FieldLayout | null;
  /** Every found row's place line, kept since the app opened; see `findChain`. */
  places: ReadonlyMap<string, string> | null;
  /** The found shelf's last row, or null. */
  foot: Readonly<{ text: string; x: number; y: number; widens: boolean }> | null;
}>;

/** Whether two worlds would answer every query alike. */
export function sameFindWorld(a: FindWorld, b: FindWorld): boolean {
  return (
    a.mapLayout === b.mapLayout &&
    a.findIndex === b.findIndex &&
    a.fieldEntities === b.fieldEntities &&
    a.orderKey === b.orderKey &&
    a.orderSeed === b.orderSeed &&
    a.viewport === b.viewport &&
    a.presentations === b.presentations &&
    a.nowMs === b.nowMs &&
    a.arrangementKey === b.arrangementKey &&
    a.dateResolution === b.dateResolution
  );
}

/**
 * What a query finds, and the map gathered around it.
 *
 * - **found**: in field order, inside the filter; the shelf it was entered
 *   from first, with the rest counted as `outside`.
 * - **shelf**: one copy per song, the first `MAX_GATHERED` in field order,
 *   then seated in the shelf's ORDER like any other shelf's.
 * - **gathered**: a copy of the map, never a re-pack (`gatherLayout`).
 * - **places**: a found row's second line, `SEP 21 – 27 · 0:15`. `memory`
 *   is every line made so far, handed back by identity until one changes —
 *   a row leaving the shelf on a letter still says where it came from as it
 *   flies.
 * - **foot**: what the cap left out, or — found inside a shelf — the matches
 *   in the rest of the field, which a tap gathers too.
 */
export function findChain(
  query: FindQuery,
  world: FindWorld,
  memory: ReadonlyMap<string, string>,
): FindChainResult {
  const { mapLayout } = world;
  if (mapLayout === null) {
    return { found: null, shelf: null, gathered: null, places: null, foot: null };
  }
  const found = findIn(
    mapLayout,
    world.findIndex,
    query.query,
    query.scopeKey === null ? null : { groupKey: query.scopeKey },
  );

  const seen = new Set<string>();
  const firsts: Placement[] = [];
  for (const group of found.groups) {
    for (const placement of group.placements) {
      if (seen.has(placement.entityKey)) continue;
      seen.add(placement.entityKey);
      firsts.push(placement);
    }
  }
  const kept = firsts.slice(0, MAX_GATHERED);
  const placementOf = new Map(kept.map(p => [p.entityKey, p]));
  const ordered = orderMembers(
    kept.map(placement => placement.entityKey),
    new Map(world.fieldEntities.map(entity => [entity.key, entity])),
    orderByKey(world.orderKey),
    world.orderSeed,
  );
  const shelf: FoundShelf = {
    placements: ordered.flatMap(key => placementOf.get(key) ?? []),
    more: firsts.length - kept.length,
    outside: found.outside,
    labels: new Map(found.groups.map(group => [group.groupKey, group.label])),
  };

  const gathered =
    query.query.trim().length === 0
      ? null
      : gatherLayout(mapLayout, shelf.placements, {
          centerY: query.centerY,
          viewport: world.viewport ?? undefined,
        });

  let places: ReadonlyMap<string, string> = memory;
  let changed = false;
  const next = new Map(memory);
  for (const placement of shelf.placements) {
    const label = shelf.labels.get(placement.groupKey);
    const durationMs =
      world.presentations.get(placement.entityKey)?.durationMs ?? 0;
    const line = [
      label === undefined
        ? null
        : shelfLabel(label, world.nowMs).primary.toUpperCase(),
      durationMs > 0 ? formatClock(durationMs / 1000) : null,
    ]
      .filter(part => part !== null)
      .join(' · ');
    next.set(placement.entityKey, line);
    if (line !== memory.get(placement.entityKey)) changed = true;
  }
  if (changed) places = next;

  let foot: FindChainResult['foot'] = null;
  if (gathered !== null) {
    const column = gathered.placements.filter(placement =>
      isFoundGroup(placement.groupKey),
    );
    const last = column[column.length - 1];
    const noun = axisNoun(world.arrangementKey, world.dateResolution);
    const text =
      shelf.more > 0
        ? `${shelf.more} MORE · ANOTHER LETTER NARROWS THEM`
        : shelf.outside > 0
        ? `${shelf.outside} MORE IN OTHER ${noun}S`
        : null;
    if (last !== undefined && text !== null) {
      foot = {
        text,
        x: last.x,
        y: last.y + shelfRowGapWorld(gathered.fitScale),
        widens: shelf.more === 0,
      };
    }
  }
  return { found, shelf, gathered, places, foot };
}
