import type { Point, Viewport } from './types';

/** KNOBS — the map is a browsing window, never a fit of the entire library. */
export const BROWSE_KNOBS = {
  COLUMNS: 2,
  VISIBLE_ROWS: 3,
  /** Soft oval container: sparse groups breathe, crowded ones compress. */
  CLUSTER_RADIUS_X_WORLD: 82,
  CLUSTER_MIN_RADIUS_Y_WORLD: 66,
  CLUSTER_HEIGHT_PER_SONG_WORLD: 2.3,
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
} as const;

export function browseScale(viewport: Viewport): number {
  return Math.max(
    0.05,
    (viewport.width - BROWSE_KNOBS.HORIZONTAL_PADDING_PX) /
      (BROWSE_KNOBS.COLUMNS * BROWSE_KNOBS.COLUMN_WIDTH_WORLD),
  );
}

/**
 * Stable irregular particles in an oval, planned once per layout. Membership
 * increases density before the container grows vertically. No per-frame noise:
 * refreshes preserve seats and the existing re-cut owns membership transitions.
 */
export function browseOffsets(count: number, groupKey: string): Point[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  let seed = 0;
  for (let i = 0; i < groupKey.length; i++) {
    seed = (seed * 31 + groupKey.charCodeAt(i)) % 2147483647;
  }
  const phase = ((seed % 360) * Math.PI) / 180;
  const radiusY = Math.max(
    BROWSE_KNOBS.CLUSTER_MIN_RADIUS_Y_WORLD,
    count * BROWSE_KNOBS.CLUSTER_HEIGHT_PER_SONG_WORLD,
  );
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const points = Array.from({ length: count }, (_, index) => {
    const angle =
      phase +
      index * goldenAngle +
      Math.sin(index * 7 + phase) * BROWSE_KNOBS.ANGLE_VARIATION_RAD;
    const radius =
      Math.sqrt((index + 0.5) / count) *
      (1 -
        (BROWSE_KNOBS.RADIUS_VARIATION * (1 + Math.sin(index * 11 + phase))) /
          2);
    return {
      x: Math.cos(angle) * radius * BROWSE_KNOBS.CLUSTER_RADIUS_X_WORLD,
      y: Math.sin(angle) * radius * radiusY,
    };
  });
  const top = Math.min(...points.map(point => point.y));
  const midX =
    (Math.min(...points.map(point => point.x)) +
      Math.max(...points.map(point => point.x))) /
    2;
  return points.map(point => ({ x: point.x - midX, y: point.y - top }));
}

export function inBrowseFrame(point: Point, viewport: Viewport): boolean {
  'worklet';
  return (
    point.y >= BROWSE_KNOBS.TOP_PX &&
    point.y <= viewport.height - BROWSE_KNOBS.FOOT_PX
  );
}
