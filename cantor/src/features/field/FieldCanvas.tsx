import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import {
  Canvas,
  Circle,
  Fill,
  Group as SkiaGroup,
  LinearGradient,
  PaintStyle,
  Path,
  Picture,
  Rect,
  Skia,
  Text,
  vec,
  type SkCanvas,
  type SkColor,
  type SkPaint,
  type SkPath,
  type SkPicture,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  REPRESENTATION_WINDOWS,
  SHELF_BOX,
  bandAlphaAt,
  faceArrival,
  gatherFraction,
  isNativeDrawnDistance,
  placementPoint,
  nameArrival,
  songNameArrival,
  songShapeArrival,
  representationAlphas,
  shelfLabelAlpha,
  smootherstep,
  worldToScreen,
  type Camera,
  type FieldLayout,
  type Group,
  type Placement,
  type FlightOwnership,
  type PlacementFlight,
  type Point,
  type RepresentationAlphas,
  type Viewport,
} from '../../field';
import {
  FACE_FILL_ALPHA,
  FACE_STROKE_ALPHA,
  NAME_LENS_KNOBS,
  arrivingFraction,
  availabilityAction,
  availabilityLine,
  availabilityOf,
  fitText,
  lensByKey,
  nameLensFacePath,
  nameLensRingRadius,
  neutralAnalysis,
  type LensFonts,
  type LensPaints,
  type SongAnalysis,
} from '../../lenses';
import { bornClock } from '../../motion/clock';
import { useMorphFont } from '../../motion/fonts';
import { layoutText, writePhase, writeSubAlpha } from '../../motion/text';
import { traceTitlePath } from './titleTrace';
import { font, type as textType, type Palette } from '../../theme/tokens';
import type { SampleWindow } from '../../player';
import { jobMarkModel } from '../../jobs/marks';
import { jobStateLabel } from '../../jobs/policy';
import { compoundPolygonPath } from '../../motion/geometry';
import { resolveSilhouette } from '../../motion/silhouette';
import { SYMBOL_LIBRARY, type SymbolName } from '../../motion/symbolLibrary';
import {
  captureLabelMorph,
  captureLabelText,
  drawLabelMorph,
  drawSettledLabel,
  labelFlightAlpha,
  planShelfLabels,
  retargetCapturedLabel,
  settledShelfLabelFlights,
  type CapturedLabelMorph,
  type LabelFlight,
  type ShelfLabelFlights,
} from './labelMorph';
import {
  NativePlayerParts,
  PlayerRing,
  nativeSongModel,
  type NativeSongModel,
} from './NativePlayer';
import {
  PLAYER_POSE_KNOBS,
  facePoseAt,
  lineOwnedByPlayer,
  playerRadiusPx,
  playerRisePx,
} from './songPose';
import { shelfLabel } from './shelfLabels';
import type { FieldPresentation, JobPresentation } from './useFieldController';
import { FIELD_CAMERA_KNOBS, type FieldRecutModel } from './useFieldCamera';

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
  // Just outside the face's own ring, so a job's halo and a playing song's
  // read as one vocabulary. Larger than that and the ring encloses whichever
  // neighbour the bloom seated next to it.
  JOB_RING_RADIUS_PX: 12,
  JOB_RING_WIDTH_PX: 1.4,
  JOB_INDETERMINATE_SWEEP_DEG: 70,
  /** The whole arc, drawn ahead of the work in the palette's lightest ink. */
  JOB_RING_AHEAD_ALPHA: 0.16,
  /** The stage's own symbol, inside the ring it is working its way around. */
  JOB_GLYPH_PX: 11,
  /** `DIFFUSE 18/32`, centred under the mark. */
  JOB_STAGE_LABEL_GAP_PX: 26,
  /** A failed job keeps its seat, and says so by going quiet rather than red. */
  JOB_FAILED_ALPHA: 0.35,
  /**
   * The player's ring, as a fraction of the view's *width*.
   *
   * Read from `songPose`, which owns every measurement the player is built
   * from now that it is drawn rather than laid out. Kept here so the recorded
   * picture and the native path cannot drift apart on the one number they both
   * need.
   */
  SONG_BOX_RATIO: PLAYER_POSE_KNOBS.SONG_BOX_RATIO,
  /**
   * How far the ring rises above the mark's own point, as a fraction of the
   * view's height, once the player is fully here.
   *
   * The design seats the ring above the song's name rather than in the middle
   * of the screen, and the name needs the lower third. Scaled by `alpha.song`
   * so the ring is still centred on the mark where the row hands over and has
   * risen to its seat by the time the player is the only thing left — the mark
   * rises into its seat rather than jumping to it.
   */
  SONG_RISE_RATIO: PLAYER_POSE_KNOBS.SONG_RISE_RATIO,
  /** Where the sweeping arc sits, as a fraction of the player's radius. */
  SONG_ARC_RATIO: PLAYER_POSE_KNOBS.SONG_ARC_RATIO,
  /** The measured audio, drawn outward from that arc. */
  SONG_WAVE_TICKS: 96,
  SONG_WAVE_REACH_RATIO: 0.36,
  SONG_WAVE_WIDTH_PX: 1.5,
  SONG_WAVE_ALPHA: 0.55,
  /** Music sits at 0.1–0.3 RMS; the wave lens takes the same fixed gain. */
  SONG_WAVE_GAIN: 2.6,
  /**
   * The beat: how far either side of the playhead the lift reaches, in turns,
   * and how tall it grows at its centre.
   *
   * A tenth of a turn is about 36°, wide enough to read as a swell travelling
   * around the ring rather than a single tick twitching.
   */
  SONG_PULSE_WINDOW: 0.5,
  SONG_PULSE_GAIN: 1.6,
  SONG_ARC_WIDTH_PX: 1.5,
  /** The hand, from near the centre out to the waveform's baseline. */
  SONG_HAND_INNER_RATIO: 0.12,
  SONG_HAND_OUTER_RATIO: 0.5,
  SONG_HAND_WIDTH_PX: 1,
  JOB_ROW_LABEL_OFFSET_PX: 42,
  // A face is an outline, not a blob: hairline everywhere, per the house rule.
  FACE_STROKE_PX: 1,
} as const;

/*
 * The L0 → L1 gesture, as three numbers the name lens already implies.
 *
 * Not knobs: they are `NAME_LENS_KNOBS` read once so a worklet does not divide
 * on every frame, and changing them here would only make the moving face
 * disagree with the face the picture draws at the same distance.
 */
/** KNOBS — how a mark's name is drawn on, where `bands.ts` says when. */
const ROW_ARRIVAL_KNOBS = {
  /**
   * The pen's width for a row's title, in pixels.
   *
   * `WRITE_STROKE_PX` is 1.25, which is right for the chrome's 26 px display
   * title and far too heavy here: a row's title is 15 px, and at that size a
   * 1.25 px outline closes its counters and the trace reads as bold text
   * appearing rather than as a line being drawn. This is that stroke at this
   * type's own scale.
   */
  TRACE_STROKE_PX: 0.7,
} as const;

/** The row's face over the mark's. `nameLensFacePath` is linear in its radius,
 *  so this is a scale rather than a second path: 9 / 7.5. */
const FACE_GROWTH =
  NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX / NAME_LENS_KNOBS.MARK_RADIUS_PX;
const MARK_RING_RADIUS_PX = nameLensRingRadius(
  NAME_LENS_KNOBS.MARK_RADIUS_PX,
);
const ROW_RING_RADIUS_PX = nameLensRingRadius(
  NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
);

type Props = {
  layout: FieldLayout;
  placements: readonly Placement[];
  camera: Camera;
  cameraShared: SharedValue<Camera>;
  /**
   * FIT on the UI thread.
   *
   * Every band and the gather are measured against it, and the native renderer
   * reads them on the frame it draws — so it needs the fit there too, not the
   * number React last committed. During a re-cut the camera hook writes this
   * every frame from its own tick.
   */
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  jobs?: ReadonlyMap<string, JobPresentation>;
  palette: Palette;
  /** Entity key of the song the player holds, lit at every level. */
  /**
   * The player's visual clock, in seconds, on the UI thread.
   *
   * The player's progress is drawn from this and never from React. The Flicker
   * Law note below lists "a playing song ticks the playhead" among the renders
   * that used to repaint the whole canvas from stale values — and a boundary
   * stepped through React state is not movement anyway, it is a tone changing
   * six times a second.
   */
  positionSeconds?: SharedValue<number> | null;
  playingKey?: string | null;
  /**
   * The placement the camera has arrived at.
   *
   * Only this one is ever drawn as a player: the player *is* the song you have
   * arrived at, so there is exactly one at a time by definition. Without it,
   * every neighbour still inside the overscan draws its own ring and they
   * overlap across the view.
   */
  focusKey?: string | null;
  /**
   * What pressing the transport would do, in the player's own words.
   *
   * A string rather than the player's state, because the canvas draws a word
   * and has no business knowing what a snapshot is. It changes only when a
   * person presses something, so it never wakes the canvas on a frame.
   */
  transportLabel?: string;
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
  /** Static endpoints for the native-clock L0 renderer. */
  recut?: FieldRecutModel | null;
};

/**
 * The camera the field is actually being *shown* at, right now.
 *
 * `camera` and `cameraShared` are the same quantity sampled at different times:
 * React's copy is whatever the last mirrored frame carried, and the shared one
 * is what the UI thread is drawing from this instant. Recording against React's
 * copy bakes React's commit latency into the transform — and that latency is
 * not constant, so it does not read as a lag, it reads as a *flicker*: every
 * fresh recording is one element, Skia repaints the tree from the JS thread's
 * last transform, and the difference between that and the live one is however
 * long React happened to take. Recording against the live camera instead makes
 * the transform ≈ identity at the moment of recording, so the repainted frame
 * and the animated frame agree to within one frame of motion.
 *
 * The guard is for the one case where the two are not the same quantity: before
 * the first camera is published, React holds the fitted camera and the shared
 * value still holds its placeholder. A disagreement wider than the screen is
 * not latency, so React's is the one to believe.
 */
function drawCamera(
  camera: Camera,
  cameraShared: SharedValue<Camera>,
  viewport: Viewport,
): Camera {
  const live = cameraShared.value;
  if (!(live.scale > 0)) return camera;
  const dx = (live.x - camera.x) * live.scale;
  const dy = (live.y - camera.y) * live.scale;
  const reach = viewport.width + viewport.height;
  if (dx * dx + dy * dy > reach * reach) return camera;
  return live;
}

/**
 * The map from a picture recorded at one camera to the screen at another.
 *
 * A recorded picture is baked in *screen* coordinates, so moving the camera has
 * always meant recording it again. It does not have to: for a picture recorded
 * at `N` and shown at `M`, screen points are related by one affine map.
 *
 *     p_M = (p_N − V/2)·(M.scale/N.scale) + (N.xy − M.xy)·M.scale + V/2
 *
 * Returned in canvas-operation order, which is the order Skia's `transform`
 * prop applies: translate to where the centre goes, scale about it, then bring
 * the centre back. For a pan the scale factor is exactly 1, so the map is a
 * pure translation and nothing is approximated — text stays crisp and a row
 * keeps its 240×30 screen box however far the finger travels.
 *
 * Defined above the component on purpose: the worklets plugin captures a
 * `'worklet'` declaration into a calling worklet's closure where that caller is
 * defined, so a helper further down the file arrives as `undefined`.
 */
export function pictureTransformFor(
  recorded: Camera,
  live: Camera,
  viewport: Viewport,
): Transforms3d {
  'worklet';
  const halfWidth = viewport.width / 2;
  const halfHeight = viewport.height / 2;
  if (!(live.scale > 0) || !(recorded.scale > 0)) {
    return [{ translateX: 0 }, { translateY: 0 }];
  }
  return [
    { translateX: halfWidth + (recorded.x - live.x) * live.scale },
    { translateY: halfHeight + (recorded.y - live.y) * live.scale },
    { scale: live.scale / recorded.scale },
    { translateX: -halfWidth },
    { translateY: -halfHeight },
  ];
}

/**
 * The paper the shelf is read on, over the chrome's own ground.
 *
 * `SHELF_BOX` in `field/shelf.ts` says why the box exists and owns both of its
 * numbers; this is only the drawing of it. Two plates of paper, one at each
 * end, each with a short gradient on its inner edge so a row dissolves into the
 * page instead of being cut in half by it.
 *
 * Its opacity is the *row band's* own alpha, read from the live camera on the
 * UI thread. That is deliberate and it is the whole rule: the box is there for
 * exactly as long as there are names to read, so it writes itself on as the
 * rows resolve out of their dots and off again as they hand over to the player.
 * No level test, nothing to keep in step with the bands, and nothing to pop at
 * the point where the picture takes the field back from the native renderer —
 * which happens mid-row-band, with the veil at full strength on both sides.
 *
 * Held by identity and fed only shared values, for the reason `scene` gives.
 */
const ShelfVeil = React.memo(function ShelfVeilImpl({
  cameraShared,
  fitScaleShared,
  viewport,
  colour,
}: {
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  colour: string;
}) {
  const opacity = useDerivedValue(
    () =>
      bandAlphaAt(
        cameraShared.value.scale,
        fitScaleShared.value,
        REPRESENTATION_WINDOWS.row,
      ),
    [cameraShared, fitScaleShared],
  );
  // The far end of each gradient is the paper with nothing left of it. Built
  // from the palette's own colour rather than written as a literal: a gradient
  // that runs to `transparent` runs through grey on the way in a light theme
  // and through nothing at all in a dark one.
  const clear = useMemo(() => clearPaper(colour), [colour]);
  const topFade = SHELF_BOX.TOP_PX + SHELF_BOX.FADE_PX;
  const foot = viewport.height - SHELF_BOX.FOOT_PX;
  const footFade = foot - SHELF_BOX.FADE_PX;
  return (
    <SkiaGroup opacity={opacity}>
      <Rect
        color={colour}
        height={SHELF_BOX.TOP_PX}
        width={viewport.width}
        x={0}
        y={0}
      />
      <Rect
        height={SHELF_BOX.FADE_PX}
        width={viewport.width}
        x={0}
        y={SHELF_BOX.TOP_PX}
      >
        <LinearGradient
          colors={[colour, clear]}
          end={vec(0, topFade)}
          start={vec(0, SHELF_BOX.TOP_PX)}
        />
      </Rect>
      <Rect
        height={SHELF_BOX.FADE_PX}
        width={viewport.width}
        x={0}
        y={footFade}
      >
        <LinearGradient
          colors={[clear, colour]}
          end={vec(0, foot)}
          start={vec(0, footFade)}
        />
      </Rect>
      <Rect
        color={colour}
        height={SHELF_BOX.FOOT_PX}
        width={viewport.width}
        x={0}
        y={foot}
      />
    </SkiaGroup>
  );
});

/** The same paper with nothing left of it: the colour at alpha zero. */
function clearPaper(colour: string): SkColor {
  const paper = Skia.Color(colour);
  return Float32Array.of(paper[0], paper[1], paper[2], 0);
}

/**
 * The only field canvas. Each React render records one immediate-mode Picture,
 * culls before lens work, then lets Skia replay that picture in one view.
 */
function FieldCanvasImpl({
  layout,
  placements,
  camera,
  cameraShared,
  fitScaleShared,
  viewport,
  presentations,
  jobs,
  palette,
  positionSeconds = null,
  playingKey = null,
  focusKey = null,
  transportLabel = 'PLAY',
  analyses,
  playingProgress = null,
  grain = null,
  activeLensKey = 'name',
  nowMs,
  labelFromGroups = [],
  relayoutLinear = 1,
  renderFitScale = layout.fitScale,
  transitionGeneration = 0,
  recut = null,
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
   * The player's two faces: the name at `type.title`, and everything said about
   * it at `type.eyebrow`.
   *
   * Separate hooks rather than one font resized on the fly, because the name
   * *morphs* between the row's 15 px and this 26 px — both ends of that
   * interpolation have to exist at once, and a font is immutable in its size.
   */
  const songTitleFont = useMorphFont({
    fontFamily: font.display,
    fontSize: PLAYER_POSE_KNOBS.SONG_TITLE_SIZE_PX,
  });
  const songMetaFont = useMorphFont({
    fontFamily: font.mono,
    fontSize: textType.eyebrow.fontSize,
  });
  // House rule 5: born clocks, generation keys. A clock shared across
  // generations could advance while the outgoing
  // generation's mappers are still installed — `useDerivedValue` restarts them
  // from a *passive* effect, one scheduling step later — so the outgoing tree
  // reads the newborn clock for a frame and paints its own source pose. Tap
  // the dial back and forth and that pose is the arrangement you are returning
  // to: the destination, flashed once before the animation starts.
  const clockPlan = useRef<{
    generation: number;
    clock: SharedValue<number>;
  } | null>(null);
  if (recut !== null && clockPlan.current?.generation !== recut.generation) {
    // A re-cut that does not animate is born finished rather than born at its
    // source, so reduced motion shows the new cut instead of one stale frame.
    clockPlan.current = {
      generation: recut.generation,
      clock: bornClock(recut.animate ? 0 : 1),
    };
  }
  const nativeClock = clockPlan.current?.clock ?? null;
  /**
   * The label transition, planned once per re-cut.
   *
   * The engine's own ritual: diff during render, build the geometry once, play
   * it. A born generation holds the plan across camera re-renders; when another
   * generation arrives mid-flight, the live paths are captured before the new
   * plan is built, so the morph cannot restart from a semantic endpoint.
   */
  const semanticLabelFlights = useMemo(() => {
    if (monoFont === null) return null;
    // A settled field is the ordinary case, and `planShelfLabels` answers null
    // for it — nothing moved and nothing was renamed. The native renderer
    // draws only flights, so without a standing-still one to draw it would
    // have no names and the canvas would fall back to the picture for want of
    // a label. The picture is unaffected: it keeps using its own settled path
    // once the relayout tween has finished.
    const planned =
      labelFromGroups.length === 0
        ? null
        : planShelfLabels(labelFromGroups, layout.groups, monoFont, nowMs);
    return planned ?? settledShelfLabelFlights(layout.groups, nowMs);
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
    // Retarget only what was actually interrupted. Now that a settled field
    // carries standing-still flights rather than none, "there was a previous
    // plan" is always true — but a plan that had reached 1 is not a flight in
    // the air, it is a name sitting on its cluster, and the new plan already
    // describes that as its own source. Capturing it anyway would sample the
    // contours of every label in the field on every re-cut to morph each name
    // into itself.
    const interrupted = lastLabelLinear.current < 1;
    labelPlan.current = {
      generation: transitionGeneration,
      flights:
        interrupted && previous?.flights != null && semanticLabelFlights != null
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
  /**
   * The camera the picture is *recorded* at, which is not the camera it is
   * *shown* at.
   *
   * Once the transform below exists, re-recording for every camera frame stops
   * being what makes the field move and becomes only what keeps the culling
   * honest — so it can happen far less often. That matters for more than the
   * frame budget: a new picture is a new element, and the note below this one
   * explains what a new element costs. Holding the recording still through a
   * pan is what keeps the canvas from being re-rendered behind the animation.
   *
   * A re-record is owed when the camera has drifted far enough that the
   * overscan margin might no longer cover what has come on screen, or when the
   * scale has moved enough for the representation bands to be visibly wrong.
   */
  const recordCamera = useRecordCamera(
    drawCamera(camera, cameraShared, viewport),
    viewport,
  );

  const nativeField =
    activeLensKey === 'name' &&
    recut !== null &&
    isNativeDrawnDistance(recut.fromCamera.scale, recut.fromFitScale) &&
    isNativeDrawnDistance(recut.toCamera.scale, recut.toFitScale) &&
    isNativeDrawnDistance(recordCamera.scale, renderFitScale) &&
    nativeClock !== null &&
    monoFont !== null &&
    displayFont !== null &&
    songTitleFont !== null &&
    songMetaFont !== null &&
    labelFlights !== null &&
    recut.flights.every(flight => presentations.has(flight.entityKey));
  const paints = useMemo(() => createPaints(palette), [palette]);
  /**
   * The camera the next picture will be recorded at.
   *
   * Written inside the memo rather than from an effect, and read only by the
   * worklet below. An effect would run *after* the commit that painted the new
   * picture, so for one frame the transform would be measured from the camera
   * of the picture before it — the whole field jumping by exactly the distance
   * the pan had covered since the last re-record.
   *
   * And written *before* the early return, not after it, which is the L0→L1
   * crossing. While the native path owns the canvas there is no picture to
   * correct — but Skia's redraw plays its first frame from the values the JS
   * thread holds and only then starts the mapper, so the frame that introduces
   * the picture is painted at whatever this last said. Left behind at the
   * camera of the last picture recorded, that is wherever the field was the
   * last time you were at L1: the first frame of the crossing lands at the
   * previous shelf and the next one snaps back. Kept level with the record
   * camera, the transform is identity the instant the picture appears, which
   * is the whole point of recording against the live camera.
   */
  const pictureCamera = useSharedValue<Camera>(camera);
  const picture = useMemo(() => {
    pictureCamera.value = recordCamera;
    if (
      nativeField ||
      displayFont === null ||
      bodyFont === null ||
      monoFont === null
    ) {
      return null;
    }
    return recordFieldPicture({
      layout,
      placements,
      camera: recordCamera,
      viewport,
      presentations,
      jobs,
      palette,
      playingKey,
      focusKey,
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
    displayFont,
    grain,
    jobs,
    labelFlights,
    layout,
    monoFont,
    nowMs,
    nativeField,
    relayoutLinear,
    renderFitScale,
    paints,
    palette,
    placements,
    focusKey,
    playingKey,
    playingProgress,
    pictureCamera,
    presentations,
    recordCamera,
    viewport,
  ]);

  /**
   * The camera's motion, carried on the UI thread.
   *
   * Why panning at L1 was coarser than at L0: L0 has `NativeFieldContent`
   * reading `cameraShared` directly, and every level closer fell back to a
   * picture that could only move by being recorded again — on the JS thread,
   * once per React commit, throttled by `mirrorBusy`. `pictureTransformFor` is
   * what replaces that. Identity is stable across renders on purpose; the note
   * on `scene` explains what a fresh element would cost here.
   */
  const pictureTransform = useDerivedValue(
    () => pictureTransformFor(pictureCamera.value, cameraShared.value, viewport),
    // Explicit, and all three stable: the two shared values are refs and the
    // viewport only changes on a rotation. Left implicit, the plugin would
    // infer the same list — but the identity of this value is what holds the
    // scene element still, so it is worth saying out loud rather than
    // inheriting from whatever the closure happened to capture.
    [cameraShared, pictureCamera, viewport],
  );

  /**
   * The box the shelf is read inside, held by identity like everything else on
   * this canvas that outlives a camera frame.
   */
  const veil = useMemo(
    () => (
      <ShelfVeil
        cameraShared={cameraShared}
        colour={palette.bg}
        fitScaleShared={fitScaleShared}
        viewport={viewport}
      />
    ),
    [cameraShared, fitScaleShared, palette.bg, viewport],
  );

  /**
   * The scene element, held by identity.
   *
   * Skia's canvas re-renders its children through `root.render(children)` in a
   * layout effect keyed on the *element*, and the reanimated container's
   * `redraw` stops the animation mapper, re-records the tree from the values
   * the JS thread happens to hold, paints that frame, and only then restarts
   * the mapper. So any React render that hands the canvas a fresh element
   * paints one frame of every node at its last JS-thread value — which, while
   * the UI thread owns the camera, is a stale one. That is the flicker: not a
   * node losing its place, the whole canvas being redrawn behind the animation
   * for a frame. A pan mirrors a camera into React, a playing song ticks the
   * playhead, a library refresh lands — each was a flicker.
   *
   * Nothing here reads the camera: the scene is a function of the re-cut, and
   * the camera reaches it through `cameraShared` on the UI thread. So the
   * element only has to change when the re-cut does.
   */
  const nativeScene = useMemo(() => {
    if (
      recut === null ||
      nativeClock === null ||
      monoFont === null ||
      displayFont === null ||
      songTitleFont === null ||
      songMetaFont === null
    ) {
      return null;
    }
    // One fragment rather than two children on the canvas: `Canvas` re-renders
    // on the identity of what it is handed, and a second child would make that
    // an array built fresh on every render — the flicker the note above
    // describes, on every commit rather than never.
    return (
      <>
        <NativeFieldContent
          key={recut.generation}
          recut={recut}
          clock={nativeClock}
          cameraShared={cameraShared}
          fitScaleShared={fitScaleShared}
          viewport={viewport}
          presentations={presentations}
          playingKey={playingKey}
          focusKey={focusKey}
          transportLabel={transportLabel}
          positionSeconds={positionSeconds}
          analyses={analyses}
          labelFlights={labelFlights}
          displayFont={displayFont}
          songTitleFont={songTitleFont}
          songMetaFont={songMetaFont}
          font={monoFont}
          palette={palette}
        />
        {veil}
      </>
    );
  }, [
    analyses,
    cameraShared,
    displayFont,
    fitScaleShared,
    focusKey,
    labelFlights,
    monoFont,
    nativeClock,
    palette,
    playingKey,
    positionSeconds,
    presentations,
    recut,
    songMetaFont,
    songTitleFont,
    transportLabel,
    veil,
    viewport,
  ]);

  /**
   * The one thing on this canvas that moves without the camera moving.
   *
   * Held by identity and fed only shared values, for the reason the note above
   * gives: an element that changes on a React render repaints every node from
   * whatever the JS thread last held.
   */
  const playhead = useMemo(() => {
    if (
      positionSeconds === null ||
      focusKey === null ||
      viewport === null ||
      renderFitScale === undefined ||
      renderFitScale <= 0
    ) {
      return null;
    }
    const held = placements.find(placement => placement.key === focusKey);
    if (held === undefined) return null;
    const presentation = presentations.get(held.entityKey);
    if (presentation === undefined) return null;
    return (
      <NativePlayhead
        cameraShared={cameraShared}
        colour={palette.ink}
        durationSeconds={presentation.song.duration_ms / 1000}
        fitScale={renderFitScale}
        levels={levelsOf(analyses?.get(held.entityKey))}
        positionSeconds={positionSeconds}
        viewport={viewport}
      />
    );
  }, [
    analyses,
    cameraShared,
    focusKey,
    palette.ink,
    placements,
    positionSeconds,
    presentations,
    renderFitScale,
    viewport,
  ]);

  /**
   * The picture, its paper and its playhead as one element held by identity.
   *
   * This is the whole point of the transform above. Skia re-renders its
   * children through `root.render(children)` keyed on the *element*, so a fresh
   * one on every camera frame would re-record the node tree from JS-thread
   * values and repaint it — which is the flicker the note above describes, and
   * which a `transform` fed by a shared value would walk straight into. While
   * the camera is only moving, `picture` is the same object, `pictureTransform`
   * has stable identity, and this memo hands back the same element: nothing
   * re-renders, and the UI thread carries the motion alone. Exactly how L0 has
   * always worked, now for every level.
   */
  const scene = useMemo(
    () => (
      <>
        {/*
          Under the picture rather than inside it. The recording's own
          `drawColor` fills its bounds, which are the viewport — so the moment
          the picture is translated, the paper would move with it and leave the
          canvas showing through at the edge it came from.
        */}
        <Fill color={palette.bg} />
        {picture === null ? null : grain !== null ? (
          // L3 is drawn from the viewport, not from the camera: the grain
          // fills the screen and the camera decides which *samples* it holds,
          // not where they sit. Transforming it would slide the waveform under
          // a pan that is supposed to be scrubbing through it.
          <Picture picture={picture} />
        ) : (
          <SkiaGroup transform={pictureTransform}>
            <Picture picture={picture} />
          </SkiaGroup>
        )}
        {playhead}
        {veil}
      </>
    ),
    [grain, palette.bg, picture, pictureTransform, playhead, veil],
  );

  if (nativeField) {
    return (
      <Canvas
        importantForAccessibility="no-hide-descendants"
        opaque
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        {nativeScene}
      </Canvas>
    );
  }

  return (
    <Canvas
      importantForAccessibility="no-hide-descendants"
      opaque
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      {scene}
    </Canvas>
  );
}

/**
 * How far the camera may drift before the picture owes a re-recording.
 *
 * The translation threshold is well inside `OVERSCAN_PX`, so a mark that comes
 * on screen was already recorded before it was needed. The scale threshold is
 * the point where holding the representation bands still would start to read as
 * the wrong drawing rather than as a slightly early one.
 */
const RECORD_DRIFT = {
  TRANSLATION_PX: FIELD_CANVAS_KNOBS.OVERSCAN_PX / 2,
  /**
   * Tight, and it has to be — much tighter than the translation threshold.
   *
   * The transform can carry a *position*, exactly. What it cannot carry is
   * anything the recording computed **from** the scale: the gather between a
   * bloomed cluster and its column, and the representation bands that fade a
   * dot into a row. Those step once per recording while the frame around them
   * scales continuously, and relative motion is far more visible than slow
   * motion — a mark that jumps 19 px against a smoothly moving background
   * reads as a flicker, which is what 3% bought at the L1→L0 gather.
   *
   * At 0.5% that jump is under 3 px, and the cost is only paid where the scale
   * is actually moving. A pan does not move it at all, which is the case this
   * whole transform exists for: recordings there stay as rare as the
   * translation threshold allows.
   */
  SCALE_RATIO: 1.005,
} as const;

/**
 * The camera to record at: the last one recorded, until it is too far away.
 *
 * Returned by identity, so a caller's `useMemo` naturally does nothing while
 * the camera is only moving. The comparison is in *screen* pixels — a world
 * distance means nothing without a scale to read it at.
 */
function useRecordCamera(camera: Camera, viewport: Viewport): Camera {
  const held = useRef<{ camera: Camera; viewport: Viewport }>({
    camera,
    viewport,
  });
  const previous = held.current;
  // A rotation changes what the overscan covers, so a recording made for the
  // other orientation is stale however still the camera has been.
  const resized =
    previous.viewport.width !== viewport.width ||
    previous.viewport.height !== viewport.height;
  const drifted =
    resized ||
    !(previous.camera.scale > 0) ||
    !(camera.scale > 0) ||
    Math.abs(camera.x - previous.camera.x) * camera.scale >
      RECORD_DRIFT.TRANSLATION_PX ||
    Math.abs(camera.y - previous.camera.y) * camera.scale >
      RECORD_DRIFT.TRANSLATION_PX ||
    camera.scale > previous.camera.scale * RECORD_DRIFT.SCALE_RATIO ||
    camera.scale * RECORD_DRIFT.SCALE_RATIO < previous.camera.scale;
  if (drifted) {
    held.current = { camera, viewport };
  }
  return held.current.camera;
}

/**
 * The playhead: an arc that fills and a hand that sweeps, both at frame rate.
 *
 * Progress *is* the ring, so it has to move like one. The waveform behind it is
 * recorded once per camera change and never re-recorded for time; only these
 * two paths answer to the clock, and they answer on the UI thread — the arc by
 * trimming a circle it never rebuilds, the hand by rotating a line it never
 * rebuilds. Nothing here is a function of a React render.
 */
/**
 * The measured loudness a song that is not the player carries: none.
 *
 * One frozen array rather than a fresh `[]` per render, because this is a prop
 * on every mark in the field and a new identity would re-render each of them on
 * every commit.
 */
const EMPTY_LEVELS: readonly number[] = Object.freeze([]);

/** The measured loudness as plain numbers; a worklet cannot hold a typed array. */
function levelsOf(analysis: SongAnalysis | undefined): readonly number[] {
  if (analysis === undefined) return [];
  return Array.from(analysis.rms);
}

function NativePlayhead({
  cameraShared,
  positionSeconds,
  viewport,
  fitScale,
  durationSeconds,
  levels,
  colour,
}: {
  cameraShared: SharedValue<Camera>;
  positionSeconds: SharedValue<number>;
  viewport: Viewport;
  fitScale: number;
  durationSeconds: number;
  /** The song's measured loudness, as plain numbers a worklet can hold. */
  levels: readonly number[];
  colour: string;
}) {
  /**
   * The picture path's anchor: the middle of the view.
   *
   * The native path hangs the same ring off the song's own mark instead, which
   * is the truer answer and the one that stays concentric with the face on the
   * way in. Here there is no mark to hang it off — a recording knows where
   * things were when it was made, not where they are — so it is drawn where
   * arriving at a song puts them, and this path only runs where the native one
   * cannot: a lens other than the name, or a font that has not loaded.
   */
  const centre = useMemo<Transforms3d>(
    () => [
      { translateX: viewport.width / 2 },
      {
        translateY:
          viewport.height / 2 -
          playerRisePx(viewport.height, 1),
      },
    ],
    [viewport.height, viewport.width],
  );

  // The song band, inlined: `representationAlphas` is not a worklet, and the
  // player's own opacity must not come through React either.
  const [fadeIn, holdFrom, holdTo, fadeOut] = REPRESENTATION_WINDOWS.song;
  const opacity = useDerivedValue(() => {
    const ratio = cameraShared.value.scale / fitScale;
    if (ratio <= fadeIn || ratio >= fadeOut) return 0;
    const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    if (ratio < holdFrom) return ease((ratio - fadeIn) / (holdFrom - fadeIn));
    if (ratio > holdTo) return 1 - ease((ratio - holdTo) / (fadeOut - holdTo));
    return 1;
  }, [fadeIn, fadeOut, fitScale, holdFrom, holdTo]);

  return (
    <SkiaGroup opacity={opacity} transform={centre}>
      <PlayerRing
        colour={colour}
        durationSeconds={durationSeconds}
        levels={levels}
        positionSeconds={positionSeconds}
        radius={playerRadiusPx(viewport.width)}
      />
    </SkiaGroup>
  );
}

/**
 * The camera scale this frame, whether the re-cut or the finger owns it.
 *
 * Defined above every worklet that calls it: the worklets plugin captures a
 * `'worklet'` helper into its caller's closure where the caller is written, so
 * one written below arrives as `undefined`. The same rule the band maths in
 * `bands.ts` is ordered by.
 */
type NativeRecut = Pick<
  FieldRecutModel,
  'fromCamera' | 'toCamera' | 'fromFitScale' | 'toFitScale'
>;

function nativeCameraScale(
  progress: number,
  recut: NativeRecut,
  cameraShared: SharedValue<Camera>,
): number {
  'worklet';
  if (progress >= 1) return cameraShared.value.scale;
  return Math.exp(
    Math.log(recut.fromCamera.scale) +
      (Math.log(recut.toCamera.scale) - Math.log(recut.fromCamera.scale)) *
        progress,
  );
}

/**
 * FIT this frame, which is what every band and the gather are measured against.
 *
 * A re-cut can change the fit as well as the seats — a year is framed at a
 * different distance than a week — so a band read against the settled fit
 * while the field is still travelling to it would open early at one end of the
 * cut and late at the other.
 */
function nativeFitScale(
  progress: number,
  recut: NativeRecut,
  fitScaleShared: SharedValue<number>,
): number {
  'worklet';
  if (progress >= 1) return fitScaleShared.value;
  return Math.exp(
    Math.log(recut.fromFitScale) +
      (Math.log(recut.toFitScale) - Math.log(recut.fromFitScale)) * progress,
  );
}

/**
 * How much of a mark or a name this generation has handed over.
 *
 * The ownership windows are the transition engine's, not the camera's: a mark
 * that branches appears early in the cut and one that folds leaves late, so
 * two copies of the same song are never both solid at once.
 */
function flightOwnerAlpha(
  ownership: FlightOwnership,
  fromAlpha: number,
  targetAlpha: number,
  progress: number,
): number {
  'worklet';
  let start = 0;
  let end = 1;
  if (ownership === 'branch') {
    start = 0.02;
    end = 0.18;
  } else if (ownership === 'fold') {
    start = 0.55;
    end = 0.82;
  } else if (ownership === 'enter') {
    start = 0.08;
    end = 0.42;
  } else if (ownership === 'exit') {
    start = 0.58;
    end = 0.9;
  }
  const raw =
    ownership === 'carry' ? progress : (progress - start) / (end - start);
  const t = Math.min(Math.max(raw, 0), 1);
  const amount = t * t * t * (t * (t * 6 - 15) + 10);
  return fromAlpha + (targetAlpha - fromAlpha) * amount;
}

// These camera-only values are identical for every song. Install their
// mappers once per generation, rather than once per placement.
function useNativeCameraMotion(
  clock: SharedValue<number>,
  recut: NativeRecut,
  cameraShared: SharedValue<Camera>,
  fitScaleShared: SharedValue<number>,
) {
  const zero = useSharedValue(0);
  const one = useSharedValue(1);
  const scale = useDerivedValue(() =>
    nativeCameraScale(clock.value, recut, cameraShared),
  );
  const fit = useDerivedValue(() =>
    nativeFitScale(clock.value, recut, fitScaleShared),
  );
  const becomingRow = useDerivedValue(() =>
    bandAlphaAt(scale.value, fit.value, REPRESENTATION_WINDOWS.row),
  );
  const shapeArrived = useDerivedValue(() =>
    songShapeArrival(scale.value, fit.value),
  );
  const nameArrived = useDerivedValue(() =>
    songNameArrival(scale.value, fit.value),
  );
  const arrived = useDerivedValue(() =>
    bandAlphaAt(scale.value, fit.value, REPRESENTATION_WINDOWS.song),
  );
  const playerLineInk = useDerivedValue(() =>
    1 - lineOwnedByPlayer(nameArrived.value),
  );
  const rowOnly = useDerivedValue(() => 1 - arrived.value);
  const walked = useDerivedValue(() => faceArrival(scale.value, fit.value));
  const written = useDerivedValue(() => nameArrival(scale.value, fit.value));
  return {
    zero, one, becomingRow, shapeArrived, nameArrived, arrived,
    playerLineInk, rowOnly, walked, written,
  };
}

type NativeCameraMotion = ReturnType<typeof useNativeCameraMotion>;

type NativeFieldContentProps = Readonly<{
  recut: FieldRecutModel;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  presentations: ReadonlyMap<string, FieldPresentation>;
  playingKey: string | null;
  /** The song the camera is focused on: the one that is allowed to be a player. */
  focusKey: string | null;
  /** What pressing the transport would do, in the player's own words. */
  transportLabel: string;
  positionSeconds: SharedValue<number> | null;
  analyses: ReadonlyMap<string, SongAnalysis> | undefined;
  labelFlights: ShelfLabelFlights | null;
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>;
  songTitleFont: NonNullable<ReturnType<typeof useMorphFont>>;
  songMetaFont: NonNullable<ReturnType<typeof useMorphFont>>;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
  palette: Palette;
}>;

/**
 * L0 and L1's hot path. The family is built once per re-cut; Reanimated then
 * updates Skia properties on the UI runtime without a React render or Fabric
 * commit.
 *
 * Why this draws rows and not only marks: a recorded picture moves by being
 * *scaled*, and a row is measured entirely in screen pixels — a 240×30 box, a
 * 15 px title, a 9 px meta line. Scaling the recording inflates every one of
 * them, and the recording can only be remade once per React commit, so a zoom
 * swells the rows on screen and snaps them back at each new recording. That is
 * invisible under a pan, where the scale factor is exactly 1, and it is the
 * whole of what a zoom looked like. `bands.ts` and `bloom.ts` are worklets for
 * this: the band alphas and the gather are read from the live camera on the
 * frame they are drawn on, so a row is the size it is meant to be on every
 * frame rather than only on the ones React kept up with.
 */
const NativeFieldContent = React.memo(function NativeFieldContent({
  recut,
  clock,
  cameraShared,
  fitScaleShared,
  viewport,
  presentations,
  playingKey,
  focusKey,
  transportLabel,
  positionSeconds,
  analyses,
  labelFlights,
  displayFont,
  songTitleFont,
  songMetaFont,
  font: monoFont,
  palette,
}: NativeFieldContentProps) {
  // Canvas reconciles its children in a separate React root. Starting this
  // clock in FieldCanvas's layout effect spends the flight while that root is
  // still building glyphs and installing mappers. Start after this generation's
  // child effects instead, when the drawing can follow the entire clock.
  useEffect(() => {
    if (!recut.animate || clock.value >= 1) return;
    clock.value = withTiming(1, {
      duration: FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      easing: nativeSmootherstep,
    });
  }, [clock, recut]);
  // Worklets need camera endpoints, not the entire layout and flight family.
  const nativeRecut = useMemo<NativeRecut>(() => ({
    fromCamera: recut.fromCamera,
    toCamera: recut.toCamera,
    fromFitScale: recut.fromFitScale,
    toFitScale: recut.toFitScale,
  }), [recut]);
  const motion = useNativeCameraMotion(
    clock, nativeRecut, cameraShared, fitScaleShared,
  );
  return (
    <>
      <Fill color={palette.bg} />
      {(labelFlights ?? []).map((flight, index) => (
        <NativeShelfLabel
          key={`${flight.fromGroupKey ?? 'new'}:${
            flight.toGroupKey ?? 'gone'
          }:${index}`}
          flight={flight}
          clock={clock}
          cameraShared={cameraShared}
          fitScaleShared={fitScaleShared}
          recut={nativeRecut}
          viewport={viewport}
          font={monoFont}
          palette={palette}
        />
      ))}
      {recut.flights.map(flight => {
        const presentation = presentations.get(flight.entityKey);
        if (presentation === undefined) return null;
        const song = presentation.song;
        const recipe = {
          seed: song.seed,
          id: presentation.entity.entityId,
          model: song.model,
          durationMs: song.duration_ms,
        };
        // A face keeps what it promises while it flies. Weighting the flight
        // the way the picture weights the mark is what stops a downloaded song
        // from emptying out on its way to a new seat and filling again when it
        // lands.
        const availability = availabilityOf(presentation.localAudio.state);
        const row = nativeRowModel(presentation, recipe, displayFont, monoFont);
        /*
         * Exactly one song in the field is the player, so exactly one flight
         * pays for the sampling `nativeSongModel` does. Every other mark is the
         * two nodes it has always been.
         *
         * Matched on the *placement* the flight is landing on, not on the
         * entity: one song can sit in several groups at once — a date mark and
         * a playlist membership are two placements of one entity — and only the
         * one the camera actually arrived at is the player. `focusKey` is a
         * placement key for the same reason, which is what the picture compares
         * against too. An outgoing copy carries a null target and so can never
         * be it, which is right: a mark on its way out of the field is not
         * somewhere you have arrived.
         */
        const focused =
          focusKey !== null && flight.targetPlacementKey === focusKey;
        return (
          <NativePlacementFlight
            key={flight.key}
            motion={motion}
            flight={flight}
            clock={clock}
            cameraShared={cameraShared}
            fitScaleShared={fitScaleShared}
            recut={nativeRecut}
            viewport={viewport}
            markPath={nameLensFacePath(
              recipe,
              NAME_LENS_KNOBS.MARK_RADIUS_PX,
            )}
            row={row}
            song={
              focused
                ? nativeSongModel(
                    presentation,
                    viewport,
                    row.title,
                    row.meta,
                    row.action === null
                      ? 0
                      : monoFont.measureText(row.action).width,
                    {
                      rowTitle: displayFont,
                      songTitle: songTitleFont,
                      rowMeta: monoFont,
                      songMeta: songMetaFont,
                    },
                    transportLabel,
                  )
                : null
            }
            songTitleFont={songTitleFont}
            songMetaFont={songMetaFont}
            positionSeconds={focused ? positionSeconds : null}
            levels={focused ? levelsOf(analyses?.get(flight.entityKey)) : EMPTY_LEVELS}
            durationSeconds={song.duration_ms / 1000}
            displayFont={displayFont}
            monoFont={monoFont}
            playing={flight.entityKey === playingKey}
            color={palette.ink}
            mutedColor={palette.muted}
            weight={FACE_STROKE_ALPHA[availability]}
            filled={FACE_FILL_ALPHA[availability] > 0}
          />
        );
      })}
    </>
  );
});

/**
 * Everything about a row that does not answer to the camera.
 *
 * The strings, the cut and the widths are a function of the song and the fonts
 * alone, so they are settled once per re-cut on the JS thread and the UI thread
 * only moves and fades what comes out of here. The measuring is the reason:
 * `fitText` searches the proportional display face for the longest prefix that
 * fits, which is not something to do on a frame.
 *
 * The offsets are `nameLens`'s own knobs, and the strings come from the same
 * two functions the lens calls, because a row that changed shape when the
 * renderer changed would be a different row.
 */
/**
 * A line of text as one exact outline per glyph, at the baseline it is drawn on.
 *
 * One path per letter and not one per line, because the pen is per letter:
 * `Write` is `DrawBorderThenFill` *with a lag ratio*, and a lag needs something
 * to lag between. It is also what makes the trace affordable — see the pen in
 * `NativePlacementFlight`.
 *
 * `layoutText` walks the string with the same advances `SkFont.measureText`
 * accumulates, which is what the `Text` node draws with, so the letter traced
 * at `x` and the letter that replaces it are the same ink in the same place —
 * the whole reason DrawBorderThenFill can hand over without a seam. Spaces
 * carry no box and so no pen stroke; Manim counts the same family.
 *
 * The answer is *checked* rather than trusted. Only native Skia implements
 * `Path.MakeFromText`; CanvasKit — which is what Jest runs — neither implements
 * it nor refuses, it answers with a stub that is not a path at all. Handing
 * that to a `Path` node is a blank title rather than an error, so anything
 * without a path's own method is treated as no outline, and the row falls back
 * to fading its glyphs in the way it did before it could write.
 */
function titleTracePaths(
  text: string,
  typeface: NonNullable<ReturnType<typeof useMorphFont>>,
  x: number,
  baselineY: number,
): readonly SkPath[] | null {
  if (text.length === 0) return null;
  const paths: SkPath[] = [];
  // One line, always: the title is already cut to its column by `fitText`, so
  // there is nothing left for a wrap to do.
  for (const box of layoutText(text, typeface, 0, Infinity, 0)) {
    let path: SkPath | null;
    try {
      path = Skia.Path.MakeFromText(box.ch, x + box.x, baselineY, typeface);
    } catch {
      return null;
    }
    if (path == null || typeof path.toSVGString !== 'function') return null;
    paths.push(path);
  }
  return paths.length === 0 ? null : paths;
}

type NativeRowModel = Readonly<{
  action: string | null;
  actionX: number;
  title: string;
  /**
   * The title's exact glyph outlines, one per letter, at the baseline and the
   * x the row draws each of them on.
   *
   * What the name is traced from on the way in. Null where Skia cannot give an
   * outline — CanvasKit has no `MakeFromText` — and the caller falls back to
   * fading the real glyphs, which is what the row did before it could write.
   */
  titleTrace: readonly SkPath[] | null;
  titleAlpha: number;
  meta: string;
}>;

function nativeRowModel(
  presentation: FieldPresentation,
  recipe: Parameters<typeof nameLensFacePath>[0],
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>,
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>,
): NativeRowModel {
  const availability = availabilityOf(presentation.localAudio.state);
  // The action word is right-aligned against the row's edge and the title is
  // cut to whatever is left, so a long title cannot run under the word that
  // acts on it. Both are measured from the row's own point, which is the
  // origin of the group the UI thread moves.
  const action = availabilityAction(availability);
  const titleLeft = -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX;
  const rowRight = NAME_LENS_KNOBS.ROW_RIGHT_PX;
  const actionWidth =
    action === null ? 0 : monoFont.measureText(action).width;
  const titleRight =
    action === null
      ? rowRight
      : rowRight - actionWidth - NAME_LENS_KNOBS.ROW_TITLE_GAP_PX;
  const column = titleRight - titleLeft;
  const title = fitText(presentation.song.title, displayFont, column);
  return {
    action,
    actionX: rowRight - actionWidth,
    title,
    titleTrace: titleTracePaths(
      title,
      displayFont,
      titleLeft,
      NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
    ),
    // A song that is not on the phone says so twice: in the weight of its face
    // and in the weight of its name.
    titleAlpha:
      availability === 'cached' || availability === 'downloaded'
        ? 1
        : NAME_LENS_KNOBS.ROW_TITLE_AWAY_ALPHA,
    meta: fitText(
      // Cut to the same column as the title: `CACHED · MAY BE RECLAIMED` is
      // the longest line here and it must not run under the action word.
      availabilityLine({
        audioState: presentation.localAudio.state,
        arriving: arrivingFraction(
          presentation.localAudio.bytes,
          presentation.delivery?.byte_length,
        ),
        byteLength: presentation.delivery?.byte_length ?? null,
        nodeLabel: presentation.nodeLabels[0] ?? presentation.backend.petname,
      }),
      monoFont,
      column,
    ),
  };
}

/** One mapper and draw node per title, retaining the per-letter pen lag. */
function TracedTitle({
  paths,
  written,
  color,
}: {
  paths: readonly SkPath[];
  written: SharedValue<number>;
  color: SkColor | string;
}) {
  const path = useDerivedValue(() => traceTitlePath(paths, written.value));
  return (
    <Path
      path={path}
      color={color}
      style="stroke"
      strokeWidth={ROW_ARRIVAL_KNOBS.TRACE_STROKE_PX}
      strokeCap="round"
      strokeJoin="round"
    />
  );
}

/**
 * One song, at whichever of its two representations the camera is showing.
 *
 * The mark and the row share an anchor and a flight and differ only in what
 * hangs off it, so this is one node with two bands rather than two nodes that
 * would have to be held on the same point by hand. Both bands stay mounted and
 * the camera decides which is visible: a band that appeared when React noticed
 * the scale had moved would arrive a commit late, which is the whole failure
 * this renderer exists to end.
 */
function NativePlacementFlight({
  motion,
  flight,
  clock,
  cameraShared,
  fitScaleShared,
  recut,
  viewport,
  markPath,
  row,
  song,
  songTitleFont,
  songMetaFont,
  positionSeconds,
  levels,
  durationSeconds,
  displayFont,
  monoFont,
  playing,
  color,
  mutedColor,
  weight,
  filled,
}: {
  motion: NativeCameraMotion;
  flight: PlacementFlight;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  recut: NativeRecut;
  viewport: Viewport;
  markPath: SkPath;
  row: NativeRowModel;
  /**
   * The player, for the one song the camera is focused on, and null for every
   * other song in the field.
   *
   * Null is what keeps this O(1) in the size of the library: only one song is
   * ever the player, so only one flight in the field mounts the extra nodes.
   * Building them for every song would put a ring, a waveform and two morphing
   * lines on the canvas for each of a hundred thousand marks, which is the one
   * way this change could have cost anything at scale.
   */
  song: NativeSongModel | null;
  songTitleFont: NonNullable<ReturnType<typeof useMorphFont>>;
  songMetaFont: NonNullable<ReturnType<typeof useMorphFont>>;
  positionSeconds: SharedValue<number> | null;
  levels: readonly number[];
  durationSeconds: number;
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>;
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>;
  playing: boolean;
  color: string;
  mutedColor: string;
  /** The availability alpha the picture would draw this face at. */
  weight: number;
  /** True for a downloaded song, whose face is filled rather than outlined. */
  filled: boolean;
}) {
  const titleAlpha = row.titleAlpha;
  /**
   * Where this song is, this frame.
   *
   * Two blends, and they are not the same one. `p` is the re-cut clock, which
   * carries a mark from the seat it had to the seat it is getting. The gather
   * is the *camera's* answer to how far the cluster has closed, and it applies
   * to whichever seat the re-cut has reached — so a re-sort during a zoom moves
   * the seat while the zoom closes the bloom around it, instead of one of the
   * two winning.
   */
  const transform = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    const liveCamera = p >= 1 ? cameraShared.value : null;
    const cameraX =
      liveCamera?.x ??
      recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p;
    const cameraY =
      liveCamera?.y ??
      recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p;
    const cameraScale = nativeCameraScale(p, recut, cameraShared);
    const bloom =
      1 - gatherFraction(cameraScale, nativeFitScale(p, recut, fitScaleShared));
    const seatX = flight.fromX + (flight.targetX - flight.fromX) * p;
    const seatY = flight.fromY + (flight.targetY - flight.fromY) * p;
    const bloomX =
      flight.fromBloomX + (flight.targetBloomX - flight.fromBloomX) * p;
    const bloomY =
      flight.fromBloomY + (flight.targetBloomY - flight.fromBloomY) * p;
    return [
      {
        translateX:
          (seatX + bloomX * bloom - cameraX) * cameraScale + viewport.width / 2,
      },
      {
        translateY:
          (seatY + bloomY * bloom - cameraY) * cameraScale +
          viewport.height / 2,
      },
    ];
  });
  /** How much of this mark the re-cut has handed over, before any band. */
  const owner = useDerivedValue(() =>
    flightOwnerAlpha(
      flight.ownership,
      flight.fromAlpha,
      flight.targetAlpha,
      Math.min(Math.max(clock.value, 0), 1),
    ),
  );
  /**
   * How much of a row this song is, this frame: the row band, alone.
   *
   * The one number the whole L0 → L1 gesture is written against. It is not the
   * row's opacity — the parts of a row *arrive* differently — so it is kept
   * separate from the row's own opacities rather than being recovered by
   * dividing one of them back out by the owner.
   */
  const becomingRow = motion.becomingRow;
  /**
   * How much of the player this song is, this frame: the song band, alone.
   *
   * The third pose's own number, and the counterpart of `becomingRow`. Every
   * part of the player is written against it — the face's growth, the ring's
   * rise, the name's morph — so the whole drawing arrives as one object on one
   * clock. This is the number the React chrome used to read a commit late from
   * its own copy of the camera.
   */
  const isPlayer = song !== null;
  /**
   * The player's two beats, and the band that is neither of them.
   *
   * `arrived` is the crossfade band: *how present* the player is, which is what
   * fades the ring up and takes the row's own second voice away. The two
   * arrivals below are *where things are* — the pose — and they are deliberately
   * not the same number. A band is built to hand one drawing over to another;
   * it makes a poor clock for a journey, because it is measured in linear ratio
   * and eased a second time on top of the camera's own easing. Written against
   * it, every part of the player stood still for the first half of a descent
   * and then crossed the screen at once.
   *
   * Shape first, then the name. See `SONG_ARRIVAL`.
   */
  const shapeArrived = isPlayer ? motion.shapeArrived : motion.zero;
  const nameArrived = isPlayer ? motion.nameArrived : motion.zero;
  const arrived = isPlayer ? motion.arrived : motion.zero;
  /**
   * Whether the row's own ink has handed its line to the morph.
   *
   * A step rather than a fade, and it has to be: the morph's `t = 0` pose *is*
   * the row's line, drawn from the same font at the same baseline, so the two
   * are the same pixels at the instant this flips and nobody can see it happen.
   * Crossfading them instead would put two copies of one name on the screen at
   * half weight each through the whole crossing — which is what the player did
   * before it was drawn here, said one layer deeper.
   */
  const titleHandedOver = song?.titleMorph != null;
  const metaHandedOver = song?.metaMorph != null;
  const rowTitleInk = titleHandedOver ? motion.playerLineInk : motion.one;
  const rowMetaInk = metaHandedOver ? motion.playerLineInk : motion.one;
  const rowOnly = isPlayer ? motion.rowOnly : motion.one;
  const walked = motion.walked;
  const written = motion.written;
  /**
   * The face's alpha — one face, across both bands.
   *
   * The dot and the row used to be two drawings of the same silhouette,
   * crossfaded: the mark faded out under a second face fading in at a larger
   * radius and a different x. Two objects where a person sees one, and at the
   * midpoint both were half transparent, so the shape went pale on its way to
   * becoming a row. `nameLensFacePath` is exactly linear in its radius, which
   * means the row's face *is* the mark's face at 1.2× — so there is one path,
   * one alpha, and the transform below carries it to its seat.
   *
   * The two bands overlap through the whole crossing, so their sum holds the
   * face solid; it can only go out where both go out, which is the level where
   * the picture takes the canvas back.
   */
  const faceOpacity = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    const scale = nativeCameraScale(p, recut, cameraShared);
    const fitted = nativeFitScale(p, recut, fitScaleShared);
    const dot = bandAlphaAt(scale, fitted, REPRESENTATION_WINDOWS.dot);
    return owner.value * Math.min(1, dot + becomingRow.value + arrived.value);
  });
  /**
   * The face's weight, which is not its opacity.
   *
   * Identity recedes as the measurement arrives. A mark is a promise about a
   * song and the player is what the song turned out to be, so the contour that
   * carried the whole identity at L0 goes quiet under the waveform at L2 rather
   * than competing with it — `SONG_FACE_ALPHA`, which is what `nameLens` draws
   * the player's face at. It is the same face the whole way; only how loudly it
   * is drawn changes.
   *
   * On the shape's own beat rather than on the band, so it recedes *as* it
   * grows. Fading on the band instead, it reached most of its full size while
   * still carrying a downloaded song's solid fill — a hand-sized block of black
   * in the middle of the screen for a third of the descent, which then emptied
   * out after it had arrived. A promise should get quieter on its way to
   * becoming a measurement, not once it is already one.
   */
  const faceWeight = useDerivedValue(
    () =>
      weight +
      (NAME_LENS_KNOBS.SONG_FACE_ALPHA - weight) * shapeArrived.value,
  );
  /** Only a downloaded song is filled, and only while it is small enough to be. */
  const faceFill = useDerivedValue(() => weight * (1 - shapeArrived.value));
  /**
   * Where that one face sits: the mark's own point at L0, the row's preview
   * seat at L1, the middle of the view at L2, and every point between on the
   * way.
   */
  const faceTransform = useDerivedValue(() => {
    const pose = facePoseAt(
      walked.value,
      shapeArrived.value,
      viewport,
      FACE_GROWTH,
    );
    return [
      { translateX: pose.x },
      { translateY: pose.y },
      { scale: pose.scale },
    ];
  });
  /** A hairline is a hairline at any size, so it is drawn back out of it. */
  const faceStrokeWidth = useDerivedValue(
    () =>
      FIELD_CANVAS_KNOBS.FACE_STROKE_PX /
      facePoseAt(walked.value, shapeArrived.value, viewport, FACE_GROWTH).scale,
  );
  /**
   * Where the player hangs: on the face, not on the mark.
   *
   * The *same* pose the face is drawn at, so the ring is concentric with the
   * contour on every frame of the way in and reads as growing out of it. Given
   * the rise alone it was concentric only at the ends: through the middle of
   * the flight the face was still out at its row seat while the ring had
   * already centred itself on the mark, and a ring that leaves its own face
   * behind is two objects again — which is the thing this was all for.
   */
  const playerAnchor = useDerivedValue<Transforms3d>(() => {
    const pose = facePoseAt(
      walked.value,
      shapeArrived.value,
      viewport,
      FACE_GROWTH,
    );
    return [{ translateX: pose.x }, { translateY: pose.y }];
  });
  const ringRadius = useDerivedValue(() => {
    const t = walked.value;
    return (
      MARK_RING_RADIUS_PX + (ROW_RING_RADIUS_PX - MARK_RING_RADIUS_PX) * t
    );
  });
  const ringCentreX = useDerivedValue(
    () =>
      -NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX * walked.value,
  );
  /*
   * The name, written on.
   *
   * `DrawBorderThenFill` from the motion engine, on the camera's own clock:
   * `writePhase` is the engine's, so the two halves and where they meet are
   * the engine's too, and `t` is the row band rather than a timer. That is what
   * makes it reversible — zoom back out and the fill lifts, the outline comes
   * back and un-traces itself. One gesture, both directions, and it is the
   * *camera* holding the pen, which is the only clock a person is driving here.
   *
   * `writeSubAlpha` is the engine's too: the per-glyph lag that makes `Write`
   * out of `DrawBorderThenFill`. It is what a person actually reads as writing
   * — letters arriving one after another under a moving pen — and without it
   * the line has no cascade at all.
   *
   * This was first built as one line-wide outline revealed through a clip box
   * that widened, to keep the cost at one rectangle per row. It does not read
   * as writing: the reveal edge is *straight*, so it cuts letters in half down
   * a vertical line and uncovers ink that is already fully formed. A mask
   * passing over finished text, which is what it looked like. Ink has to grow
   * along the letter's own shape, and that is a trim, not a box.
   *
   * The trim stays per letter, but one mapper assembles the visible strokes
   * into one path per title. Finished glyphs are appended without measuring;
   * only the letters under the pen are trimmed. Mounting a mapper and Skia
   * node for every letter used to stall even L0 regrouping, where all these
   * titles are invisible.
   *
   * The fill is line-wide even so. Manim fills each glyph as its own border
   * closes, which here would be three mappers a letter on a canvas that mounts
   * a node set for every song in the library. So the letters hold as outlines
   * until the last one is closed and the line resolves into real glyphs
   * together — `writeSubAlpha` at the final letter is exactly when that is.
   * At 15 px the difference is a fraction of a stroke width; the cascade, which
   * is what carries the gesture, is per letter where it matters.
   */
  const traceCount = row.titleTrace?.length ?? 0;
  const traceOpacity = useDerivedValue(
    () =>
      owner.value *
      titleAlpha *
      rowTitleInk.value *
      writePhase(writeSubAlpha(written.value, traceCount - 1, traceCount))
        .borderAlpha,
  );
  const titleOpacity = useDerivedValue(
    () =>
      owner.value *
      titleAlpha *
      rowTitleInk.value *
      writePhase(writeSubAlpha(written.value, traceCount - 1, traceCount))
        .fillAlpha,
  );
  /** The pre-write behaviour, kept for where an outline cannot be had. */
  const rowTitleFade = useDerivedValue(
    () => owner.value * titleAlpha * rowTitleInk.value * written.value,
  );
  /**
   * The row's second voice, which arrives with the name rather than before it.
   *
   * On the row band alone it would fade up under a face that is still crossing
   * the space it occupies, and the two lines of a row would arrive at two
   * different times for no reason a person could name.
   *
   * Two values now rather than one, because the two halves of that voice go
   * different ways at L2. `REMOVE` is a thing to do to a row and the player has
   * no such word, so it leaves; the availability line *becomes* the recipe, so
   * it hands over to the morph instead of fading.
   */
  const rowActionOpacity = useDerivedValue(
    () => owner.value * written.value * rowOnly.value,
  );
  const rowMetaOpacity = useDerivedValue(
    () => owner.value * written.value * rowMetaInk.value,
  );
  return (
    <SkiaGroup transform={transform}>
      {/*
        One face, from the dot to the row. It is the same path throughout —
        `markPath` — because the row's face is this one at `FACE_GROWTH`.
      */}
      <SkiaGroup opacity={faceOpacity}>
        <SkiaGroup transform={faceTransform}>
          {filled ? (
            <Path path={markPath} color={color} style="fill" opacity={faceFill} />
          ) : null}
          <Path
            path={markPath}
            color={color}
            style="stroke"
            strokeWidth={faceStrokeWidth}
            opacity={faceWeight}
          />
        </SkiaGroup>
        {/*
          Outside that group rather than inside it: the ring's radius is the
          face's extent *plus a gap*, so it is not a multiple of the face and a
          scale would carry the gap along with it.
        */}
        {playing ? (
          <SkiaGroup opacity={rowOnly}>
            <Circle
              cx={ringCentreX}
              cy={0}
              r={ringRadius}
              color={color}
              style="stroke"
              strokeWidth={NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX}
            />
          </SkiaGroup>
        ) : null}
      </SkiaGroup>
      {/*
        The name arrives by being written; the facts about it arrive by fading.
        A row is one name and two pieces of metadata, and writing all three at
        once would read as a machine typing rather than as a name being put
        down.
      */}
      {row.titleTrace === null ? null : (
        <SkiaGroup opacity={traceOpacity}>
          <TracedTitle
            paths={row.titleTrace}
            written={written}
            color={color}
          />
        </SkiaGroup>
      )}
      <Text
        text={row.title}
        x={-NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX}
        y={NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX}
        font={displayFont}
        color={color}
        opacity={row.titleTrace === null ? rowTitleFade : titleOpacity}
      />
      {row.action === null ? null : (
        <SkiaGroup opacity={rowActionOpacity}>
          <Text
            text={row.action}
            x={row.actionX}
            y={NAME_LENS_KNOBS.ROW_ACTION_BASELINE_PX}
            font={monoFont}
            color={mutedColor}
            opacity={NAME_LENS_KNOBS.ROW_ACTION_ALPHA}
          />
        </SkiaGroup>
      )}
      <SkiaGroup opacity={rowMetaOpacity}>
        <Text
          text={row.meta}
          x={-NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX}
          y={NAME_LENS_KNOBS.ROW_META_BASELINE_PX}
          font={monoFont}
          color={mutedColor}
        />
      </SkiaGroup>
      {/*
        The third pose, on the same anchor as the other two. It is inside this
        group rather than beside it because that is the whole claim: the player
        is not a screen that opens over the field, it is what this one mark
        looks like from here.
      */}
      {song === null ? null : (
        <NativePlayerParts
          arrived={arrived}
          named={nameArrived}
          colour={color}
          durationSeconds={durationSeconds}
          levels={levels}
          model={song}
          mutedColour={mutedColor}
          positionSeconds={positionSeconds}
          anchor={playerAnchor}
          songMetaFont={songMetaFont}
          songTitleFont={songTitleFont}
          viewport={viewport}
        />
      )}
    </SkiaGroup>
  );
}

/**
 * One cluster's name, carried by one animated value.
 *
 * Both lines ride a single group transform, and each glyph run sits at a fixed
 * offset inside it. Positioning the runs individually meant four shared values
 * per label — a screen anchor, two x's derived from it and a y — so a camera
 * frame reached the four Skia properties across two mapper hops instead of
 * one, and a pan tore the name apart between them. One value per node moves
 * like the faces do, and leaves the opacities off the camera's path entirely:
 * they answer to the clock, so a pan does not wake them at all.
 */
function NativeShelfLabel({
  flight,
  clock,
  cameraShared,
  fitScaleShared,
  recut,
  viewport,
  font: labelFont,
  palette,
}: {
  flight: LabelFlight;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  recut: NativeRecut;
  viewport: Viewport;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
  palette: Palette;
}) {
  const transform = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    const liveCamera = p >= 1 ? cameraShared.value : null;
    const cameraX =
      liveCamera?.x ??
      recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p;
    const cameraY =
      liveCamera?.y ??
      recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p;
    const cameraScale = nativeCameraScale(p, recut, cameraShared);
    // Seat to seat, in the same units at both ends. The previous generation
    // left this name on its cluster's top, which is exactly this flight's
    // `fromTop`, so the first frame lands where the last one did instead of
    // stepping by the difference between a centre and a top.
    //
    // And each of those seats is itself two, because a name hangs from a
    // cluster and a cluster has two poses. The gather picks between the
    // bloomed top and the column's, exactly as it does for the marks — without
    // it the name would stay out at the packing's top while its songs closed
    // into a column beneath it.
    const gather = gatherFraction(
      cameraScale,
      nativeFitScale(p, recut, fitScaleShared),
    );
    const worldX = flight.from.x + (flight.to.x - flight.from.x) * p;
    const fromTop =
      flight.fromTop + (flight.fromTopGathered - flight.fromTop) * gather;
    const toTop = flight.toTop + (flight.toTopGathered - flight.toTop) * gather;
    const worldY = fromTop + (toTop - fromTop) * p;
    return [
      {
        translateX: (worldX - cameraX) * cameraScale + viewport.width / 2,
      },
      {
        translateY:
          (worldY - cameraY) * cameraScale +
          viewport.height / 2 -
          FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
      },
    ];
  });
  const opacity = useDerivedValue(() => {
    const p = Math.min(Math.max(clock.value, 0), 1);
    return shelfLabelAlpha(
      nativeCameraScale(p, recut, cameraShared),
      nativeFitScale(p, recut, fitScaleShared),
    );
  });
  return (
    <SkiaGroup transform={transform} opacity={opacity}>
      <NativeLabelLine
        from={flight.primaryFrom}
        to={flight.primaryTo}
        y={0}
        color={palette.muted}
        {...{ flight, clock, font: labelFont }}
      />
      <NativeLabelLine
        from={flight.secondaryFrom}
        to={flight.secondaryTo}
        y={FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX}
        color={palette.faint}
        {...{ flight, clock, font: labelFont }}
      />
    </SkiaGroup>
  );
}

/** One line of a name, centred in its label's frame and fading on the clock. */
function NativeLabelLine({
  from,
  to,
  y,
  color,
  flight,
  clock,
  font: labelFont,
}: {
  from: string;
  to: string;
  y: number;
  color: string;
  flight: LabelFlight;
  clock: SharedValue<number>;
  font: NonNullable<ReturnType<typeof useMorphFont>>;
}) {
  const fromWidth = labelFont.measureText(from).width;
  const toWidth = labelFont.measureText(to).width;
  const owner = useDerivedValue(() =>
    flightOwnerAlpha(
      flight.ownership,
      flight.fromAlpha,
      flight.targetAlpha,
      Math.min(Math.max(clock.value, 0), 1),
    ),
  );
  const fromOpacity = useDerivedValue(() => {
    if (from.length === 0) return 0;
    if (from === to) return owner.value;
    const p = Math.min(Math.max(clock.value, 0), 1);
    const raw = to.length === 0 ? p / 0.7 : (p - 0.25) / 0.5;
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return owner.value * (1 - amount);
  });
  const toOpacity = useDerivedValue(() => {
    if (to.length === 0 || from === to) return 0;
    const p = Math.min(Math.max(clock.value, 0), 1);
    const raw = from.length === 0 ? p / 0.7 : (p - 0.25) / 0.5;
    const t = Math.min(Math.max(raw, 0), 1);
    const amount = t * t * t * (t * (t * 6 - 15) + 10);
    return owner.value * amount;
  });
  return (
    <>
      {from.length > 0 ? (
        <Text
          text={from}
          x={-fromWidth / 2}
          y={y}
          font={labelFont}
          color={color}
          opacity={fromOpacity}
        />
      ) : null}
      {to.length > 0 && to !== from ? (
        <Text
          text={to}
          x={-toWidth / 2}
          y={y}
          font={labelFont}
          color={color}
          opacity={toOpacity}
        />
      ) : null}
    </>
  );
}

function nativeSmootherstep(value: number): number {
  'worklet';
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
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
  /** The placement the camera arrived at; the only one drawn as a player. */
  focusKey?: string | null;
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
      arriving: arrivingFraction(
        presentation.localAudio.bytes,
        presentation.delivery?.byte_length,
      ),
      byteLength: presentation.delivery?.byte_length ?? null,
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
    // L2. The player is the same lens with the room to be one, drawn at the
    // mark's own point — which at this distance is the middle of the view,
    // because that is what arriving at a song means.
    if (alpha.song > 0.01 && placement.key === request.focusKey) {
      lens.draw(
        canvas,
        {
          kind: 'song',
          x: point.x,
          y:
            point.y -
            request.viewport.height *
              FIELD_CANVAS_KNOBS.SONG_RISE_RATIO *
              alpha.song,
          width: request.viewport.width * FIELD_CANVAS_KNOBS.SONG_BOX_RATIO,
          height: request.viewport.width * FIELD_CANVAS_KNOBS.SONG_BOX_RATIO,
        },
        song,
        {
          alpha: alpha.song * placementOpacity,
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
  const model = jobMarkModel(pending.job, [], pending.declaredStages);
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
  const quiet = model.failed ? FIELD_CANVAS_KNOBS.JOB_FAILED_ALPHA : 1;

  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(FIELD_CANVAS_KNOBS.JOB_RING_WIDTH_PX);
  // The arc it *will* trace, drawn before the work reaches it. Only a model
  // that declared its stages gets one: the ring is a claim about the shape of
  // the work, and an undeclared pipeline has made no such claim.
  if (model.arc !== null) {
    paint.setAlphaf(visible * FIELD_CANVAS_KNOBS.JOB_RING_AHEAD_ALPHA);
    canvas.drawCircle(point.x, point.y, radius, paint);
  }
  paint.setAlphaf(visible * quiet);
  if (model.arc !== null) {
    canvas.drawArc(box, -90, 360 * model.arc, false, paint);
  } else if (model.progress.kind === 'determinate') {
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

  // The stage's own symbol, inside its ring. Real outlines from the symbol
  // library rather than letters, which is what `STAGE_SYMBOLS` exists for.
  if (model.symbol !== null) {
    paint.setAlphaf(visible * quiet);
    canvas.save();
    canvas.translate(point.x, point.y);
    canvas.drawPath(
      stageGlyphPath(model.symbol as SymbolName, FIELD_CANVAS_KNOBS.JOB_GLYPH_PX),
      paint,
    );
    canvas.restore();
  }

  // What is happening, under the mark, where the shelf label would be for a
  // cluster: a job is the one mark that says its own state out loud, at every
  // distance. Gated on the dot alpha alone it went silent exactly when the
  // rows arrived — a ring with nothing to say.
  if (visible > 0.01) {
    const label = jobStateLabel(pending.job);
    const counted =
      model.progress.kind === 'determinate'
        ? ` ${model.progress.completed}/${model.progress.total}`
        : '';
    const line = `${label}${counted}`;
    request.paints.muted.setAlphaf(visible * quiet);
    canvas.drawText(
      line,
      point.x - request.fonts.mono.measureText(line).width / 2,
      point.y + FIELD_CANVAS_KNOBS.JOB_STAGE_LABEL_GAP_PX,
      request.paints.muted,
      request.fonts.mono,
    );
  }

  // At L1 there is room for the words that were typed.
  if (alpha.row > 0.01 && pending.caption !== null) {
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

const stageGlyphCache = new Map<string, SkPath>();

/**
 * One stage symbol as a path, around the origin.
 *
 * Built through the same `resolveSilhouette` the onboarding and the composer
 * use, so a stage glyph in the field is the identical artwork at a different
 * size. Built at the origin and translated by the caller for the same reason a
 * face is: keyed on where it is drawn, the cache would miss on every camera
 * frame and re-resolve every contour of every job in the field.
 */
function stageGlyphPath(symbol: SymbolName, size: number): SkPath {
  const key = `${symbol}:${size}`;
  const cached = stageGlyphCache.get(key);
  if (cached !== undefined) return cached;
  const silhouette = resolveSilhouette(SYMBOL_LIBRARY[symbol], size, size, 1, {
    centerX: 0,
    centerY: 0,
  });
  const path = compoundPolygonPath(silhouette.contours);
  if (stageGlyphCache.size >= 256) {
    const oldest = stageGlyphCache.keys().next().value;
    if (oldest !== undefined) stageGlyphCache.delete(oldest);
  }
  stageGlyphCache.set(key, path);
  return path;
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
  // In world units, and without building a point per placement. This runs over
  // every placement in the field on every recorded frame — the one loop here
  // that is not culled — so the two allocations `placementPoint` and
  // `worldToScreen` would each make are the whole of its cost at 500 songs.
  // One conversion per *group* at the end says the same thing.
  const bloom = 1 - (gather < 0 ? 0 : gather > 1 ? 1 : gather);
  const topWorldByGroup = new Map<string, number>();
  for (const placement of request.placements) {
    const y = placement.y + placement.bloomY * bloom;
    const previous = topWorldByGroup.get(placement.groupKey);
    if (previous === undefined || y < previous) {
      topWorldByGroup.set(placement.groupKey, y);
    }
  }
  const topYByGroup = new Map<string, number>();
  for (const [groupKey, worldY] of topWorldByGroup) {
    topYByGroup.set(
      groupKey,
      (worldY - request.camera.y) * request.camera.scale +
        request.viewport.height / 2,
    );
  }
  request.paints.faint.setAlphaf(alpha);
  request.paints.muted.setAlphaf(alpha);

  /** A world point lifted to where a name sits above it. */
  const above = (point: { x: number; y: number }) => ({
    x: point.x,
    y: point.y - FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
  });

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

  const progress = request.relayoutLinear ?? 1;
  // Two clocks, one tween. The glyphs morph on the raw ramp because the motion
  // engine eases inside its own windows; the seat travels on the same eased
  // curve the marks use, so a label and its cluster move at one rate.
  const travel = smootherstep(progress);
  const flights = progress < 1 ? request.labelFlights ?? null : null;
  if (flights !== null) {
    for (const flight of flights) {
      const ownerAlpha = alpha * labelFlightAlpha(flight, travel);
      if (ownerAlpha <= 0.01) continue;
      // A name travels seat to seat: the top of the cluster it leaves to the
      // top of the one it lands on, both in world units, projected once. Both
      // ends being the same quantity is what makes a re-cut that does not move
      // a cluster — one month becoming one year — morph in place instead of
      // swooping. Anchoring on the destination and lerping an *offset between
      // centres* into it steps by the difference between the two clusters'
      // heights on the first frame, because a cluster's centre is not where
      // its name sits.
      // Each end is two seats, and the gather picks between them — the same
      // blend `NativeShelfLabel` makes, because the two renderers hand over at
      // 12·FIT where the clusters are long since closed and a label drawn at
      // the bloomed top by one of them would step on the way past.
      const fromTop =
        flight.fromTop + (flight.fromTopGathered - flight.fromTop) * gather;
      const toTop =
        flight.toTop + (flight.toTopGathered - flight.toTop) * gather;
      const point = above(
        worldToScreen(
          {
            x: flight.from.x + (flight.to.x - flight.from.x) * travel,
            y: fromTop + (toTop - fromTop) * travel,
          },
          request.camera,
          request.viewport,
        ),
      );
      if (!withinOverscan(point, request.viewport)) continue;
      if (flight.primary !== null) {
        drawLabelMorph(
          canvas,
          flight.primary,
          point.x,
          point.y,
          progress,
          request.paints.muted,
          ownerAlpha,
          request.fonts.mono,
        );
      } else if (flight.primaryTo.length > 0) {
        request.paints.muted.setAlphaf(ownerAlpha);
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
          ownerAlpha,
          request.fonts.mono,
        );
      } else if (flight.secondaryTo.length > 0) {
        request.paints.faint.setAlphaf(ownerAlpha);
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
    request.paints.faint.setAlphaf(alpha);
    request.paints.muted.setAlphaf(alpha);
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
  /**
   * The seat the interrupted flight had reached, in world units — both poses
   * of it. A name resumes from where it was *and* from how closed its cluster
   * was; capturing only the bloomed one would make the resumed flight step by
   * the gather on its first frame.
   */
  top: number;
  topGathered: number;
  primary: CapturedLabelMorph | null;
  secondary: CapturedLabelMorph | null;
  survives: boolean;
  alpha: number;
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
      top: flight.fromTop + (flight.toTop - flight.fromTop) * travel,
      topGathered:
        flight.fromTopGathered +
        (flight.toTopGathered - flight.fromTopGathered) * travel,
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
      alpha: labelFlightAlpha(flight, travel),
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
      fromTop: captured.top,
      fromTopGathered: captured.topGathered,
      fromAlpha:
        flight.ownership === 'branch' ? flight.fromAlpha : captured.alpha,
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
