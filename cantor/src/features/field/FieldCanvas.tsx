import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import {
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  type SkCanvas,
  type SkPaint,
  type SkPicture,
} from '@shopify/react-native-skia';
import {
  representationAlphas,
  shelfLabelAlpha,
  worldToScreen,
  type Camera,
  type FieldLayout,
  type Placement,
  type RepresentationAlphas,
  type Viewport,
} from '../../field';
import {
  lensByKey,
  neutralAnalysis,
  type LensFonts,
  type LensPaints,
  type SongAnalysis,
} from '../../lenses';
import { useMorphFont } from '../../motion/fonts';
import { font, type as textType, type Palette } from '../../theme/tokens';
import { jobMarkModel } from '../../jobs/marks';
import { jobStateLabel } from '../../jobs/policy';
import type { FieldPresentation, JobPresentation } from './useFieldController';

/** KNOBS — screen-space culling and row dimensions from the HTML prototype. */
const FIELD_CANVAS_KNOBS = {
  OVERSCAN_PX: 260,
  ROW_WIDTH_PX: 240,
  ROW_HEIGHT_PX: 30,
  SHELF_LABEL_GAP_PX: 32,
  NAME_LENS_TITLE_SIZE_PX: 15,
  // A generation in flight: a ring the work fills, and the stage written inside.
  JOB_RING_RADIUS_PX: 9,
  JOB_RING_WIDTH_PX: 1.4,
  JOB_INDETERMINATE_SWEEP_DEG: 70,
  JOB_ROW_LABEL_OFFSET_PX: 42,
} as const;

type Props = {
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs?: ReadonlyMap<string, JobPresentation>;
  palette: Palette;
  /** Entity key of the song the player holds, lit at every level. */
  playingKey?: string | null;
  /** Analysis by entity key. Anything absent draws the neutral skeleton. */
  analyses?: ReadonlyMap<string, SongAnalysis>;
  /** How far through the playing song we are, 0..1. */
  playingProgress?: number | null;
  activeLensKey?: string;
};

/**
 * The only field canvas. Each React render records one immediate-mode Picture,
 * culls before lens work, then lets Skia replay that picture in one view.
 */
export function FieldCanvas({
  layout,
  placements,
  camera,
  viewport,
  presentations,
  jobs,
  palette,
  playingKey = null,
  analyses,
  playingProgress = null,
  activeLensKey = 'name',
}: Props) {
  const displayFont = useMorphFont({
    fontFamily: font.display,
    // L1 has title plus metadata in every row; this leaves each row legible
    // at the prototype's 26-world-unit song spacing.
    fontSize: FIELD_CANVAS_KNOBS.NAME_LENS_TITLE_SIZE_PX,
  });
  const bodyFont = useMorphFont({
    fontFamily: font.text,
    fontSize: textType.small.fontSize,
  });
  const monoFont = useMorphFont({
    fontFamily: font.mono,
    fontSize: 9,
  });
  const paints = useMemo(() => createPaints(palette), [palette]);
  const picture = useMemo(() => {
    if (displayFont === null || bodyFont === null || monoFont === null) {
      return null;
    }
    return recordFieldPicture({
      layout,
      placements,
      camera,
      viewport,
      presentations,
      jobs,
      palette,
      playingKey,
      analyses,
      playingProgress,
      lensKey: activeLensKey,
      fonts: { display: displayFont, body: bodyFont, mono: monoFont },
      paints,
    });
  }, [
    activeLensKey,
    analyses,
    bodyFont,
    camera,
    displayFont,
    jobs,
    layout,
    monoFont,
    paints,
    palette,
    placements,
    playingKey,
    playingProgress,
    presentations,
    viewport,
  ]);

  return (
    <Canvas
      importantForAccessibility="no-hide-descendants"
      opaque
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      {picture === null ? null : <Picture picture={picture} />}
    </Canvas>
  );
}

type PictureRequest = Readonly<{
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs?: ReadonlyMap<string, JobPresentation>;
  palette: Palette;
  playingKey?: string | null;
  analyses?: ReadonlyMap<string, SongAnalysis>;
  playingProgress?: number | null;
  lensKey: string;
  fonts: LensFonts;
  paints: LensPaints;
}>;

export function recordFieldPicture(request: PictureRequest): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(0, 0, request.viewport.width, request.viewport.height),
  );
  canvas.drawColor(Skia.Color(request.palette.bg));

  const alpha = representationAlphas(
    request.camera.scale,
    request.layout.fitScale,
  );
  drawShelfLabels(
    canvas,
    request,
    shelfLabelAlpha(request.camera.scale, request.layout.fitScale),
  );
  const lens = lensByKey(request.lensKey);
  if (lens === null) return recorder.finishRecordingAsPicture();

  for (const placement of request.placements) {
    const presentation = request.presentations.get(placement.entityKey);
    if (presentation === undefined) {
      const pending = request.jobs?.get(placement.entityKey);
      if (pending !== undefined) {
        drawJobMark(canvas, request, placement, pending, alpha);
      }
      continue;
    }
    const point = worldToScreen(
      { x: placement.x, y: placement.y },
      request.camera,
      request.viewport,
    );
    if (!withinOverscan(point, request.viewport)) continue;
    const song = {
      key: presentation.entity.key,
      title: presentation.song.title,
      createdAtMs: presentation.entity.createdAtMs,
      durationMs: presentation.song.duration_ms,
      model: presentation.song.model,
      nodeLabel: presentation.nodeLabels[0] ?? presentation.backend.petname,
      audioState: presentation.localAudio.state,
      playing: presentation.entity.key === request.playingKey,
      analysis:
        request.analyses?.get(presentation.entity.key) ?? neutralAnalysis(),
      progress:
        presentation.entity.key === request.playingKey
          ? (request.playingProgress ?? null)
          : null,
    } as const;
    if (alpha.dot > 0.01) {
      lens.draw(
        canvas,
        { kind: 'mark', x: point.x, y: point.y, width: 0, height: 0 },
        song,
        { alpha: alpha.dot, fonts: request.fonts, paints: request.paints },
      );
    }
    if (alpha.row > 0.01) {
      lens.draw(
        canvas,
        {
          kind: 'row',
          x: point.x,
          y: point.y,
          width: FIELD_CANVAS_KNOBS.ROW_WIDTH_PX,
          height: FIELD_CANVAS_KNOBS.ROW_HEIGHT_PX,
        },
        song,
        { alpha: alpha.row, fonts: request.fonts, paints: request.paints },
      );
    }
  }
  return recorder.finishRecordingAsPicture();
}

function createPaints(palette: Palette): LensPaints {
  return {
    ink: paint(palette.ink),
    muted: paint(palette.muted),
    faint: paint(palette.faint),
  };
}

function paint(color: string): SkPaint {
  const result = Skia.Paint();
  result.setAntiAlias(true);
  result.setColor(Skia.Color(color));
  return result;
}

/**
 * A generation in flight, drawn as a mark rather than a queue row.
 *
 * The ring only fills when the node supplied a total. Without one it draws a
 * fixed sweep — visibly working, claiming nothing — because before M8 there is
 * no stage mask to compute a percentage from, and a ring that guessed would be
 * a number that looks like knowledge.
 */
function drawJobMark(
  canvas: SkCanvas,
  request: PictureRequest,
  placement: Placement,
  pending: JobPresentation,
  alpha: RepresentationAlphas,
): void {
  const point = worldToScreen(
    { x: placement.x, y: placement.y },
    request.camera,
    request.viewport,
  );
  if (!withinOverscan(point, request.viewport)) return;

  const model = jobMarkModel(pending.job, []);
  const visible = Math.max(alpha.dot, alpha.row);
  if (visible <= 0.01) return;

  const paint = request.paints.ink;
  const radius = FIELD_CANVAS_KNOBS.JOB_RING_RADIUS_PX;
  const box = Skia.XYWHRect(
    point.x - radius,
    point.y - radius,
    radius * 2,
    radius * 2,
  );

  paint.setAlphaf(visible * (model.failed ? 0.45 : 1));
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(FIELD_CANVAS_KNOBS.JOB_RING_WIDTH_PX);
  if (model.progress.kind === 'determinate') {
    canvas.drawArc(box, -90, 360 * model.progress.fraction, false, paint);
  } else {
    canvas.drawArc(
      box,
      -90,
      FIELD_CANVAS_KNOBS.JOB_INDETERMINATE_SWEEP_DEG,
      false,
      paint,
    );
  }
  paint.setStyle(PaintStyle.Fill);

  // At L1 there is room for words; say what is happening and, when the node
  // counted it, how far in.
  if (alpha.row > 0.01) {
    paint.setAlphaf(alpha.row);
    const label = jobStateLabel(pending.job);
    const counted =
      model.progress.kind === 'determinate'
        ? ` ${model.progress.completed}/${model.progress.total}`
        : '';
    canvas.drawText(
      `${label}${counted}`,
      point.x - FIELD_CANVAS_KNOBS.JOB_ROW_LABEL_OFFSET_PX,
      point.y + 4,
      paint,
      request.fonts.mono,
    );
    if (pending.caption !== null) {
      request.paints.muted.setAlphaf(alpha.row * 0.8);
      canvas.drawText(
        pending.caption.slice(0, 28),
        point.x - FIELD_CANVAS_KNOBS.JOB_ROW_LABEL_OFFSET_PX,
        point.y + 17,
        request.paints.muted,
        request.fonts.mono,
      );
    }
  }
}

function drawShelfLabels(
  canvas: SkCanvas,
  request: PictureRequest,
  alpha: number,
): void {
  if (alpha <= 0.01) return;
  const topYByGroup = new Map<string, number>();
  for (const placement of request.placements) {
    const point = worldToScreen(
      { x: placement.x, y: placement.y },
      request.camera,
      request.viewport,
    );
    const previous = topYByGroup.get(placement.groupKey);
    if (previous === undefined || point.y < previous) {
      topYByGroup.set(placement.groupKey, point.y);
    }
  }
  request.paints.faint.setAlphaf(alpha);
  for (const group of request.layout.groups) {
    const groupPoint = worldToScreen(
      { x: group.cx, y: group.cy },
      request.camera,
      request.viewport,
    );
    const point = {
      x: groupPoint.x,
      y:
        (topYByGroup.get(group.key) ?? groupPoint.y) -
        FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
    };
    if (!withinOverscan(point, request.viewport)) continue;
    const label = group.label.toUpperCase();
    const width = request.fonts.mono.measureText(label).width;
    canvas.drawText(
      label,
      point.x - width / 2,
      point.y,
      request.paints.faint,
      request.fonts.mono,
    );
  }
}

function withinOverscan(
  point: { x: number; y: number },
  viewport: Viewport,
): boolean {
  return (
    point.x >= -FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.x <= viewport.width + FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.y >= -FIELD_CANVAS_KNOBS.OVERSCAN_PX &&
    point.y <= viewport.height + FIELD_CANVAS_KNOBS.OVERSCAN_PX
  );
}
