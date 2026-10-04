import { OVERVIEW_KNOBS } from './bands';
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
   * The side of what a hub cluster shows — an album's cover — in world units:
   * about 60 dp at the map's fit. The cover is the album's face, so it leads
   * and its songs follow under it.
   */
  HUB_SIDE_WORLD: 85,
  /** Between the cover's foot and the middle of its first row of songs. */
  HUB_SONG_GAP_WORLD: 24,
  /** Between two songs in the rows under a cover, centre to centre. */
  HUB_SONG_PITCH_WORLD: 26,
  /**
   * A mark's reach in world units at the map's fit (7.5 px over ~0.73): what
   * the cover's edge has to stay clear of.
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

/** Half the side of what a hub cluster shows, in world units. */
export function hubRadiusWorld(): number {
  'worklet';
  return BROWSE_KNOBS.HUB_SIDE_WORLD / 2;
}

/**
 * A hub cluster: the cover at the top, its songs in rows under it, as many to
 * a row as fit across the cover, each row centred. Read top to bottom and left
 * to right, which is the order they gather into the shelf's column.
 *
 * Rows rather than the particle oval the other axes use, because here the
 * cover is the cluster's face: songs scattered round it at a different angle
 * for every album read as noise beside the one thing that identifies it.
 */
function hubCluster(count: number): BrowseCluster {
  const side = BROWSE_KNOBS.HUB_SIDE_WORLD;
  const pitch = BROWSE_KNOBS.HUB_SONG_PITCH_WORLD;
  const perRow = Math.max(1, Math.floor(side / pitch) + 1);
  const points = Array.from({ length: count }, (_, member) => {
    const row = Math.floor(member / perRow);
    const inRow = Math.min(perRow, count - row * perRow);
    const column = member - row * perRow;
    return {
      x: (column - (inRow - 1) / 2) * pitch,
      y: side + BROWSE_KNOBS.HUB_SONG_GAP_WORLD + row * pitch,
    };
  });
  return { points, hub: { x: 0, y: side / 2 } };
}

/**
 * Stable irregular particles in an oval, planned once per layout. The oval's
 * area is the count's; past `CLUSTER_MAX_RADIUS_X_WORLD` it grows downward. No
 * per-frame noise: refreshes preserve seats and the existing re-cut owns
 * membership transitions.
 *
 * A `hub` cluster has something of its own to show, and is laid out round it
 * instead; see `hubCluster`.
 *
 * Offsets are measured from the top of the packing and the middle of its
 * width, which is where the group's name hangs — the hub's square included.
 */
export function browseCluster(
  count: number,
  groupKey: string,
  hub = false,
): BrowseCluster {
  if (hub) return hubCluster(count);
  if (count <= 0) return { points: [], hub: { x: 0, y: 0 } };
  if (count === 1) {
    return { points: [{ x: 0, y: 0 }], hub: { x: 0, y: 0 } };
  }
  let seed = 0;
  for (let i = 0; i < groupKey.length; i++) {
    seed = (seed * 31 + groupKey.charCodeAt(i)) % 2147483647;
  }
  const phase = ((seed % 360) * Math.PI) / 180;
  const seats = count;
  const pitch = BROWSE_KNOBS.CLUSTER_PITCH_WORLD;
  const round = pitch * Math.sqrt(seats);
  const radiusX = Math.min(BROWSE_KNOBS.CLUSTER_MAX_RADIUS_X_WORLD, round);
  // The same area as the round cluster: what the width gives up, the height takes.
  const radiusY = (round * round) / radiusX;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const points = Array.from({ length: count }, (_, member) => {
    const index = member;
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
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
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
  /** The map's own scale, FIT: the overview is anything below it. */
  fitScale: number;
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
    fitScale: layout.fitScale,
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
 * An axis the content does not fill has nowhere to go. At the map's own scale
 * the honest answer there is home: the camera the field opens on and comes
 * back to. Zoomed out past it, the map is smaller than the band and home would
 * hang it from the band's middle, so the answer is the map's middle instead.
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
  const overview = scale < frame.fitScale;
  const restX = overview ? (minX + maxX) / 2 : frame.homeX;
  const restY = overview ? (minY + maxY) / 2 : frame.homeY;
  return {
    minX: across ? minX : restX,
    maxX: across ? maxX : restX,
    minY: down ? minY : restY,
    maxY: down ? maxY : restY,
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

/**
 * The farthest the map zooms out, as a multiple of FIT: until the whole map
 * stands in the band, and never past `OVERVIEW_KNOBS.MIN_RATIO`. A map that
 * already fits at its own scale has no overview at all.
 */
export function overviewMinRatio(frame: MapFrame, viewport: Viewport): number {
  'worklet';
  // The room above the first names and below the last marks is in screen
  // pixels, as `mapCameraRange` keeps it: what has to shrink into the rest of
  // the band is the map itself.
  const map = frame.bottom - frame.top;
  const band =
    viewport.height -
    BROWSE_KNOBS.TOP_PX -
    BROWSE_KNOBS.FOOT_PX -
    BROWSE_KNOBS.LABEL_SPACE_PX -
    BROWSE_KNOBS.MARK_CLEARANCE_PX;
  if (!(map > 0) || !(band > 0) || !(frame.fitScale > 0)) return 1;
  const whole = band / (map * frame.fitScale);
  return whole >= 1
    ? 1
    : whole < OVERVIEW_KNOBS.MIN_RATIO
    ? OVERVIEW_KNOBS.MIN_RATIO
    : whole;
}
