import { mapFrame } from './browse';
import { LEVEL_SCALE_RATIOS } from './camera';
import { LAYOUT_KNOBS, placementKey, shelfRowGapWorld } from './layout';
import { FOUND_GROUP_KEY, shelfBoxInterior } from './shelf';
import {
  FLIGHT_NAME,
  type FlightTiming,
  type PlacementFlight,
} from './transition';
import type { FieldLayout, Group, Placement, Viewport } from './types';

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


/**
 * KNOB — how many faces one gather may fly. Past this they read as confetti;
 * the shelf holds the first ones in field order and its last row says how many
 * more another letter would narrow.
 */
export const MAX_GATHERED = 60;

/**
 * KNOBS — the gather's motion, from `find-motion.html` frame III.
 */
export const GATHER_KNOBS = {
  /** One face's flight, out or home. */
  FLIGHT_MS: 550,
  /** Between one face's start and the next's, in shelf order. */
  STAGGER_MS: 40,
  /**
   * The most the stagger may spread a gather over. Forty faces at 40 ms is
   * a cascade longer than the flight; past this the step shrinks instead.
   */
  MAX_STAGGER_SPAN_MS: 600,
  /** The arc out to the column, and the arc home on the chord's other side. */
  BOW_OUT_PX: 70,
  BOW_HOME_PX: -50,
  /** A name writes on over this last part of its own face's flight. */
  NAME_WRITE_FROM: 0.7,
  /** A leaving name erases where it stands, in this long. */
  NAME_ERASE_MS: 150,
  /**
   * The rows that stay close ranks only once the leaving names are gone —
   * the study's fix for names crossing — and take this long to do it.
   */
  CLOSE_RANKS_DELAY_MS: 120,
  CLOSE_RANKS_MS: 420,
  /**
   * The map behind a gather: its ink, its size (it settles back from you,
   * about the middle of the screen), and how long it takes to get there.
   */
  RECEDE_INK: 0.13,
  RECEDE_SCALE: 0.92,
  RECEDE_MS: 500,
  /**
   * The paper laid under each found row, so the ghost of the map passes
   * behind the names rather than through them: its ink, how far left of the
   * face it starts, and its height.
   */
  PAPER_INK: 0.92,
  PAPER_BEHIND_FACE_PX: 24,
  PAPER_HEIGHT_PX: 52,
} as const;

export type GatherOptions = Readonly<{
  /**
   * The world y the column is centred on: the camera's height when find
   * opened, so the flights are short. Defaults to the field's home.
   */
  centerY?: number;
  /** The shelf's name, for the header and the screen reader. */
  label?: string;
  /**
   * The canvas: with it, the column hangs from the shelf box's top with the
   * camera at `centerY`, so the first match is where the eye finds it and
   * the camera stays put while each letter lengthens or shortens the column
   * below it. Without it, the column is centred on `centerY`.
   */
  viewport?: Viewport;
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
  const centerY = options.centerY ?? layout.fieldCenter.y;
  const gap = shelfRowGapWorld(layout.fitScale);
  const span = (gathered.length - 1) * gap;
  // With a viewport the column hangs from the shelf box's top, long or
  // short, so its first row stays where the eye found it as letters change
  // how many rows there are (the study's rows hang from one line).
  const firstY =
    options.viewport === undefined
      ? centerY - span / 2
      : hangingTop(centerY, layout.fitScale, options.viewport);
  const cy = firstY + span / 2;
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

/**
 * Where a column's first row rests at the top of the shelf's box with the
 * camera at `centerY`; no limit without a viewport.
 */
function hangingTop(
  centerY: number,
  fitScale: number,
  viewport: Viewport | undefined,
): number {
  if (viewport === undefined || !(fitScale > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  const scale = fitScale * LEVEL_SCALE_RATIOS.shelf;
  return centerY - (viewport.height / 2 - shelfBoxInterior().top) / scale;
}

/** The entity keys a layout's found shelf holds, in order; empty without one. */
export function foundKeysOf(layout: FieldLayout | null): readonly string[] {
  return (
    layout?.groups.find(group => group.key === FOUND_GROUP_KEY)?.entityKeys ??
    []
  );
}

/** A re-cut's flights with the gather's windows and bows, and its length. */
export type GatherCut = Readonly<{
  flights: readonly PlacementFlight[];
  durationMs: number;
  /** The map's ink at the cut's two ends: 1 whole, `RECEDE_INK` behind. */
  recedeFrom: number;
  recedeTo: number;
  /** When on the cut's linear clock the map has finished receding. */
  recedeEnd: number;
}>;

/**
 * Time a re-cut into, within, or out of a gather; null when neither end has a
 * found shelf, which leaves an ordinary re-cut alone.
 *
 * Faces that arrive fly out on the bow, staggered in the shelf's order, and
 * their names write on as they land. Faces that leave fly home on the other
 * bow, staggered in the order they stood, their names erasing where they
 * stood. Faces that stay close ranks once the leaving names are gone. Every
 * other flight has the whole cut, as in any re-cut.
 */
export function planGatherCut(
  flights: readonly PlacementFlight[],
  before: readonly string[],
  after: readonly string[],
  /**
   * The map's ink at the cut's two ends, when the caller knows better than
   * the found shelves do: a query that found nothing keeps the map receded,
   * and a cut that interrupts a recede starts from where it had got to.
   */
  recede?: Readonly<{ from: number; to: number }>,
): GatherCut | null {
  if (
    before.length === 0 &&
    after.length === 0 &&
    (recede === undefined || (recede.from === 1 && recede.to === 1))
  ) {
    return null;
  }
  const wasFound = new Map(before.map((key, index) => [key, index]));
  const isFound = new Map(after.map((key, index) => [key, index]));
  const arriving = after.filter(key => !wasFound.has(key));
  const leaving = before.filter(key => !isFound.has(key));
  const rankOf = (keys: readonly string[]) =>
    new Map(keys.map((key, index) => [key, index]));
  const arrivalRank = rankOf(arriving);
  const leavingRank = rankOf(leaving);
  const movers = Math.max(arriving.length, leaving.length);
  const step =
    movers <= 1
      ? GATHER_KNOBS.STAGGER_MS
      : Math.min(
          GATHER_KNOBS.STAGGER_MS,
          GATHER_KNOBS.MAX_STAGGER_SPAN_MS / (movers - 1),
        );
  const staying = after.some(key => wasFound.has(key));
  const durationMs = Math.max(
    GATHER_KNOBS.FLIGHT_MS + step * Math.max(0, movers - 1),
    staying ? GATHER_KNOBS.CLOSE_RANKS_DELAY_MS + GATHER_KNOBS.CLOSE_RANKS_MS : 0,
    GATHER_KNOBS.RECEDE_MS,
  );
  const at = (ms: number) => ms / durationMs;
  const windowOf = (
    startMs: number,
    lengthMs: number,
    bowPx: number,
    name: number,
    nameStartMs: number,
    nameEndMs: number,
  ): FlightTiming => ({
    start: at(startMs),
    end: at(startMs + lengthMs),
    bowPx,
    name,
    nameStart: at(nameStartMs),
    nameEnd: at(nameEndMs),
    // Arrivals come from the map; stayers and leavers from the shelf.
    fromFound: name !== FLIGHT_NAME.WRITE,
  });
  const timed = flights.map(flight => {
    const into = flight.groupKey === FOUND_GROUP_KEY;
    const entityKey = flight.entityKey;
    let timing: FlightTiming | undefined;
    if (into && arrivalRank.has(entityKey)) {
      const start = (arrivalRank.get(entityKey) ?? 0) * step;
      const land = start + GATHER_KNOBS.FLIGHT_MS * GATHER_KNOBS.NAME_WRITE_FROM;
      timing = windowOf(
        start,
        GATHER_KNOBS.FLIGHT_MS,
        GATHER_KNOBS.BOW_OUT_PX,
        FLIGHT_NAME.WRITE,
        land,
        start + GATHER_KNOBS.FLIGHT_MS,
      );
    } else if (into) {
      timing = windowOf(
        GATHER_KNOBS.CLOSE_RANKS_DELAY_MS,
        GATHER_KNOBS.CLOSE_RANKS_MS,
        0,
        FLIGHT_NAME.RIDE,
        0,
        0,
      );
    } else if (
      leavingRank.has(entityKey) &&
      flight.targetPlacementKey !== null &&
      // A song's other playlist copies never left; only the one that did.
      (flight.fromX !== flight.targetX || flight.fromY !== flight.targetY)
    ) {
      const start = (leavingRank.get(entityKey) ?? 0) * step;
      timing = windowOf(
        start,
        GATHER_KNOBS.FLIGHT_MS,
        GATHER_KNOBS.BOW_HOME_PX,
        FLIGHT_NAME.ERASE,
        start,
        start + GATHER_KNOBS.NAME_ERASE_MS,
      );
    }
    return timing === undefined ? flight : { ...flight, timing };
  });
  return {
    flights: timed,
    durationMs,
    recedeFrom:
      recede?.from ?? (before.length > 0 ? GATHER_KNOBS.RECEDE_INK : 1),
    recedeTo: recede?.to ?? (after.length > 0 ? GATHER_KNOBS.RECEDE_INK : 1),
    recedeEnd: Math.min(1, at(GATHER_KNOBS.RECEDE_MS)),
  };
}

/** Whether `groupKey` is the found shelf. */
export function isFoundGroup(groupKey: string | null | undefined): boolean {
  'worklet';
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
