import { openedAt } from './opening';
import { flightOwnerAlpha } from './flightOwnerAlpha';
import {
  gatherFaceInk,
  gatherNameAt,
  type Recede,
} from './gatherInk';
import {
  ClipOp,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  FLIGHT_NAME,
  bowOffsetAt,
  flightProgressAt,
  gatherFraction,
  isFoundGroup,
  linearOfEased,
  type Camera,
  type PlacementFlight,
  type Viewport,
} from '../../field';
import { NAME_LENS_KNOBS } from '../../lenses/nameLens';
import { writePhase, writeSubAlpha } from '../../motion/text';
import { traceTitlePath } from './titleTrace';

/** KNOBS — keep descenders and metadata just outside the viewport available. */
export const ROW_TEXT_OVERSCAN_PX = 64;

/**
 * KNOB — how far right of the title's start a gathered name's write-on runs,
 * in pixels: the row's whole reach, so the clip has passed the name's last
 * letter as it closes.
 */
export const GATHER_NAME_REACH_PX = 300;

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
  /**
   * The title's alpha when its ink last changed, reached by the arrival
   * clock; absent when nothing is arriving. See `arriveInk`.
   */
  titleFrom?: number;
  /** When the song opens, on the opening clock; absent when it is not arriving. */
  openAt?: number;
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
  /**
   * The row the player is drawing this frame, if any: see `owned` in
   * `useNativeCameraMotion`. Skipped here so one owner draws it.
   */
  yieldKey: string | null = null,
  /** The ink arrival's clock; see `arriveInk`. */
  arrival = 1,
  /** The opening clock, elapsed ms; see `features/field/opening.ts`. */
  openingMs = Infinity,
  /** The map behind find's gather; null in any other re-cut. */
  recede: Recede | null = null,
) {
  'worklet';
  if (written <= 0 || fieldAlpha <= 0) return;
  const bloom = 1 - gatherFraction(camera.scale, fitScale);
  const linear = recede === null ? progress : linearOfEased(progress);
  for (const { flight, row, titleFrom, openAt } of rows) {
    if (yieldKey !== null && flight.targetPlacementKey === yieldKey) continue;
    // In a gather a name has its face's window: it writes on at the seat
    // its face is landing in, erases where it stood, or rides along.
    const timing = flight.timing;
    const u = timing === undefined ? progress : flightProgressAt(timing, linear);
    const at =
      timing === undefined
        ? progress
        : timing.name === FLIGHT_NAME.WRITE
        ? 1
        : timing.name === FLIGHT_NAME.ERASE
        ? 0
        : u;
    const named = gatherNameAt(timing, linear);
    const owner =
      flightOwnerAlpha(
        flight.ownership,
        flight.fromAlpha,
        flight.targetAlpha,
        u,
      ) *
      fieldAlpha *
      gatherFaceInk(recede, linear, timing, isFoundGroup(flight.groupKey), u) *
      // A name arrives with its mark: nothing is written before it opens.
      openedAt(openAt ?? -1, openingMs);
    if (owner <= 0 || named <= 0) continue;
    const bow =
      timing === undefined || timing.bowPx === 0 || at !== u
        ? null
        : bowOffsetAt(
            flight.targetX - flight.fromX,
            flight.targetY - flight.fromY,
            timing.bowPx,
            u,
          );
    const x =
      (flight.fromX +
        (flight.targetX - flight.fromX) * at +
        (flight.fromBloomX +
          (flight.targetBloomX - flight.fromBloomX) * at) *
          bloom -
        camera.x) *
        camera.scale +
      viewport.width / 2 +
      (bow?.x ?? 0);
    const y =
      (flight.fromY +
        (flight.targetY - flight.fromY) * at +
        (flight.fromBloomY +
          (flight.targetBloomY - flight.fromBloomY) * at) *
          bloom -
        camera.y) *
        camera.scale +
      viewport.height / 2 +
      (bow?.y ?? 0);
    if (
      y < -ROW_TEXT_OVERSCAN_PX ||
      y > viewport.height + ROW_TEXT_OVERSCAN_PX ||
      x + NAME_LENS_KNOBS.ROW_RIGHT_PX < 0 ||
      x - NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX > viewport.width
    )
      continue;
    canvas.save();
    canvas.translate(x, y);
    if (named < 1) {
      // Written from the left, and unwritten back into it.
      canvas.clipRect(
        Skia.XYWHRect(
          -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX - 2,
          -ROW_TEXT_OVERSCAN_PX,
          GATHER_NAME_REACH_PX * named,
          ROW_TEXT_OVERSCAN_PX * 2,
        ),
        ClipOp.Intersect,
        true,
      );
    }
    const titleAlpha =
      titleFrom === undefined
        ? row.titleAlpha
        : titleFrom + (row.titleAlpha - titleFrom) * arrival;
    const count = row.titleTrace?.length ?? 0;
    const phase = writePhase(writeSubAlpha(written, count - 1, count));
    if (row.titleTrace !== null && phase.borderAlpha > 0) {
      const path = traceTitlePath(row.titleTrace, written);
      paints.trace.setAlphaf(owner * titleAlpha * phase.borderAlpha);
      canvas.drawPath(path, paints.trace);
      path.dispose();
    }
    paints.title.setAlphaf(
      owner *
        titleAlpha *
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
