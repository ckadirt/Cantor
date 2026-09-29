import {
  BROWSE_KNOBS,
  browseCluster,
  browseScale,
  hubRadiusWorld,
} from './browse';
import { LEVEL_SCALE_RATIOS } from './camera';
import { boxFromPoints } from './geometry';
import { orderByKey, orderMembers, DEFAULT_ORDER_KEY } from './order';
import type {
  Box,
  FieldEntity,
  FieldLayout,
  Group,
  LayoutRequest,
  Placement,
  Point,
  Viewport,
} from './types';

/** Gathered shelf dimensions; map browsing dimensions live in browse.ts. */
export const LAYOUT_KNOBS = {
  SHELF_GAP_WORLD: 300,
  BLOOM_GAP_WORLD: 26,
  SHELF_ROW_PITCH_PX: 92,
  HORIZONTAL_SAFE_PADDING_PX: 44,
  VERTICAL_SAFE_PADDING_PX: 150,
  EMPTY_FIT_SCALE: 0.9,
  /**
   * Extra room above the first row of a section, in screen pixels, for the
   * hairline and the word that name it (drawn by the canvas above the row's
   * names).
   */
  SECTION_GAP_PX: 34,
} as const;

/** Keep gathered song rows 92 screen pixels apart at shelf distance. */
export function shelfRowGapWorld(fitScale: number): number {
  if (!Number.isFinite(fitScale) || fitScale <= 0) {
    return LAYOUT_KNOBS.BLOOM_GAP_WORLD;
  }
  return (
    LAYOUT_KNOBS.SHELF_ROW_PITCH_PX / (fitScale * LEVEL_SCALE_RATIOS.shelf)
  );
}

/** Where one member sits along its cluster's vertical run, at a given pitch. */
function rankOffset(index: number, count: number, gap: number): number {
  return (index - (count - 1) / 2) * gap;
}

/** Lay arrangement membership out without depending on a renderer or runtime. */
export function layoutField(request: LayoutRequest): FieldLayout {
  assertViewport(request.viewport);
  const entitiesByKey = mapEntities(request.entities);
  const grouped = request.arrangement.group(request.entities);
  // Date's newest groups are the browsing entry; playlist order stays authored.
  const definitions =
    request.arrangement.key === 'time' ? [...grouped].reverse() : grouped;
  const previousByEntity = firstPreviousPlacementByEntity(
    request.previousPlacements ?? [],
  );
  const columns = gridColumnCount(definitions.length);
  // A row holds `columns` groups, and a new section always starts a new row,
  // so the hairline between two sections never cuts a row in half.
  const rows: number[][] = [];
  definitions.forEach((definition, index) => {
    const last = rows[rows.length - 1];
    if (
      last === undefined ||
      last.length >= columns ||
      definitions[last[0]].section !== definition.section
    ) {
      rows.push([index]);
    } else {
      last.push(index);
    }
  });
  const rowCount = rows.length;

  // Compact map seats and gathered shelf seats have independent footprints.
  const seats = definitions.map((definition, groupIndex) => {
    if (
      definitions.some(
        (other, index) => index < groupIndex && other.key === definition.key,
      )
    ) {
      throw new Error(`Arrangement group key is duplicated: ${definition.key}`);
    }
    // Seating order is the layout's, not the arrangement's: the same three
    // orders apply to every axis, and applying them here is what stops
    // `byPlaylist` from seating its members in whatever order their tags
    // happened to produce.
    const entityKeys = orderMembers(
      definition.entityKeys,
      entitiesByKey,
      request.order ?? orderByKey(DEFAULT_ORDER_KEY),
      request.orderSeed ?? 0,
    );
    const cluster = browseCluster(
      entityKeys.length,
      definition.key,
      definition.hub === true,
    );
    return {
      definition,
      cx: 0,
      cy: 0,
      entityKeys,
      blooms: cluster.points.map(point => ({ ...point })),
      hub: definition.hub === true ? { ...cluster.hub } : null,
    };
  });

  const fitScale =
    definitions.length === 0
      ? LAYOUT_KNOBS.EMPTY_FIT_SCALE
      : browseScale(request.viewport);
  const contentGap = BROWSE_KNOBS.GROUP_GAP_PX / fitScale;
  const sectionGap = LAYOUT_KNOBS.SECTION_GAP_PX / fitScale;
  const bandTop =
    (BROWSE_KNOBS.TOP_PX - request.viewport.height / 2) / fitScale;
  const bandBottom =
    (request.viewport.height / 2 - BROWSE_KNOBS.FOOT_PX) / fitScale;
  const labelSpace = BROWSE_KNOBS.LABEL_SPACE_PX / fitScale;
  // Rows are as tall as what they hold: a row of pairs is a short row.
  let rowTop = bandTop + labelSpace;
  let bottom = rowTop;
  rows.forEach((members, row) => {
    const section = definitions[members[0]].section;
    const opens =
      section !== undefined &&
      (row === 0 || definitions[rows[row - 1][0]].section !== section);
    if (opens) rowTop += sectionGap;
    let height = 0;
    members.forEach((seatIndex, column) => {
      const seat = seats[seatIndex];
      const ownHeight = Math.max(
        0,
        ...seat.blooms.map(point => point.y),
        seat.hub === null ? 0 : seat.hub.y + hubRadiusWorld(),
      );
      const cx =
        (column - (members.length - 1) / 2) * BROWSE_KNOBS.COLUMN_WIDTH_WORLD;
      seat.blooms.forEach(point => {
        point.x += cx;
        point.y += rowTop;
      });
      if (seat.hub !== null) {
        seat.hub.x += cx;
        seat.hub.y += rowTop;
      }
      seat.cx = cx;
      seat.cy = rowTop + ownHeight / 2;
      height = Math.max(height, ownHeight);
    });
    bottom = rowTop + height;
    rowTop += height + contentGap;
  });
  // A field shorter than the band stands in its middle, not at its top: the
  // room left over is shared above and below instead of pooling at the foot.
  const contentTop = bandTop;
  const spare = bandBottom - contentTop - (bottom - contentTop);
  const shift = rowCount > 0 && spare > 0 ? spare / 2 : 0;
  if (shift > 0) {
    for (const seat of seats) {
      seat.cy += shift;
      seat.blooms.forEach(point => {
        point.y += shift;
      });
      if (seat.hub !== null) seat.hub.y += shift;
    }
  }
  const targetBounds = boxFromPoints(seats.flatMap(seat => seat.blooms));
  const songGapWorld = shelfRowGapWorld(fitScale);
  // Shelves have a different footprint from their blooms. Pack their centers
  // independently after FIT: feeding the 92 px row pitch back into FIT would
  // create a shrinking-frame / growing-column cycle. The bloom offsets below
  // retain the map seats while each gathered column gets its own clear run.
  const shelfHalfHeights = rows.map(members =>
    Math.max(
      0,
      ...members.map(
        seatIndex =>
          (Math.max(0, seats[seatIndex].entityKeys.length - 1) * songGapWorld) /
          2,
      ),
    ),
  );
  const shelfCenters: number[] = [];
  shelfHalfHeights.forEach((halfHeight, row) => {
    const mapCy = seats[rows[row][0]].cy;
    shelfCenters.push(
      row === 0
        ? mapCy
        : Math.max(
            mapCy,
            shelfCenters[row - 1] +
              shelfHalfHeights[row - 1] +
              halfHeight +
              songGapWorld,
          ),
    );
  });
  rows.forEach((members, row) => {
    for (const seatIndex of members) seats[seatIndex].cy = shelfCenters[row];
  });

  const groups: Group[] = [];
  const placements: Placement[] = [];
  const placementKeys = new Set<string>();

  seats.forEach(({ definition, cx, cy, entityKeys, blooms, hub }) => {
    // Both seats, because the name hangs from the cluster and the cluster has
    // two poses: the top of the bloomed packing, and the top of the column it
    // gathers into. The camera blends them the same way it blends the marks.
    const columnTops = entityKeys.map(
      (_entityKey, entityIndex) =>
        cy + rankOffset(entityIndex, entityKeys.length, songGapWorld),
    );
    const group: Group = {
      key: definition.key,
      label: definition.label,
      entityKeys,
      cx,
      cy,
      top:
        blooms.length === 0 && hub === null
          ? cy
          : Math.min(
              ...blooms.map(seat => seat.y),
              ...(hub === null ? [] : [hub.y - hubRadiusWorld()]),
            ),
      topGathered: columnTops.length === 0 ? cy : Math.min(...columnTops),
      songCount: entityKeys.filter(
        entityKey => entitiesByKey.get(entityKey)?.kind === 'song',
      ).length,
      subtitle: definition.subtitle ?? null,
      section: definition.section ?? null,
      hub,
    };
    groups.push(group);

    entityKeys.forEach((entityKey, entityIndex) => {
      const entity = entitiesByKey.get(entityKey);
      if (entity === undefined) {
        throw new Error(
          `Arrangement group ${definition.key} references unknown entity ${entityKey}.`,
        );
      }
      const targetX = cx;
      const targetY = columnTops[entityIndex];
      // The other pose, as the offset that carries the column seat to it. It is
      // stored as a difference rather than as a point because that is what the
      // gather interpolates: `placementPoint` walks the offset back to zero as
      // the cluster closes, so the bloom has to be measured *from* the column.
      const bloom = {
        x: blooms[entityIndex].x - targetX,
        y: blooms[entityIndex].y - targetY,
      };
      const key = placementKey(
        request.arrangement.key,
        definition.key,
        entity.key,
      );
      if (placementKeys.has(key)) {
        throw new Error(`Placement key is duplicated: ${key}`);
      }
      placementKeys.add(key);
      const previous = previousByEntity.get(entity.key);
      placements.push({
        key,
        entityKey: entity.key,
        groupKey: definition.key,
        x: targetX,
        y: targetY,
        fromX: previous?.point.x ?? targetX,
        fromY: previous?.point.y ?? targetY,
        targetX,
        targetY,
        bloomX: bloom.x,
        bloomY: bloom.y,
        fromBloomX: previous?.bloom.x ?? bloom.x,
        fromBloomY: previous?.bloom.y ?? bloom.y,
        targetBloomX: bloom.x,
        targetBloomY: bloom.y,
      });
    });
  });

  return {
    groups,
    placements,
    fitScale,
    fieldCenter: { x: 0, y: 0 },
    browseBounds: {
      minY: 0,
      maxY:
        targetBounds === null
          ? 0
          : Math.max(
              0,
              targetBounds.y +
                targetBounds.height -
                (request.viewport.height / 2 -
                  BROWSE_KNOBS.FOOT_PX -
                  BROWSE_KNOBS.MARK_CLEARANCE_PX) /
                  fitScale,
            ),
    },
    targetBounds,
  };
}

/** The screen-space frame that FIT keeps target placements inside. */
export function safeViewportBox(viewport: Viewport): Box {
  assertViewport(viewport);
  return {
    x: LAYOUT_KNOBS.HORIZONTAL_SAFE_PADDING_PX / 2,
    y: LAYOUT_KNOBS.VERTICAL_SAFE_PADDING_PX / 2,
    width: viewport.width - LAYOUT_KNOBS.HORIZONTAL_SAFE_PADDING_PX,
    height: viewport.height - LAYOUT_KNOBS.VERTICAL_SAFE_PADDING_PX,
  };
}

export function gridColumnCount(groupCount: number): number {
  return Math.min(BROWSE_KNOBS.COLUMNS, groupCount);
}

/** A stable and unambiguous key even when user-facing keys contain punctuation. */
export function placementKey(
  arrangementKey: string,
  groupKey: string,
  entityKey: string,
): string {
  return JSON.stringify([arrangementKey, groupKey, entityKey]);
}

function mapEntities(
  entities: readonly FieldEntity[],
): ReadonlyMap<string, FieldEntity> {
  const result = new Map<string, FieldEntity>();
  for (const entity of entities) {
    if (result.has(entity.key)) {
      throw new Error(`Field entity key is duplicated: ${entity.key}`);
    }
    result.set(entity.key, entity);
  }
  return result;
}

/** Both poses of a placement, as the relayout tween has them right now. */
type Pose = Readonly<{ point: Point; bloom: Point }>;

function firstPreviousPlacementByEntity(
  placements: readonly Placement[],
): ReadonlyMap<string, Pose> {
  const result = new Map<string, Pose>();
  for (const placement of [...placements].sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    if (!result.has(placement.entityKey)) {
      result.set(placement.entityKey, {
        point: { x: placement.x, y: placement.y },
        bloom: { x: placement.bloomX, y: placement.bloomY },
      });
    }
  }
  return result;
}

function assertViewport(viewport: Viewport): void {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new RangeError(
      'Viewport dimensions must be finite positive numbers.',
    );
  }
}
