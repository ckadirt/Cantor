import { fit, type FitOptions } from './camera';
import { boxCenter, boxFromPoints } from './geometry';
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
  SONG_GAP_WORLD: 26,
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
  minimumContentWidthWorld: LAYOUT_KNOBS.SONG_GAP_WORLD,
  minimumContentHeightWorld: LAYOUT_KNOBS.SONG_GAP_WORLD,
  horizontalContentMarginWorld: LAYOUT_KNOBS.HORIZONTAL_CONTENT_MARGIN_WORLD,
  verticalContentMarginWorld: LAYOUT_KNOBS.VERTICAL_CONTENT_MARGIN_WORLD,
  minScale: LAYOUT_KNOBS.MIN_FIT_SCALE,
  maxScale: LAYOUT_KNOBS.MAX_FIT_SCALE,
  emptyScale: LAYOUT_KNOBS.EMPTY_FIT_SCALE,
};

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
  const verticalMidpoint =
    ((rowCount - 1) * LAYOUT_KNOBS.CLUSTER_ROW_GAP_WORLD) / 2;
  const groups: Group[] = [];
  const placements: Placement[] = [];
  const placementKeys = new Set<string>();

  definitions.forEach((definition, groupIndex) => {
    if (groups.some(group => group.key === definition.key)) {
      throw new Error(`Arrangement group key is duplicated: ${definition.key}`);
    }
    const column = groupIndex % columns;
    const row = Math.floor(groupIndex / columns);
    const groupsInRow = Math.min(columns, definitions.length - row * columns);
    const cx = (column - (groupsInRow - 1) / 2) * LAYOUT_KNOBS.SHELF_GAP_WORLD;
    const cy = row * LAYOUT_KNOBS.CLUSTER_ROW_GAP_WORLD - verticalMidpoint;
    const entityKeys = [...definition.entityKeys];
    const group: Group = {
      key: definition.key,
      label: definition.label,
      entityKeys,
      cx,
      cy,
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
      const targetY =
        cy +
        (entityIndex - (entityKeys.length - 1) / 2) *
          LAYOUT_KNOBS.SONG_GAP_WORLD;
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
        fromX: previous?.x ?? targetX,
        fromY: previous?.y ?? targetY,
        targetX,
        targetY,
      });
    });
  });

  const targetBounds = placementBounds(placements);
  return {
    groups,
    placements,
    fitScale: fit(targetBounds, request.viewport, FIT_OPTIONS),
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

function firstPreviousPlacementByEntity(
  placements: readonly Placement[],
): ReadonlyMap<string, Point> {
  const result = new Map<string, Point>();
  for (const placement of [...placements].sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    if (!result.has(placement.entityKey)) {
      result.set(placement.entityKey, { x: placement.x, y: placement.y });
    }
  }
  return result;
}

function placementBounds(placements: readonly Placement[]): Box | null {
  return boxFromPoints(
    placements.map(placement => ({
      x: placement.targetX,
      y: placement.targetY,
    })),
  );
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
