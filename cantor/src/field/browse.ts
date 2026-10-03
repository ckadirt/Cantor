import type { Camera, FieldLayout, Point, Viewport } from './types';

/** KNOBS — the map is a browsing window, never a fit of the entire library. */
export const BROWSE_KNOBS = {
  COLUMNS: 2,
  VISIBLE_ROWS: 3,
  /**
   * A cluster's size follows its count: a song's share of the oval is a disc
   * this many world units across its radius, so the cluster's radius grows
   * with the square root of what it holds. Two songs are a small pair, not
   * two marks lost in a seat cut for forty.
   */
  CLUSTER_PITCH_WORLD: 13,
  /**
   * Past this half-width a cluster grows downward instead, keeping its share
   * per song: the two columns stay clear of each other however full a week.
   */
  CLUSTER_MAX_RADIUS_X_WORLD: 90,
  ANGLE_VARIATION_RAD: 0.07,
  RADIUS_VARIATION: 0.05,
  COLUMN_WIDTH_WORLD: 240,
  HORIZONTAL_PADDING_PX: 44,
  TOP_PX: 150,
  FOOT_PX: 150,
  LABEL_SPACE_PX: 64,
  GROUP_GAP_PX: 64,
  MARK_CLEARANCE_PX: 12,
  FADE_PX: 12,
  /**
   * Seats left empty at the middle of a cluster that has something to show
   * there — an album's cover. Eight leaves room for a cover about four marks
   * wide.
   */
  HUB_SEATS: 8,
  /**
   * A mark's reach in world units at the map's fit (7.5 px over ~0.73): what
   * the cover's corners have to stay clear of.
   */
  MARK_REACH_WORLD: 11,
} as const;

export function browseScale(viewport: Viewport): number {
  return Math.max(
    0.05,
    (viewport.width - BROWSE_KNOBS.HORIZONTAL_PADDING_PX) /
      (BROWSE_KNOBS.COLUMNS * BROWSE_KNOBS.COLUMN_WIDTH_WORLD),
  );
}

/** One cluster's bloomed seats, and the point its songs are packed around. */
export type BrowseCluster = Readonly<{
  /** Top to bottom, then left to right: seat `i` is row `i` once gathered. */
  points: Point[];
  /** The packing's middle, in the same frame as `points`. */
  hub: Point;
}>;

/**
 * Half the side of what a hub cluster shows in its middle, in world units: a
 * square whose corners clear the nearest song's mark. The nearest song sits
 * at the first seat past the hub, pulled in by the packing's own variation.
 */
export function hubRadiusWorld(): number {
  'worklet';
  const nearest =
    BROWSE_KNOBS.CLUSTER_PITCH_WORLD *
    Math.sqrt(BROWSE_KNOBS.HUB_SEATS + 0.5) *
    (1 - BROWSE_KNOBS.RADIUS_VARIATION);
  return (nearest - BROWSE_KNOBS.MARK_REACH_WORLD) / Math.SQRT2;
}

/**
 * Stable irregular particles in an oval, planned once per layout. The oval's
 * area is the count's; past `CLUSTER_MAX_RADIUS_X_WORLD` it grows downward. No
 * per-frame noise: refreshes preserve seats and the existing re-cut owns
 * membership transitions.
 *
 * `hub` keeps the middle `HUB_SEATS` seats empty, for a cluster whose centre
 * shows something of its own.
 *
 * Offsets are measured from the top of the packing and the middle of its
 * width, which is where the group's name hangs — the hub's square included.
 */
export function browseCluster(
  count: number,
  groupKey: string,
  hub = false,
): BrowseCluster {
  if (count <= 0) return { points: [], hub: { x: 0, y: 0 } };
  const skip = hub ? BROWSE_KNOBS.HUB_SEATS : 0;
  if (count === 1 && skip === 0) {
    return { points: [{ x: 0, y: 0 }], hub: { x: 0, y: 0 } };
  }
  let seed = 0;
  for (let i = 0; i < groupKey.length; i++) {
    seed = (seed * 31 + groupKey.charCodeAt(i)) % 2147483647;
  }
  const phase = ((seed % 360) * Math.PI) / 180;
  const seats = count + skip;
  const pitch = BROWSE_KNOBS.CLUSTER_PITCH_WORLD;
  const round = pitch * Math.sqrt(seats);
  const radiusX = Math.min(BROWSE_KNOBS.CLUSTER_MAX_RADIUS_X_WORLD, round);
  // The same area as the round cluster: what the width gives up, the height takes.
  const radiusY = (round * round) / radiusX;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const points = Array.from({ length: count }, (_, member) => {
    const index = member + skip;
    const angle =
      phase +
      index * goldenAngle +
      Math.sin(index * 7 + phase) * BROWSE_KNOBS.ANGLE_VARIATION_RAD;
    const radius =
      Math.sqrt((index + 0.5) / seats) *
      (1 -
        (BROWSE_KNOBS.RADIUS_VARIATION * (1 + Math.sin(index * 11 + phase))) /
          2);
    return {
      x: Math.cos(angle) * radius * radiusX,
      y: Math.sin(angle) * radius * radiusY,
    };
  });
  // Measured with the hub, so a lone song beside its cover does not claim the
  // middle of the seat for itself, and the name hangs above the cover.
  const reach = hub ? hubRadiusWorld() : 0;
  const xs = [...points.map(point => point.x), ...(hub ? [-reach, reach] : [])];
  const ys = [...points.map(point => point.y), ...(hub ? [-reach, reach] : [])];
  const top = Math.min(...ys);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  // Handed out top to bottom, because the layout gives seat `i` to row `i` of
  // the column the cluster gathers into. In the packing's own order two rows
  // that are neighbours in the list sit a golden angle apart — on opposite
  // sides of the oval — so every mark crossed the cluster to reach its row and
  // a big shelf opened as an explosion. Sorted, the gather keeps everyone's
  // height order and a mark mostly slides down into place; the top of a
  // cluster is also the top of its list.
  const seated = [...points].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  );
  return {
    points: seated.map(point => ({ x: point.x - midX, y: point.y - top })),
    hub: { x: -midX, y: -top },
  };
}

/** The seats alone; see `browseCluster`. */
export function browseOffsets(count: number, groupKey: string): Point[] {
  return browseCluster(count, groupKey).points;
}

export function inBrowseFrame(point: Point, viewport: Viewport): boolean {
  'worklet';
  return (
    point.y >= BROWSE_KNOBS.TOP_PX &&
    point.y <= viewport.height - BROWSE_KNOBS.FOOT_PX
  );
}

/**
 * The map's content and its home, in world units, for the UI thread.
 *
 * The pan at L0 is free — the surface is continuous and a drag may wander off
 * it — but a throw is not a drag: nobody flings the field in order to look at
 * nothing. So a glide needs edges, and the gesture needs them as plain numbers
 * it can read inside its own worklet.
 */
export type MapFrame = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
  homeX: number;
  homeY: number;
}>;

export function mapFrame(layout: FieldLayout): MapFrame | null {
  const box = layout.targetBounds;
  if (box === null) return null;
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    homeX: layout.fieldCenter.x,
    homeY: layout.fieldCenter.y,
  };
}

export type CameraRange = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

/**
 * Where the map camera may come to rest at `scale`, in world units.
 *
 * List semantics, as the shelf has them: at `minY` the first row of clusters
 * hangs its names just under the header, at `maxY` the last row's marks clear
 * the foot — the same two ends `layoutField` writes into `browseBounds`, here
 * at any scale rather than only at FIT. Sideways the content rests a gutter in
 * from each edge.
 *
 * An axis the content does not fill has nowhere to go, and the honest answer
 * there is home: the camera the field opens on and comes back to.
 */
export function mapCameraRange(
  frame: MapFrame,
  viewport: Viewport,
  scale: number,
): CameraRange {
  'worklet';
  const halfWidth = viewport.width / 2 / scale;
  const gutter = BROWSE_KNOBS.HORIZONTAL_PADDING_PX / 2 / scale;
  const minX = frame.left + halfWidth - gutter;
  const maxX = frame.right - halfWidth + gutter;
  const minY =
    frame.top +
    (viewport.height / 2 - BROWSE_KNOBS.TOP_PX - BROWSE_KNOBS.LABEL_SPACE_PX) /
      scale;
  const maxY =
    frame.bottom -
    (viewport.height / 2 -
      BROWSE_KNOBS.FOOT_PX -
      BROWSE_KNOBS.MARK_CLEARANCE_PX) /
      scale;
  const across = minX <= maxX;
  const down = minY <= maxY;
  return {
    minX: across ? minX : frame.homeX,
    maxX: across ? maxX : frame.homeX,
    minY: down ? minY : frame.homeY,
    maxY: down ? maxY : frame.homeY,
  };
}

/**
 * The map camera that has one cluster on screen: where a climb out of a shelf
 * lands.
 *
 * Centred on the cluster's bloom, or — for a cluster taller than the band —
 * with its name just under the header, which is where you read one from. Kept
 * inside the map's range, so a cluster near the top climbs out to the field's
 * own opening view rather than to a camera that shows the header's underside.
 */
export function mapCameraAround(
  layout: FieldLayout,
  groupKey: string,
  viewport: Viewport,
): Camera | null {
  const group = layout.groups.find(candidate => candidate.key === groupKey);
  const frame = mapFrame(layout);
  if (group === undefined || frame === null) return null;
  const scale = layout.fitScale;
  let bottom = group.hub === null ? group.top : group.hub.y + hubRadiusWorld();
  for (const placement of layout.placements) {
    if (placement.groupKey !== groupKey) continue;
    bottom = Math.max(bottom, placement.targetY + placement.targetBloomY);
  }
  const named =
    group.top +
    (viewport.height / 2 - BROWSE_KNOBS.TOP_PX - BROWSE_KNOBS.LABEL_SPACE_PX) /
      scale;
  const range = mapCameraRange(frame, viewport, scale);
  return {
    scale,
    x: Math.min(Math.max(group.cx, range.minX), range.maxX),
    y: Math.min(
      Math.max(Math.min((group.top + bottom) / 2, named), range.minY),
      range.maxY,
    ),
  };
}
