import type { SongOrder } from './order';

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
  /**
   * How long the song is, in milliseconds; zero for a job, which has no length
   * until it becomes one. Carried here because ordering by duration is a
   * property of where a mark *sits*, and seating is this layer's job.
   */
  durationMs: number;
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
  /**
   * The world y of the cluster's highest bloomed placement — where its name
   * hangs from, which is not the same thing as its centre. A cluster of three
   * and a cluster of twelve share a centre and sit a long way apart at the
   * top, so a label transition expressed in centres travels by that difference
   * even when nothing moved.
   */
  top: number;
}>;

/**
 * One visible copy of an entity. A later arrangement may create several
 * placements for the same entity, but each placement key remains unique.
 */
export type Placement = Readonly<{
  key: string;
  entityKey: string;
  groupKey: string;
  /** The gathered pose: the shared-x column, animated by the relayout tween. */
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  /**
   * The bloomed pose, as a world-unit *offset* from the gathered one. The
   * camera blends between the two — see `bloom.ts`. It carries the same
   * from/target pair as the position so a re-sort moves both poses at once
   * instead of snapping the packing while the column tweens.
   */
  bloomX: number;
  bloomY: number;
  fromBloomX: number;
  fromBloomY: number;
  targetBloomX: number;
  targetBloomY: number;
  /**
   * Draw-time ownership during a re-cut. Settled layout placements omit it and
   * therefore remain fully opaque; transition copies use it to split or fold
   * without painting the same mark twice at either endpoint.
   */
  opacity?: number;
  /**
   * The settled placement this visual copy becomes. Null marks an outgoing,
   * draw-only copy which must never enter hit testing or accessibility.
   */
  targetPlacementKey?: string | null;
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
  /** How members are seated inside their cluster. Defaults to date. */
  order?: SongOrder;
  /** The seed a random order is held at; ignored by every other order. */
  orderSeed?: number;
}>;
