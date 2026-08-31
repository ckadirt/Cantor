import React, { useMemo, useRef } from 'react';
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
  gatherFraction,
  placementPoint,
  representationAlphas,
  shelfLabelAlpha,
  smootherstep,
  worldToScreen,
  type Camera,
  type FieldLayout,
  type Group,
  type Placement,
  type Point,
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
import type { SampleWindow } from '../../player';
import { jobMarkModel } from '../../jobs/marks';
import { jobStateLabel } from '../../jobs/policy';
import {
  captureLabelMorph,
  captureLabelText,
  drawLabelMorph,
  drawSettledLabel,
  planShelfLabels,
  retargetCapturedLabel,
  type CapturedLabelMorph,
  type LabelFlight,
  type ShelfLabelFlights,
} from './labelMorph';
import { shelfLabel } from './shelfLabels';
import type { FieldPresentation, JobPresentation } from './useFieldController';

/** KNOBS — screen-space culling and row dimensions from the HTML prototype. */
const FIELD_CANVAS_KNOBS = {
  OVERSCAN_PX: 260,
  ROW_WIDTH_PX: 240,
  ROW_HEIGHT_PX: 30,
  SHELF_LABEL_GAP_PX: 32,
  /** The axis key, drawn under the name a person would say. */
  SHELF_KEY_GAP_PX: 13,
  NAME_LENS_TITLE_SIZE_PX: 15,
  // L3: the waveform fills the viewport, with the playhead fixed at its centre
  // because at this level the audio moves past the head rather than the other
  // way round.
  GRAIN_HEIGHT_RATIO: 0.42,
  GRAIN_PLAYHEAD_WIDTH_PX: 1.5,
  GRAIN_LABEL_OFFSET_PX: 28,
  // A generation in flight: a ring the work fills, and the stage written inside.
  JOB_RING_RADIUS_PX: 9,
  JOB_RING_WIDTH_PX: 1.4,
  JOB_INDETERMINATE_SWEEP_DEG: 70,
  JOB_ROW_LABEL_OFFSET_PX: 42,
  // A face is an outline, not a blob: hairline everywhere, per the house rule.
  FACE_STROKE_PX: 1,
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
  /** The resolved audio window at L3, or null at every other distance. */
  grain?: GrainRender | null;
  activeLensKey?: string;
  /**
   * What the phone thinks the time is, so a week can read as `THIS WEEK`.
   * Passed rather than read here: a Picture must be a pure function of its
   * inputs or the memo below would hand back a stale one at midnight.
   */
  nowMs: number;
  /** Groups visibly owned before this born re-cut generation. */
  labelFromGroups?: readonly Group[];
  /**
   * The relayout tween, un-eased. Shelf labels ride it so a re-cut is one
   * movement: the marks travel, the camera corrects and the names change
   * together rather than as three overlapping animations.
   */
  relayoutLinear?: number;
  /** FIT interpolated with the camera, used by every scale-derived band. */
  renderFitScale?: number;
  /** Born transition identity used to capture interrupted label geometry. */
  transitionGeneration?: number;
};

/**
 * The only field canvas. Each React render records one immediate-mode Picture,
 * culls before lens work, then lets Skia replay that picture in one view.
 */
function FieldCanvasImpl({
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
  grain = null,
  activeLensKey = 'name',
  nowMs,
  labelFromGroups = [],
  relayoutLinear = 1,
  renderFitScale = layout.fitScale,
  transitionGeneration = 0,
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
  /**
   * The label transition, planned once per re-cut.
   *
   * The engine's own ritual: diff during render, build the geometry once, play
   * it. A born generation holds the plan across camera re-renders; when another
   * generation arrives mid-flight, the live paths are captured before the new
   * plan is built, so the morph cannot restart from a semantic endpoint.
   */
  const semanticLabelFlights = useMemo(() => {
    if (monoFont === null || labelFromGroups.length === 0) return null;
    return planShelfLabels(labelFromGroups, layout.groups, monoFont, nowMs);
  }, [labelFromGroups, layout, monoFont, nowMs]);
  const labelPlan = useRef<{
    generation: number;
    flights: ShelfLabelFlights | null;
  } | null>(null);
  const lastLabelLinear = useRef(1);
  if (
    monoFont !== null &&
    labelPlan.current?.generation !== transitionGeneration
  ) {
    const previous = labelPlan.current;
    labelPlan.current = {
      generation: transitionGeneration,
      flights:
        previous?.flights != null && semanticLabelFlights != null
          ? retargetShelfLabelFlights(
              previous.flights,
              lastLabelLinear.current,
              semanticLabelFlights,
              monoFont,
            )
          : semanticLabelFlights,
    };
  }
  lastLabelLinear.current = relayoutLinear;
  const labelFlights = labelPlan.current?.flights ?? semanticLabelFlights;
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
      grain,
      lensKey: activeLensKey,
      nowMs,
      labelFlights,
      relayoutLinear,
      renderFitScale,
      fonts: { display: displayFont, body: bodyFont, mono: monoFont },
      paints,
    });
  }, [
    activeLensKey,
    analyses,
    bodyFont,
    camera,
    displayFont,
    grain,
    jobs,
    labelFlights,
    layout,
    monoFont,
    nowMs,
    relayoutLinear,
    renderFitScale,
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

/** What L3 needs to draw: the resolved samples and what to call the span. */
export type GrainRender = Readonly<{
  window: SampleWindow;
  label: string;
}>;

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
  grain?: GrainRender | null;
  lensKey: string;
  nowMs: number;
  labelFlights?: ShelfLabelFlights | null;
  relayoutLinear?: number;
  renderFitScale?: number;
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
    request.renderFitScale ?? request.layout.fitScale,
  );
  // Where each cluster is between its two poses. Once per picture, from the
  // camera's scale — never in React state, which would rebuild every placement
  // on every pinch frame and lose the measured pan baseline.
  const gather = gatherFraction(
    request.camera.scale,
    request.renderFitScale ?? request.layout.fitScale,
  );
  drawShelfLabels(
    canvas,
    request,
    shelfLabelAlpha(
      request.camera.scale,
      request.renderFitScale ?? request.layout.fitScale,
    ),
    gather,
  );
  // At L3 the field gives way to one song's samples entirely.
  if (request.grain != null) {
    drawGrain(canvas, request, request.grain);
    return recorder.finishRecordingAsPicture();
  }

  const lens = lensByKey(request.lensKey);
  if (lens === null) return recorder.finishRecordingAsPicture();

  for (const placement of request.placements) {
    const placementOpacity = placement.opacity ?? 1;
    if (placementOpacity <= 0.01) continue;
    const point = worldToScreen(
      placementPoint(placement, gather),
      request.camera,
      request.viewport,
    );
    if (!withinOverscan(point, request.viewport)) continue;
    const presentation = request.presentations.get(placement.entityKey);
    if (presentation === undefined) {
      const pending = request.jobs?.get(placement.entityKey);
      if (pending !== undefined) {
        drawJobMark(canvas, request, point, pending, {
          dot: alpha.dot * placementOpacity,
          row: alpha.row * placementOpacity,
          song: alpha.song * placementOpacity,
          grain: alpha.grain * placementOpacity,
        });
      }
      continue;
    }
    const song = {
      key: presentation.entity.key,
      id: presentation.entity.entityId,
      seed: presentation.song.seed,
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
          ? request.playingProgress ?? null
          : null,
    } as const;
    if (alpha.dot > 0.01) {
      lens.draw(
        canvas,
        { kind: 'mark', x: point.x, y: point.y, width: 0, height: 0 },
        song,
        {
          alpha: alpha.dot * placementOpacity,
          fonts: request.fonts,
          paints: request.paints,
        },
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
        {
          alpha: alpha.row * placementOpacity,
          fonts: request.fonts,
          paints: request.paints,
        },
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
    outline: outlinePaint(palette.ink),
  };
}

/** Ink as a hairline stroke — what a face is drawn with. */
function outlinePaint(color: string): SkPaint {
  const result = paint(color);
  result.setStyle(PaintStyle.Stroke);
  result.setStrokeWidth(FIELD_CANVAS_KNOBS.FACE_STROKE_PX);
  return result;
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
  point: Point,
  pending: JobPresentation,
  alpha: RepresentationAlphas,
): void {
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

/**
 * One song's samples, filling the viewport, with a fixed centre playhead.
 *
 * The playhead does not move: at this level the audio moves past it, which is
 * what makes zoom and drag mean scrubbing rather than panning a picture.
 */
function drawGrain(
  canvas: SkCanvas,
  request: PictureRequest,
  grain: GrainRender,
): void {
  const { width, height } = request.viewport;
  const midY = height / 2;
  const halfHeight = height * FIELD_CANVAS_KNOBS.GRAIN_HEIGHT_RATIO;
  const paint = request.paints.ink;
  const channel = grain.window.channels[0];

  if (channel !== undefined && grain.window.buckets > 0) {
    paint.setAlphaf(1);
    const columns = Math.min(grain.window.buckets, Math.floor(width));
    const step = width / columns;
    for (let column = 0; column < columns; column += 1) {
      const bucket = Math.floor((column * grain.window.buckets) / columns);
      const low = channel.min[bucket] ?? 0;
      const high = channel.max[bucket] ?? 0;
      const top = midY - high * halfHeight;
      const bottom = midY - low * halfHeight;
      canvas.drawRect(
        {
          x: column * step,
          y: Math.min(top, bottom),
          width: Math.max(0.7, step * 0.85),
          height: Math.max(0.7, Math.abs(bottom - top)),
        },
        paint,
      );
    }
  } else {
    // No samples: a flat line is honest about having nothing to show.
    request.paints.faint.setAlphaf(1);
    canvas.drawRect({ x: 0, y: midY, width, height: 1 }, request.paints.faint);
  }

  paint.setAlphaf(1);
  canvas.drawRect(
    {
      x: width / 2 - FIELD_CANVAS_KNOBS.GRAIN_PLAYHEAD_WIDTH_PX / 2,
      y: 0,
      width: FIELD_CANVAS_KNOBS.GRAIN_PLAYHEAD_WIDTH_PX,
      height,
    },
    paint,
  );

  request.paints.muted.setAlphaf(1);
  canvas.drawText(
    grain.label,
    FIELD_CANVAS_KNOBS.GRAIN_LABEL_OFFSET_PX,
    FIELD_CANVAS_KNOBS.GRAIN_LABEL_OFFSET_PX,
    request.paints.muted,
    request.fonts.mono,
  );
}

/**
 * The name over each cluster.
 *
 * While a re-cut is running the labels are *flights* rather than group
 * properties: one label can leave a cluster that no longer exists, and two can
 * leave the same one. Each is drawn between the seat it came from and the seat
 * it is going to, so a month splitting into playlists sends a copy of its name
 * out to every one of them.
 */
function drawShelfLabels(
  canvas: SkCanvas,
  request: PictureRequest,
  alpha: number,
  gather: number,
): void {
  if (alpha <= 0.01) return;
  const topYByGroup = new Map<string, number>();
  for (const placement of request.placements) {
    const point = worldToScreen(
      placementPoint(placement, gather),
      request.camera,
      request.viewport,
    );
    const previous = topYByGroup.get(placement.groupKey);
    if (previous === undefined || point.y < previous) {
      topYByGroup.set(placement.groupKey, point.y);
    }
  }
  request.paints.faint.setAlphaf(alpha);
  request.paints.muted.setAlphaf(alpha);

  /** Where a cluster's label sits once everything has settled. */
  const seatOf = (group: (typeof request.layout.groups)[number]) => {
    const groupPoint = worldToScreen(
      { x: group.cx, y: group.cy },
      request.camera,
      request.viewport,
    );
    return {
      x: groupPoint.x,
      y:
        (topYByGroup.get(group.key) ?? groupPoint.y) -
        FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
    };
  };

  /** A cluster's centre lifted to where its name sits. */
  const above = (point: { x: number; y: number }) => ({
    x: point.x,
    y: point.y - FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
  });

  const progress = request.relayoutLinear ?? 1;
  // Two clocks, one tween. The glyphs morph on the raw ramp because the motion
  // engine eases inside its own windows; the seat travels on the same eased
  // curve the marks use, so a label and its cluster move at one rate.
  const travel = smootherstep(progress);
  const flights = progress < 1 ? request.labelFlights ?? null : null;
  if (flights !== null) {
    const groupsByKey = new Map(
      request.layout.groups.map(group => [group.key, group]),
    );
    for (const flight of flights) {
      const arriving =
        flight.toGroupKey === null
          ? null
          : groupsByKey.get(flight.toGroupKey) ?? null;
      // The seat is where a settled label for this cluster would be drawn, and
      // the flight is an *offset* from it that shrinks to nothing: the world
      // gap between the two cluster centres, projected. Anchoring both ends
      // the same way is what makes a re-cut that does not move a cluster —
      // one month becoming one year — morph in place instead of swooping.
      // Lerping a centre into a seat would always travel, because a cluster's
      // centre is not where its name sits.
      const seat =
        arriving === null
          ? above(worldToScreen(flight.to, request.camera, request.viewport))
          : seatOf(arriving);
      const rest = 1 - travel;
      const point = {
        x: seat.x + (flight.from.x - flight.to.x) * request.camera.scale * rest,
        y: seat.y + (flight.from.y - flight.to.y) * request.camera.scale * rest,
      };
      if (!withinOverscan(point, request.viewport)) continue;
      if (flight.primary !== null) {
        drawLabelMorph(
          canvas,
          flight.primary,
          point.x,
          point.y,
          progress,
          request.paints.muted,
          alpha,
          request.fonts.mono,
        );
      } else if (flight.primaryTo.length > 0) {
        drawSettledLabel(
          canvas,
          flight.primaryTo,
          point.x,
          point.y,
          request.paints.muted,
          request.fonts.mono,
        );
      }
      if (flight.secondary !== null) {
        drawLabelMorph(
          canvas,
          flight.secondary,
          point.x,
          point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
          progress,
          request.paints.faint,
          alpha,
          request.fonts.mono,
        );
      } else if (flight.secondaryTo.length > 0) {
        drawSettledLabel(
          canvas,
          flight.secondaryTo,
          point.x,
          point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
          request.paints.faint,
          request.fonts.mono,
        );
      }
    }
    return;
  }

  for (const group of request.layout.groups) {
    const point = seatOf(group);
    if (!withinOverscan(point, request.viewport)) continue;
    // The axis hands over its key; the surface says it out loud, and keeps the
    // key underneath so the grouping is never a mystery.
    const read = shelfLabel(group.label, request.nowMs);
    drawSettledLabel(
      canvas,
      read.primary.toUpperCase(),
      point.x,
      point.y,
      request.paints.muted,
      request.fonts.mono,
    );
    if (read.secondary !== null) {
      drawSettledLabel(
        canvas,
        read.secondary,
        point.x,
        point.y + FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
        request.paints.faint,
        request.fonts.mono,
      );
    }
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

type CapturedShelfFlight = Readonly<{
  point: Point;
  primary: CapturedLabelMorph | null;
  secondary: CapturedLabelMorph | null;
  survives: boolean;
}>;

/**
 * Retarget label flights from the exact paths and world anchor drawn by the
 * interrupted generation. This is the field-canvas equivalent of
 * `captureSilhouette`: the next filter never restarts from either semantic
 * endpoint when the person taps the dial mid-morph.
 */
function retargetShelfLabelFlights(
  current: ShelfLabelFlights,
  progress: number,
  next: ShelfLabelFlights,
  labelFont: Parameters<typeof captureLabelMorph>[2],
): ShelfLabelFlights {
  const travel = smootherstep(progress);
  const capturedByGroup = new Map<string, CapturedShelfFlight>();
  for (const flight of current) {
    if (flight.toGroupKey === null) continue;
    const captured: CapturedShelfFlight = {
      point: {
        x: flight.from.x + (flight.to.x - flight.from.x) * travel,
        y: flight.from.y + (flight.to.y - flight.from.y) * travel,
      },
      primary: captureFlightLine(
        flight.primary,
        flight.primaryTo,
        progress,
        labelFont,
      ),
      secondary: captureFlightLine(
        flight.secondary,
        flight.secondaryTo,
        progress,
        labelFont,
      ),
      survives: flight.primaryTo.length > 0,
    };
    const previous = capturedByGroup.get(flight.toGroupKey);
    if (previous === undefined || (!previous.survives && captured.survives)) {
      capturedByGroup.set(flight.toGroupKey, captured);
    }
  }

  return next.map(flight => {
    const captured =
      flight.fromGroupKey === null
        ? undefined
        : capturedByGroup.get(flight.fromGroupKey);
    if (captured === undefined) return flight;
    return {
      ...flight,
      from: captured.point,
      primary:
        captured.primary === null
          ? flight.primary
          : retargetCapturedLabel(
              captured.primary,
              flight.primaryTo,
              labelFont,
            ) ?? flight.primary,
      secondary:
        captured.secondary === null
          ? flight.secondary
          : retargetCapturedLabel(
              captured.secondary,
              flight.secondaryTo,
              labelFont,
            ) ?? flight.secondary,
      primaryFrom: captured.primary?.text ?? flight.primaryFrom,
      secondaryFrom: captured.secondary?.text ?? flight.secondaryFrom,
    };
  });
}

function captureFlightLine(
  morph: LabelFlight['primary'],
  settledText: string,
  progress: number,
  labelFont: Parameters<typeof captureLabelMorph>[2],
): CapturedLabelMorph | null {
  return morph === null
    ? captureLabelText(settledText, labelFont)
    : captureLabelMorph(morph, progress, labelFont);
}

/**
 * Memoised so a screen re-render that leaves the camera and content untouched
 * does not re-record the picture. A camera change still re-records: the level
 * crossfades and screen-space type genuinely differ at every scale.
 */
export const FieldCanvas = React.memo(FieldCanvasImpl);
