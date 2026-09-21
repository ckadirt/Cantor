import type { Point, Viewport } from './types';

/** KNOBS — the map is a browsing window, never a fit of the entire library. */
export const BROWSE_KNOBS = {
  COLUMNS: 2,
  VISIBLE_ROWS: 3,
  MARK_COLUMNS: 5,
  MARK_PITCH_WORLD: 34,
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

/** Compact, regular rows of marks; more content adds rows, never compression. */
export function browseOffset(index: number, count: number): Point {
  const columns = Math.min(BROWSE_KNOBS.MARK_COLUMNS, count);
  const row = Math.floor(index / columns);
  const inRow = Math.min(columns, count - row * columns);
  return {
    x: ((index % columns) - (inRow - 1) / 2) * BROWSE_KNOBS.MARK_PITCH_WORLD,
    y: row * BROWSE_KNOBS.MARK_PITCH_WORLD,
  };
}

export function inBrowseFrame(point: Point, viewport: Viewport): boolean {
  'worklet';
  return (
    point.y >= BROWSE_KNOBS.TOP_PX &&
    point.y <= viewport.height - BROWSE_KNOBS.FOOT_PX
  );
}
