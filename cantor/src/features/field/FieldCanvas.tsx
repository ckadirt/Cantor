import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import {
  Canvas,
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
  type Viewport,
} from '../../field';
import { lensByKey, type LensFonts, type LensPaints } from '../../lenses';
import { useMorphFont } from '../../motion/fonts';
import { font, type as textType, type Palette } from '../../theme/tokens';
import type { FieldPresentation } from './useFieldController';

/** KNOBS — screen-space culling and row dimensions from the HTML prototype. */
const FIELD_CANVAS_KNOBS = {
  OVERSCAN_PX: 260,
  ROW_WIDTH_PX: 240,
  ROW_HEIGHT_PX: 30,
  SHELF_LABEL_GAP_PX: 32,
  NAME_LENS_TITLE_SIZE_PX: 15,
} as const;

type Props = {
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  palette: Palette;
  /** Entity key of the song the player holds, lit at every level. */
  playingKey?: string | null;
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
  palette,
  playingKey = null,
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
      palette,
      playingKey,
      lensKey: activeLensKey,
      fonts: { display: displayFont, body: bodyFont, mono: monoFont },
      paints,
    });
  }, [
    activeLensKey,
    bodyFont,
    camera,
    displayFont,
    layout,
    monoFont,
    paints,
    palette,
    placements,
    playingKey,
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
  palette: Palette;
  playingKey?: string | null;
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
    if (presentation === undefined) continue;
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
