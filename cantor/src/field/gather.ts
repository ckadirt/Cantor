import { mapFrame } from './browse';
import { LAYOUT_KNOBS, placementKey, shelfRowGapWorld } from './layout';
import type { FieldLayout, Group, Placement } from './types';

/**
 * Find as a gather: the songs a query finds leave their groups and stand
 * together in one more group, a shelf called FOUND.
 *
 * Nothing here is a new mode. A re-cut pairs placements by entity
 * (`planPlacementFlights`), so a layout in which the found songs sit in one
 * extra group, and not in their own, makes the camera's ordinary re-cut fly
 * each face from its week to the column — one `carry` per song — and taking
 * the group away flies them home. Hit testing, the queue, the shelf seats and
 * ORDER all read the layout, so they work on the found shelf untold.
 *
 * It is a copy, never a re-pack: a keystroke must not call `layoutField`. The
 * map's groups and seats stay exactly where they were, less the songs that
 * left them.
 */

/** The found shelf's group key. No axis makes a key with a NUL in it. */
export const FOUND_GROUP_KEY = '\u0000found';

/**
 * KNOB — how many faces one gather may fly. Past this they read as confetti;
 * the shelf holds the first ones in field order and its last row says how many
 * more another letter would narrow.
 */
export const MAX_GATHERED = 60;

export type GatherOptions = Readonly<{
  /**
   * The world y the column is centred on: the camera's height when find
   * opened, so the flights are short. Defaults to the field's home.
   */
  centerY?: number;
  /** The shelf's name, for the header and the screen reader. */
  label?: string;
}>;

/**
 * `layout` with the `found` placements moved, in the order given, into a
 * FOUND group of their own.
 *
 * One copy per entity is gathered — the first in `found`, which is field
 * order — and at most `MAX_GATHERED`. On the playlist axis a song's other
 * copies stay in their playlists, so the re-cut pairs them by key and only the
 * gathered copy flies. An empty `found` returns `layout` itself: whether a
 * re-cut runs is decided by object identity first.
 *
 * The column stands one `SHELF_GAP_WORLD` left of the map's frame, so no map
 * shelf is on screen while you stand in it, with the shelf's own row pitch.
 * Its marks have no bloom: at every distance the found songs are a column.
 */
export function gatherLayout(
  layout: FieldLayout,
  found: readonly Placement[],
  options: GatherOptions = {},
): FieldLayout {
  const gathered = firstCopies(layout, found);
  if (gathered.length === 0) return layout;

  const arrangementKey = arrangementKeyOf(gathered[0]);
  const frame = mapFrame(layout);
  const cx =
    (frame === null ? layout.fieldCenter.x : frame.left) -
    LAYOUT_KNOBS.SHELF_GAP_WORLD;
  const cy = options.centerY ?? layout.fieldCenter.y;
  const gap = shelfRowGapWorld(layout.fitScale);
  const firstY = cy - ((gathered.length - 1) * gap) / 2;
  const moved = new Set(gathered.map(placement => placement.key));
  const leftBy = new Map<string, Set<string>>();
  for (const placement of gathered) {
    const left = leftBy.get(placement.groupKey) ?? new Set<string>();
    left.add(placement.entityKey);
    leftBy.set(placement.groupKey, left);
  }

  const groups: Group[] = layout.groups.map(group => {
    const left = leftBy.get(group.key);
    if (left === undefined) return group;
    return {
      ...group,
      entityKeys: group.entityKeys.filter(key => !left.has(key)),
      songCount: Math.max(0, group.songCount - left.size),
    };
  });
  const entityKeys = gathered.map(placement => placement.entityKey);
  groups.push({
    key: FOUND_GROUP_KEY,
    label: options.label ?? 'Found',
    entityKeys,
    cx,
    cy,
    top: firstY,
    topGathered: firstY,
    // Find indexes songs, never jobs.
    songCount: entityKeys.length,
    subtitle: null,
    section: null,
    hub: null,
  });

  const placements: Placement[] = layout.placements.filter(
    placement => !moved.has(placement.key),
  );
  gathered.forEach((placement, index) => {
    const y = firstY + index * gap;
    placements.push({
      key: placementKey(arrangementKey, FOUND_GROUP_KEY, placement.entityKey),
      entityKey: placement.entityKey,
      groupKey: FOUND_GROUP_KEY,
      x: cx,
      y,
      fromX: cx,
      fromY: y,
      targetX: cx,
      targetY: y,
      bloomX: 0,
      bloomY: 0,
      fromBloomX: 0,
      fromBloomY: 0,
      targetBloomX: 0,
      targetBloomY: 0,
    });
  });

  return { ...layout, groups, placements };
}

/** Whether `groupKey` is the found shelf. */
export function isFoundGroup(groupKey: string | null | undefined): boolean {
  return groupKey === FOUND_GROUP_KEY;
}

/** The first copy of each entity in `found`, up to `MAX_GATHERED`, that `layout` draws. */
function firstCopies(
  layout: FieldLayout,
  found: readonly Placement[],
): readonly Placement[] {
  if (found.length === 0) return [];
  const drawn = new Set(layout.placements.map(placement => placement.key));
  const seen = new Set<string>();
  const result: Placement[] = [];
  for (const placement of found) {
    if (result.length >= MAX_GATHERED) break;
    if (seen.has(placement.entityKey) || !drawn.has(placement.key)) continue;
    seen.add(placement.entityKey);
    result.push(placement);
  }
  return result;
}

/** The arrangement a layout placement key was made under (`placementKey`). */
function arrangementKeyOf(placement: Placement): string {
  try {
    const parsed: unknown = JSON.parse(placement.key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch {
    // Not a layout key; the found keys only have to be unique.
  }
  return '';
}
