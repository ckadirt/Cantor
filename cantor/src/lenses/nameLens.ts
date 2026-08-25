import { PaintStyle } from '@shopify/react-native-skia';
import type { Lens } from './types';

/** KNOBS — pixel measurements match the verified name-lens prototype. */
const NAME_LENS_KNOBS = {
  MARK_RADIUS_PX: 3.2,
  ROW_PREVIEW_OFFSET_PX: 98,
  ROW_TITLE_OFFSET_PX: 42,
  ROW_TITLE_BASELINE_PX: -1,
  ROW_META_BASELINE_PX: 13,
  MAX_TITLE_CHARS: 24,
  // The playing mark keeps its dot and gains a ring, so "which one is playing"
  // is legible at L0 without any mini-player chrome anywhere.
  PLAYING_RING_RADIUS_PX: 7.5,
  PLAYING_RING_WIDTH_PX: 1.2,
} as const;

export const nameLens: Lens = {
  key: 'name',
  label: 'Name',
  draw(canvas, box, song, options) {
    const { alpha, fonts, paints } = options;
    if (alpha <= 0) return;
    if (box.kind === 'mark') {
      paints.ink.setAlphaf(alpha * 0.72);
      canvas.drawCircle(
        box.x,
        box.y,
        NAME_LENS_KNOBS.MARK_RADIUS_PX,
        paints.ink,
      );
      if (song.playing) drawPlayingRing(canvas, box.x, box.y, alpha, paints);
      return;
    }

    paints.ink.setAlphaf(alpha);
    paints.muted.setAlphaf(alpha);
    paints.faint.setAlphaf(alpha);
    canvas.drawCircle(
      box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX,
      box.y,
      NAME_LENS_KNOBS.MARK_RADIUS_PX,
      paints.ink,
    );
    if (song.playing) {
      drawPlayingRing(
        canvas,
        box.x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX,
        box.y,
        alpha,
        paints,
      );
    }
    canvas.drawText(
      truncate(song.title),
      box.x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      box.y + NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
      paints.ink,
      fonts.display,
    );
    canvas.drawText(
      `${formatDuration(song.durationMs)} · ${song.model.toUpperCase()}`,
      box.x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      box.y + NAME_LENS_KNOBS.ROW_META_BASELINE_PX,
      paints.muted,
      fonts.mono,
    );
  },
};

function truncate(value: string): string {
  return value.length > NAME_LENS_KNOBS.MAX_TITLE_CHARS
    ? `${value.slice(0, NAME_LENS_KNOBS.MAX_TITLE_CHARS - 1)}…`
    : value;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The playing indicator: a ring around the mark, drawn at every level.
 *
 * Restores the paint's fill style afterwards — paints are shared across the
 * whole picture, so leaving one stroked would silently outline everything drawn
 * after it.
 */
function drawPlayingRing(
  canvas: Parameters<typeof nameLens.draw>[0],
  x: number,
  y: number,
  alpha: number,
  paints: Parameters<typeof nameLens.draw>[3]['paints'],
): void {
  paints.ink.setAlphaf(alpha);
  paints.ink.setStyle(PaintStyle.Stroke);
  paints.ink.setStrokeWidth(NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX);
  canvas.drawCircle(x, y, NAME_LENS_KNOBS.PLAYING_RING_RADIUS_PX, paints.ink);
  paints.ink.setStyle(PaintStyle.Fill);
}
