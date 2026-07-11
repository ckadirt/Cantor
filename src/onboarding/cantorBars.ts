/**
 * The Cantor mark, as data. 29 rounded bars — the same geometry as the launcher
 * icon (icons/cantor-glyph.svg): a full center bar (iteration 0) that splits
 * outward, top and bottom, into the middle-thirds set (iterations 1–3).
 *
 * Coordinates are the icon's 512 viewBox. `layoutBars()` maps them into a
 * centered square on the canvas and tags each bar with the ranks the intro
 * animation staggers on.
 */

type Rect = { x: number; y: number; w: number; h: number };

const H = 26; // every bar
// [y, width, [x positions...]] per row, center outward
const ROWS: Array<[number, number, number[]]> = [
  [99, 12.44, [88, 112.89, 162.67, 187.56, 312, 336.89, 386.67, 411.56]],
  [147, 37.33, [88, 162.67, 312, 386.67]],
  [195, 112, [88, 312]],
  [243, 336, [88]],
  [291, 112, [88, 312]],
  [339, 37.33, [88, 162.67, 312, 386.67]],
  [387, 12.44, [88, 112.89, 162.67, 187.56, 312, 336.89, 386.67, 411.56]],
];

// Content bounds within the 512 viewBox.
const MIN_X = 88;
const MAX_X = 424; // 88 + 336
const MIN_Y = 99;
const MAX_Y = 413; // 387 + 26
const CONTENT_W = MAX_X - MIN_X;
const CONTENT_H = MAX_Y - MIN_Y;

export type LaidBar = {
  rect: Rect; // canvas pixels
  cx: number;
  cy: number;
  rowRank: number; // 0 at center row, grows outward — drives build stagger
  radial: number; // 0..1 distance of bar centre from mark centre — drives morph stagger
};

/**
 * Fit the mark into a square of side `size` centred at (centreX, centreY) and
 * return every bar in canvas pixels, pre-ranked for the animation.
 */
export function layoutBars(
  size: number,
  centreX: number,
  centreY: number,
): LaidBar[] {
  const scale = size / Math.max(CONTENT_W, CONTENT_H);
  const originX = centreX - (CONTENT_W * scale) / 2;
  const originY = centreY - (CONTENT_H * scale) / 2;

  const bars: LaidBar[] = [];
  ROWS.forEach(([y, w, xs], rowIndex) => {
    const rowRank = Math.abs(rowIndex - 3); // 3 = the full centre bar
    for (const x of xs) {
      const rect: Rect = {
        x: originX + (x - MIN_X) * scale,
        y: originY + (y - MIN_Y) * scale,
        w: w * scale,
        h: H * scale,
      };
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const dx = cx - centreX;
      const dy = cy - centreY;
      const radial = Math.min(1, Math.hypot(dx, dy) / (size / 2));
      bars.push({ rect, cx, cy, rowRank, radial });
    }
  });
  return bars;
}

/** Rounded-rect outline as an SVG path string (for resampling). */
export function barSvg({ x, y, w, h }: Rect): string {
  const r = Math.min(5, h / 2, w / 2);
  return (
    `M ${x + r} ${y} H ${x + w - r} ` +
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} ` +
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} ` +
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} ` +
    `A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
  );
}
