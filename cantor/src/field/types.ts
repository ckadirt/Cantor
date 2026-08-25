/** A position in field world coordinates or screen pixels, depending on use. */
export type Point = Readonly<{
  x: number;
  y: number;
}>;

/** An axis-aligned rectangle whose origin is its top-left corner. */
export type Box = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** The measured usable canvas size in screen pixels. */
export type Viewport = Readonly<{
  width: number;
  height: number;
}>;

/** The world point at screen centre and the scale in pixels per world unit. */
export type Camera = Readonly<{
  x: number;
  y: number;
  scale: number;
}>;

export type Level = 'field' | 'shelf' | 'song' | 'grain';

/**
 * The field's small, runtime-independent view of a completed song or a job.
 * `key` is globally unique: `${nodePublicKey}:${entityId}`.
 */
export type FieldEntity = Readonly<{
  key: string;
  nodePublicKey: string;
  entityId: string;
  kind: 'song' | 'job';
  createdAtMs: number;
  tags: readonly string[];
}>;

/** Membership and display text decided by one arrangement. */
export type ArrangementGroup = Readonly<{
  key: string;
  label: string;
  entityKeys: readonly string[];
}>;

/** An arrangement decides groups only; layout owns all coordinates. */
export type Arrangement = Readonly<{
  key: string;
  label: string;
  group: (entities: readonly FieldEntity[]) => readonly ArrangementGroup[];
}>;

/** A laid-out arrangement group with its world-space centre. */
export type Group = Readonly<{
  key: string;
  label: string;
  entityKeys: readonly string[];
  cx: number;
  cy: number;
}>;

/**
 * One visible copy of an entity. A later arrangement may create several
 * placements for the same entity, but each placement key remains unique.
 */
export type Placement = Readonly<{
  key: string;
  entityKey: string;
  groupKey: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
}>;

/** The complete result of laying one arrangement into a viewport. */
export type FieldLayout = Readonly<{
  groups: readonly Group[];
  placements: readonly Placement[];
  fitScale: number;
  fieldCenter: Point;
  targetBounds: Box | null;
}>;

export type LayoutRequest = Readonly<{
  entities: readonly FieldEntity[];
  arrangement: Arrangement;
  viewport: Viewport;
  previousPlacements?: readonly Placement[];
}>;
