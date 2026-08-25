import type { Lens } from './types';

/** KNOBS — pixel measurements match the verified name-lens prototype. */
const NAME_LENS_KNOBS = {
  MARK_RADIUS_PX: 3.2,
  ROW_PREVIEW_OFFSET_PX: 98,
  ROW_TITLE_OFFSET_PX: 42,
  ROW_TITLE_BASELINE_PX: -1,
  ROW_META_BASELINE_PX: 13,
  MAX_TITLE_CHARS: 24,
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
