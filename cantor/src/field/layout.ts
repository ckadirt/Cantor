import { bloomOffset } from './bloom';
import { LEVEL_SCALE_RATIOS, fit, type FitOptions } from './camera';
import { boxCenter, boxFromPoints } from './geometry';
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

/**
 * KNOBS — dimensions in world units and safe-frame dimensions in screen pixels.
 * These values are ported directly from the verified interface prototype.
 */
export const LAYOUT_KNOBS = {
  SHELF_GAP_WORLD: 300,
  CLUSTER_ROW_GAP_WORLD: 300,
  /** Minimum air between adjacent rows of bloomed groups, including labels. */
  CLUSTER_CONTENT_GAP_WORLD: 150,
  /** Label (32 px offset), mark/job radius, and clear air at map distance. */
  CLUSTER_CONTENT_GAP_PX: 64,
  /** Space for date labels and marks in neighboring map columns. */
  CLUSTER_COLUMN_PITCH_PX: 160,
  PACKING_PASSES: 64,
  /**
   * The rank spacing of the *bloomed* pose, in world units: how far apart two
   * successive members are before the spiral displaces them.
   *
   * A world number, and it stays one, because the bloom is a shape on a map —
   * it is framed by FIT rather than read at a fixed size, and it is what FIT is
   * measured from. The gathered column is the opposite kind of thing and gets
   * `shelfRowGapWorld` instead.
   */
  BLOOM_GAP_WORLD: 26,
  /**
   * The pitch of the gathered column at L1, in **screen pixels**.
   *
   * A list is a list: two songs are one row apart because that is how far apart
   * rows go, not because of how the rest of the library happens to be shaped.
   * Before this, the column was a world constant and the pitch was whatever
   * `fitScale × LEVEL_SCALE_RATIOS.shelf` made of it — measured at 92 px for a
   * month of a small library, 204 px for the same songs cut by year, and 27 px
   * for a year of work at week resolution. The last of those is *under* the
   * renderer's own 30 px row box: rows drawn on top of each other.
   *
   * 92 is the pitch a small library's week and month shelves already had, which
   * is the one value in that range that had been read and kept. Three times the
   * row box, so a title and its metadata sit in the middle of their own air.
   */
  SHELF_ROW_PITCH_PX: 92,
  GRID_COLUMN_DENSITY: 0.62,
  HORIZONTAL_SAFE_PADDING_PX: 44,
  VERTICAL_SAFE_PADDING_PX: 150,
  HORIZONTAL_CONTENT_MARGIN_WORLD: 165,
  VERTICAL_CONTENT_MARGIN_WORLD: 130,
  MIN_FIT_SCALE: 0.05,
  MAX_FIT_SCALE: 4,
  EMPTY_FIT_SCALE: 0.9,
} as const;

const FIT_OPTIONS: FitOptions = {
  horizontalSafePaddingPx: LAYOUT_KNOBS.HORIZONTAL_SAFE_PADDING_PX,
  verticalSafePaddingPx: LAYOUT_KNOBS.VERTICAL_SAFE_PADDING_PX,
  minimumContentWidthWorld: LAYOUT_KNOBS.BLOOM_GAP_WORLD,
  minimumContentHeightWorld: LAYOUT_KNOBS.BLOOM_GAP_WORLD,
  horizontalContentMarginWorld: LAYOUT_KNOBS.HORIZONTAL_CONTENT_MARGIN_WORLD,
  verticalContentMarginWorld: LAYOUT_KNOBS.VERTICAL_CONTENT_MARGIN_WORLD,
  minScale: LAYOUT_KNOBS.MIN_FIT_SCALE,
  maxScale: LAYOUT_KNOBS.MAX_FIT_SCALE,
  emptyScale: LAYOUT_KNOBS.EMPTY_FIT_SCALE,
};

/**
 * The gathered column's pitch, in world units, for a field fitted at `fitScale`.
 *
 * The inverse of the reason the pitch used to wander. A column is read at L1,
 * which is `LEVEL_SCALE_RATIOS.shelf` times FIT, so a world gap `g` puts its
 * rows `g · fitScale · 5` pixels apart — a number that depended on how many
 * clusters the axis happened to cut and how wide they spread. Solving that for
 * the pitch a row actually wants gives the gap the column should have, and the
 * dependency runs the other way for good: the shelf is a list and reads like
 * one, whatever the map around it looks like.
 *
 * Only the *gathered* pose is measured this way. The bloom stays in world units
 * — it is a shape FIT has to frame, and a bloom that answered to FIT would be a
 * definition that consumed itself.
 */
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
  const definitions = request.arrangement.group(request.entities);
  const previousByEntity = firstPreviousPlacementByEntity(
    request.previousPlacements ?? [],
  );
  const columns = gridColumnCount(definitions.length);
  const rowCount = columns === 0 ? 0 : Math.ceil(definitions.length / columns);

  /*
   * The bloom first, then FIT, then the column.
   *
   * That order is the whole of this function's shape. FIT is measured from the
   * bloomed pose, and the gathered column is now measured from FIT, so the
   * three cannot be computed in one pass without the column feeding back into
   * the frame that sizes it — and that loop diverges rather than settling: a
   * wider column makes a smaller FIT, which `shelfRowGapWorld` answers with a
   * wider column. Bloom shapes use constants; their centers are packed for
   * map label clearance before the independent gathered shelves are measured.
   */
  const seats = definitions.map((definition, groupIndex) => {
    if (
      definitions.some(
        (other, index) => index < groupIndex && other.key === definition.key,
      )
    ) {
      throw new Error(`Arrangement group key is duplicated: ${definition.key}`);
    }
    const column = groupIndex % columns;
    const row = Math.floor(groupIndex / columns);
    const groupsInRow = Math.min(columns, definitions.length - row * columns);
    const cx = (column - (groupsInRow - 1) / 2) * LAYOUT_KNOBS.SHELF_GAP_WORLD;
    const cy = 0;
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
    // The bloomed seats, absolute: rank spacing plus the spiral that displaces
    // it. Nothing here reads FIT, which is what makes FIT computable.
    const blooms = entityKeys.map((_entityKey, entityIndex) => {
      const spiral = bloomOffset(entityIndex, entityKeys.length);
      return {
        x: cx + spiral.x,
        y:
          cy +
          rankOffset(
            entityIndex,
            entityKeys.length,
            LAYOUT_KNOBS.BLOOM_GAP_WORLD,
          ) +
          spiral.y,
      };
    });
    return { definition, cx, cy, entityKeys, blooms };
  });

  // Measure complete blooms, not just their capped spiral: the rank run
  // continues growing with membership. Reserve the tallest group in each row.
  const rowExtents = Array.from({ length: rowCount }, (_, row) => {
    const points = seats
      .slice(row * columns, (row + 1) * columns)
      .flatMap(seat => seat.blooms);
    return {
      top: Math.min(0, ...points.map(point => point.y)),
      bottom: Math.max(0, ...points.map(point => point.y)),
    };
  });
  let contentGap = LAYOUT_KNOBS.CLUSTER_CONTENT_GAP_WORLD as number;
  let columnPitch = LAYOUT_KNOBS.SHELF_GAP_WORLD as number;
  let targetBounds: Box | null = null;
  let fitScale: number = LAYOUT_KNOBS.EMPTY_FIT_SCALE;
  // Labels and marks retain screen size as FIT shrinks. Repack with their
  // screen clearance too; measuring world extents alone still overlaps labels
  // in a library with several dense weeks. This only translates whole blooms.
  for (let pass = 0; pass < LAYOUT_KNOBS.PACKING_PASSES; pass++) {
    const rowCenters: number[] = [];
    rowExtents.forEach((extent, row) => {
      rowCenters.push(
        row === 0
          ? 0
          : rowCenters[row - 1] +
              Math.max(
                LAYOUT_KNOBS.CLUSTER_ROW_GAP_WORLD,
                rowExtents[row - 1].bottom - extent.top + contentGap,
              ),
      );
    });
    const midpoint = (rowCenters[rowCount - 1] ?? 0) / 2;
    seats.forEach((seat, index) => {
      const row = Math.floor(index / columns);
      const groupsInRow = Math.min(columns, definitions.length - row * columns);
      const cx = ((index % columns) - (groupsInRow - 1) / 2) * columnPitch;
      seat.blooms.forEach(point => {
        point.x += cx - seat.cx;
      });
      seat.cx = cx;
      const cy = rowCenters[row] - midpoint;
      seat.blooms.forEach(point => {
        point.y += cy - seat.cy;
      });
      seat.cy = cy;
    });
    targetBounds = boxFromPoints(seats.flatMap(seat => seat.blooms));
    fitScale = fit(targetBounds, request.viewport, FIT_OPTIONS);
    const requiredGap = LAYOUT_KNOBS.CLUSTER_CONTENT_GAP_PX / fitScale;
    const requiredPitch = LAYOUT_KNOBS.CLUSTER_COLUMN_PITCH_PX / fitScale;
    if (contentGap >= requiredGap - 1e-6 && columnPitch >= requiredPitch - 1e-6)
      break;
    contentGap = Math.max(contentGap, requiredGap);
    columnPitch = Math.max(columnPitch, requiredPitch);
  }
  const songGapWorld = shelfRowGapWorld(fitScale);
  // Shelves have a different footprint from their blooms. Pack their centers
  // independently after FIT: feeding the 92 px row pitch back into FIT would
  // create a shrinking-frame / growing-column cycle. The bloom offsets below
  // retain the map seats while each gathered column gets its own clear run.
  const shelfHalfHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(
      0,
      ...seats
        .slice(row * columns, (row + 1) * columns)
        .map(
          seat => (Math.max(0, seat.entityKeys.length - 1) * songGapWorld) / 2,
        ),
    ),
  );
  const shelfCenters: number[] = [];
  shelfHalfHeights.forEach((halfHeight, row) => {
    const mapCy = seats[row * columns].cy;
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
  seats.forEach((seat, index) => {
    seat.cy = shelfCenters[Math.floor(index / columns)];
  });

  const groups: Group[] = [];
  const placements: Placement[] = [];
  const placementKeys = new Set<string>();

  seats.forEach(({ definition, cx, cy, entityKeys, blooms }) => {
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
      top: blooms.length === 0 ? cy : Math.min(...blooms.map(seat => seat.y)),
      topGathered: columnTops.length === 0 ? cy : Math.min(...columnTops),
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
    fieldCenter:
      targetBounds === null ? { x: 0, y: 0 } : boxCenter(targetBounds),
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
  if (groupCount === 0) return 0;
  return Math.min(
    Math.max(
      2,
      Math.round(Math.sqrt(groupCount * LAYOUT_KNOBS.GRID_COLUMN_DENSITY)),
    ),
    groupCount,
  );
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
