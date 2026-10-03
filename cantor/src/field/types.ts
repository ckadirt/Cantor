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
  /**
   * What an imported file's tags say it belongs to, for the album and artist
   * axes; absent for a generated song, which has neither.
   */
  record?: FieldRecord;
  /**
   * The model a generated song was made by (or a job is being made by), as
   * the node names it — `acestep:1.5-fast`. The artist axis credits it.
   * Absent for an imported song, whose artist is in its record.
   */
  model?: string;
}>;

export type FieldRecord = Readonly<{
  /** The album's own key (`device/resolve.ts`), unique across folders. */
  albumKey: string;
  /** Its title, or its folder's name when the files carry no album tag. */
  album: string;
  artist: string | null;
  /** `disc × 1000 + track`, where the tags give one: an album's own order. */
  track: number | null;
  /**
   * When the song's album arrived: its first file. Copying an album takes
   * seconds, so its files' own times differ; the date order seats by this,
   * then by track, so the album sits as the package it came in. The song's
   * own arrival for an album the tags do not name — a folder of loose files
   * is not a package.
   */
  arrivedMs: number;
}>;

/** Membership and display text decided by one arrangement. */
export type ArrangementGroup = Readonly<{
  key: string;
  label: string;
  entityKeys: readonly string[];
  /**
   * What stands before the count on the name's second line — an album's
   * artist, `Engine` for a model credited as an artist. The count is the
   * layout's to add.
   */
  subtitle?: string;
  /**
   * The part of the field this group belongs to, when the axis has parts —
   * generated and imported on the artist axis. A new section starts a new
   * row under a hairline carrying this word.
   */
  section?: string;
  /** Keep the middle of the cluster empty for what the group shows there. */
  hub?: boolean;
}>;

/** An arrangement decides groups only; layout owns all coordinates. */
export type Arrangement = Readonly<{
  key: string;
  label: string;
  group: (entities: readonly FieldEntity[]) => readonly ArrangementGroup[];
  /**
   * One index word per group, in the order given, for the rail (`rail.ts`):
   * the axis's own way of saying where in it a group is. Optional — without
   * it a group's word is its name's initial, which is right for every axis
   * whose groups are named and sorted by name.
   */
  indexWords?: (
    groups: readonly Pick<ArrangementGroup, 'key' | 'label'>[],
  ) => readonly string[];
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
  /**
   * The same seat once the cluster has closed into its column.
   *
   * A name hangs from the cluster, and the cluster has two poses, so the name
   * has two seats and the gather chooses between them exactly as it does for
   * the marks. Without this the label stays at the bloomed top while its songs
   * gather underneath it and the name drifts away from the column it belongs
   * to — which is what the picture's own settled path always did and its
   * flight path never did.
   */
  topGathered: number;
  /** How many of its members are songs, for the name's second line. */
  songCount: number;
  subtitle: string | null;
  /**
   * The part of the axis this group opens or continues; a group whose section
   * differs from the one before it starts a row under that part's hairline.
   */
  section: string | null;
  /**
   * The world point the bloomed cluster is packed around when the group keeps
   * its middle for something of its own (`ArrangementGroup.hub`); else null.
   */
  hub: Point | null;
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
  /** Home of the browsing window, not the center of the entire library. */
  fieldCenter: Point;
  browseBounds?: Readonly<{ minY: number; maxY: number }>;
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
