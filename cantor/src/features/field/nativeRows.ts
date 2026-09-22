import { flightOwnerAlpha } from './flightOwnerAlpha';
import {
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  gatherFraction,
  type Camera,
  type PlacementFlight,
  type Viewport,
} from '../../field';
import { NAME_LENS_KNOBS } from '../../lenses/nameLens';
import { writePhase, writeSubAlpha } from '../../motion/text';
import { traceTitlePath } from './titleTrace';

/** KNOBS — keep descenders and metadata just outside the viewport available. */
export const ROW_TEXT_OVERSCAN_PX = 64;

export type NativeRowModel = Readonly<{
  action: string | null;
  actionX: number;
  title: string;
  titleTrace: readonly SkPath[] | null;
  titleAlpha: number;
  meta: string;
}>;
export type NativeRowFlight = Readonly<{
  flight: PlacementFlight;
  row: NativeRowModel;
}>;

export function createRowPaints(
  ink: string,
  muted: string,
  strokeWidth: number,
) {
  const title = Skia.Paint();
  title.setAntiAlias(true);
  title.setColor(Skia.Color(ink));
  const trace = title.copy();
  trace.setStyle(PaintStyle.Stroke);
  trace.setStrokeWidth(strokeWidth);
  trace.setStrokeCap(StrokeCap.Round);
  trace.setStrokeJoin(StrokeJoin.Round);
  const meta = Skia.Paint();
  meta.setAntiAlias(true);
  meta.setColor(Skia.Color(muted));
  return { title, trace, meta };
}

/** One UI-thread picture for ordinary rows; the focused player's morph keeps its own owner. */
export function drawNativeRows(
  canvas: SkCanvas,
  rows: readonly NativeRowFlight[],
  progress: number,
  camera: Camera,
  fitScale: number,
  viewport: Viewport,
  written: number,
  fieldAlpha: number,
  fonts: { title: SkFont; mono: SkFont },
  paints: ReturnType<typeof createRowPaints>,
) {
  'worklet';
  if (written <= 0 || fieldAlpha <= 0) return;
  const bloom = 1 - gatherFraction(camera.scale, fitScale);
  for (const { flight, row } of rows) {
    const owner =
      flightOwnerAlpha(
        flight.ownership,
        flight.fromAlpha,
        flight.targetAlpha,
        progress,
      ) * fieldAlpha;
    if (owner <= 0) continue;
    const x =
      (flight.fromX +
        (flight.targetX - flight.fromX) * progress +
        (flight.fromBloomX +
          (flight.targetBloomX - flight.fromBloomX) * progress) *
          bloom -
        camera.x) *
        camera.scale +
      viewport.width / 2;
    const y =
      (flight.fromY +
        (flight.targetY - flight.fromY) * progress +
        (flight.fromBloomY +
          (flight.targetBloomY - flight.fromBloomY) * progress) *
          bloom -
        camera.y) *
        camera.scale +
      viewport.height / 2;
    if (
      y < -ROW_TEXT_OVERSCAN_PX ||
      y > viewport.height + ROW_TEXT_OVERSCAN_PX ||
      x + NAME_LENS_KNOBS.ROW_RIGHT_PX < 0 ||
      x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX > viewport.width
    )
      continue;
    canvas.save();
    canvas.translate(x, y);
    const count = row.titleTrace?.length ?? 0;
    const phase = writePhase(writeSubAlpha(written, count - 1, count));
    if (row.titleTrace !== null && phase.borderAlpha > 0) {
      const path = traceTitlePath(row.titleTrace, written);
      paints.trace.setAlphaf(owner * row.titleAlpha * phase.borderAlpha);
      canvas.drawPath(path, paints.trace);
      path.dispose();
    }
    paints.title.setAlphaf(
      owner *
        row.titleAlpha *
        (row.titleTrace === null ? written : phase.fillAlpha),
    );
    canvas.drawText(
      row.title,
      -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
      paints.title,
      fonts.title,
    );
    if (row.action !== null) {
      paints.meta.setAlphaf(owner * written * NAME_LENS_KNOBS.ROW_ACTION_ALPHA);
      canvas.drawText(
        row.action,
        row.actionX,
        NAME_LENS_KNOBS.ROW_ACTION_BASELINE_PX,
        paints.meta,
        fonts.mono,
      );
    }
    paints.meta.setAlphaf(owner * written);
    canvas.drawText(
      row.meta,
      -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
      NAME_LENS_KNOBS.ROW_META_BASELINE_PX,
      paints.meta,
      fonts.mono,
    );
    canvas.restore();
  }
}
