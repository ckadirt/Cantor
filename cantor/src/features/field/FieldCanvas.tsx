import {
  labelMaxWidthPx,
  prepareNativeLabels,
  createLabelPaints,
  drawNativeLabels,
  heldLabelText,
} from './nativeLabels';
import { flightOwnerAlpha } from './flightOwnerAlpha';
import {
  flightOnScreen,
  gatherDrawn,
  gatherFaceInk,
  mapCameraAt,
  recededAt,
  recedeInkAt,
  type GatherCameras,
  type Recede,
} from './gatherInk';
import { drawNativeJobs, type JobMark } from './nativeJobs';
import {
  canStamp,
  createStampBatch,
  faceAtlasFor,
  flushStamps,
  stampFace,
  type FaceAtlas,
  type FaceStamping,
  type StampPool,
} from './faceAtlas';
import {
  joinFaces,
  joinJobs,
  joinRows,
  type FocusDraw,
  type NativeCut,
  type NativeRecut,
  type SongDraw,
} from './livingScene';
import { useHubCovers } from './useCover';
import {
  createMapPaints,
  drawHubs,
  drawLattice,
  drawSections,
  planHubFlights,
  planSectionFlights,
} from './nativeMap';
import {
  ARRIVAL_KNOBS,
  arriveInk,
  mix,
  songInkOf,
  type InkArrival,
  type SongInk,
} from './arrivals';
import { openedAt, type OpeningPlan } from './opening';
import {
  createRowPaints,
  drawNativeRows,
  type NativeRowModel,
} from './nativeRows';
import { songDetailOpacity, songDetailPhase } from './songDetailPhase';
import { lensWeight, useLensClock, type LensClock } from './lensClock';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import {
  Canvas,
  Fill,
  createPicture,
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
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useReducedMotion,
  runOnUI,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GRAIN_KNOBS,
  LEVEL_BOUNDARIES,
  LEVEL_SCALE_RATIOS,
  REPRESENTATION_WINDOWS,
  SHELF_BOX,
  bandAlphaAt,
  bowOffsetAt,
  flightProgressAt,
  GATHER_KNOBS,
  isFoundGroup,
  linearOfEased,
  overviewShrink,
  BROWSE_KNOBS,
  faceArrival,
  gatherFraction,
  nameArrival,
  songNameArrival,
  songShapeArrival,
  smootherstep,
  type Camera,
  type FieldLayout,
  type Group,
  type FlightOwnership,
  type FlightTiming,
  type PlacementFlight,
  type Point,
  type RepresentationAlphas,
  type Viewport,
} from '../../field';
import {
  ARRIVING_NONE,
  ARRIVING_UNKNOWN,
  arrivingHeld,
  LENSES,
  LENS_PAIRS,
  LENS_UI,
  NAME_LENS_KNOBS,
  arrivingFraction,
  availabilityAction,
  availabilityLine,
  availabilityOf,
  fitText,
  lensIndex,
  nameLensFacePath,
  nameLensRingRadius,
  SEAL_PLAYER_KNOBS,
  textWidth,
  TITLE_ALPHA,
  type LensFonts,
  type LensIdentity,
  type LensPairUi,
  type LensPlayer,
  type LensPaints,
  type SongAnalysis,
  type CoverArt,
} from '../../lenses';
import { easeSmoother } from '../../motion';
import { useMorphFont } from '../../motion/fonts';
import { writePhase, writeSubAlpha } from '../../motion/text';
import { titleTracePaths, traceTitlePath } from './titleTrace';
import { font, type as textType, type Palette } from '../../theme/tokens';
import type { SampleWindow } from '../../player';
import { jobMarkModel } from '../../jobs/marks';
import { jobStateLabel } from '../../jobs/policy';
import { compoundPolygonPath } from '../../motion/geometry';
import { resolveSilhouette } from '../../motion/silhouette';
import { SYMBOL_LIBRARY, type SymbolName } from '../../motion/symbolLibrary';
import { motionFrameAt, type MotionFrame } from '../../lenses/motion/motionFrame';
import { RING_MOTION_KNOBS, ringMotionLevel } from '../../lenses/circleMotion';
import type { MotionTrack } from '../../lenses/motion/motionTrack';
import {
  labelFlightAlpha,
  planShelfLabels,
  settledShelfLabelFlights,
  type LabelFlight,
  type ShelfLabelFlights,
} from './labelMorph';
import {
  NativePlayerParts,
  PLAYER_RING_KNOBS,
  PLAYER_VERB_POSE,
  clockCutsOf,
  type ClockCuts,
  nativeSongModel,
  type NativeSongModel,
} from './NativePlayer';
import {
  PLAYER_POSE_KNOBS,
  facePoseAt,
  lineOwnedByPlayer,
  playerRadiusPx,
} from './songPose';
import {
  sameDrawnSong,
  type FieldPresentation,
  type JobPresentation,
} from './useFieldController';
import {
  FIELD_CAMERA_KNOBS,
  type DrawnClock,
  type FieldRecutModel,
} from './useFieldCamera';

/**
 * Where the field last drew the player, and whether the motion layer is to
 * draw it: what `drawFieldFaces` hands `PlayerMotionLayer`, the arguments of
 * one `drawPlayer`.
 */
export type PlayerDraw = Readonly<{
  owned: boolean;
  lens: number;
  identity: LensIdentity;
  player: LensPlayer | null;
  x: number;
  y: number;
  size: number;
  alpha: number;
  weight: number;
  fill: number;
  arrived: number;
  arriving: number;
  soundIn: number;
  heard: number;
}>;

export type PlayerLayer = Readonly<{
  draw: SharedValue<PlayerDraw | null>;
  /** True once the layer has drawn the player: the field leaves its face out. */
  showing: SharedValue<boolean>;
}>;

/** How far the player must have arrived for the motion layer to draw it: all the way. */
const LAYER_ARRIVED = 0.999;

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
  /**
   * The ceiling on that count once the axis opens; see `drawSongDetail`.
   *
   * Reached at a spread of about twelve, which is where L3 begins — by then
   * the decoded detail owns the drawing and more ticks would be an upsample of
   * thirty-two numbers, paid for on every frame.
   */
  SONG_WAVE_MAX_TICKS: 1200,
  SONG_WAVE_REACH_RATIO: 0.36,
  SONG_WAVE_WIDTH_PX: 1.5,
  SONG_WAVE_ALPHA: 0.55,
  /** Music sits at 0.1–0.3 RMS, so a fixed gain spends the reach. */
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
/**
 * The longest a cut waits for its focus layer to be running before it goes on
 * the canvas without it; see `sendCut`. A new layer took up to ~600 ms to start
 * on the Xiaomi (debug build).
 */
const FOCUS_WAIT_MAX_MS = 900;

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
const MARK_RING_RADIUS_PX = nameLensRingRadius(NAME_LENS_KNOBS.MARK_RADIUS_PX);
const ROW_RING_RADIUS_PX = nameLensRingRadius(
  NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX,
);

type Props = {
  layout: FieldLayout;
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
  /**
   * Where the canvas has drawn the re-cut to, told back to the camera hook,
   * which captures an interrupted gather from it; see `DrawnClock`.
   */
  drawnClockShared?: SharedValue<DrawnClock>;
  /**
   * The clock the canvas plays a re-cut on, when the camera hook owns it to
   * hold an interrupted one; the canvas's own otherwise.
   */
  cutClockShared?: SharedValue<number>;
  /**
   * Filled with the canvas's way to send a cut before React renders it — a
   * letter in find (`useFieldCamera`'s `recutNow`).
   */
  installRef?: { current: CutInstaller | null };
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
  /**
   * The playhead unstepped, for the music's motion only (`MotionFrame`): a
   * kick lasts a few frames, and `positionSeconds` holds still between pixel
   * steps of the hand. Null except while the canvas owns the player of the
   * song being heard; read only while its motion is drawn.
   */
  motionPositionSeconds?: SharedValue<number> | null;
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
   * The play-to-pause morph, 0..1, for the song the player holds.
   *
   * A shared value rather than the player's state, because the canvas draws a
   * *shape* and has no business knowing what a snapshot is — and because the
   * word this replaced was a string, so every press of it rebuilt the song's
   * model and re-recorded the whole canvas. Geometry on the UI thread costs a
   * press nothing. See `playerWords`.
   */
  transportPlaying?: SharedValue<number> | null;
  transportArriving?: SharedValue<number> | null;
  /** The transport's lights, 0..1 each; see `TransportControls`. */
  transportLights?: SharedValue<number[]> | null;
  /** Analysis by entity key. Anything absent draws the neutral skeleton. */
  analyses?: ReadonlyMap<string, SongAnalysis>;
  /** Motion tracks by entity key; the playing song's moves its player. */
  motions?: ReadonlyMap<string, MotionTrack>;
  /**
   * Album covers as glyph levels, by entity key — only for the song the
   * player holds, which is the only one a cover is drawn for.
   */
  covers?: ReadonlyMap<string, CoverArt>;
  /**
   * Songs that just arrived from the phone, opening album by album: when each
   * opens, and the clock (elapsed ms) they open on. See `features/field/opening.ts`.
   */
  opening?: FieldOpening | null;
  /**
   * The decoded L3 window on the UI thread, never through React: see
   * `NativeFieldContentProps`.
   *
   * Optional, and empty when absent: a canvas nobody is feeding samples to has
   * no detail to resolve, which is the honest answer and the one every test
   * that is not about L3 wants.
   */
  grainShared?: SharedValue<GrainBars | null>;
  activeLensKey?: string;
  /**
   * What the phone thinks the time is, so a week can read as `THIS WEEK`.
   * Passed rather than read here: the label plan is a memo, and would hand
   * back a stale one at midnight.
   */
  nowMs: number;
  /** Groups visibly owned before this born re-cut generation. */
  labelFromGroups?: readonly Group[];
  /** Born transition identity used to capture interrupted label geometry. */
  transitionGeneration?: number;
  /** The re-cut being drawn: flights, camera endpoints, generation. */
  recut?: FieldRecutModel | null;
  /**
   * What a found row says under its name — where it came from and how long
   * it is — by entity key; see gather-plan, G3.
   */
  foundPlaces?: ReadonlyMap<string, string> | null;
  /**
   * The found shelf's last row, which is not a song — `3 MORE IN OTHER
   * WEEKS` — at the world point of the row it stands in.
   */
  foundFoot?: FoundFoot | null;
};

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
 * No level test, and nothing to keep in step with the bands.
 *
 * Held by identity and fed only shared values, for the reason `nativeScene`
 * gives.
 */
const ShelfVeil = React.memo(function ShelfVeilImpl({
  cameraShared,
  fitScaleShared,
  viewport,
  colour,
  map = false,
}: {
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  colour: string;
  map?: boolean;
}) {
  const box = map ? BROWSE_KNOBS : SHELF_BOX;
  const opacity = useDerivedValue(
    () =>
      bandAlphaAt(
        cameraShared.value.scale,
        fitScaleShared.value,
        map ? REPRESENTATION_WINDOWS.dot : REPRESENTATION_WINDOWS.row,
      ),
    [cameraShared, fitScaleShared, map],
  );
  // The far end of each gradient is the paper with nothing left of it. Built
  // from the palette's own colour rather than written as a literal: a gradient
  // that runs to `transparent` runs through grey on the way in a light theme
  // and through nothing at all in a dark one.
  const clear = useMemo(() => clearPaper(colour), [colour]);
  const topFade = box.TOP_PX + box.FADE_PX;
  const foot = viewport.height - box.FOOT_PX;
  const footFade = foot - box.FADE_PX;
  return (
    <SkiaGroup opacity={opacity}>
      <Rect
        color={colour}
        height={box.TOP_PX}
        width={viewport.width}
        x={0}
        y={0}
      />
      <Rect height={box.FADE_PX} width={viewport.width} x={0} y={box.TOP_PX}>
        <LinearGradient
          colors={[colour, clear]}
          end={vec(0, topFade)}
          start={vec(0, box.TOP_PX)}
        />
      </Rect>
      <Rect height={box.FADE_PX} width={viewport.width} x={0} y={footFade}>
        <LinearGradient
          colors={[clear, colour]}
          end={vec(0, foot)}
          start={vec(0, footFade)}
        />
      </Rect>
      <Rect
        color={colour}
        height={box.FOOT_PX}
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
 * The field's one canvas.
 *
 * Everything on it is drawn by `NativeFieldContent` on the UI thread, from the
 * re-cut and shared values; React only decides what exists. This component
 * prepares that — the fonts, the label plan, the born clock, the jobs' marks —
 * and hands the canvas one element that changes only when the re-cut does.
 */
function FieldCanvasImpl({
  layout,
  cameraShared,
  fitScaleShared,
  drawnClockShared,
  cutClockShared,
  installRef,
  viewport,
  presentations: currentPresentations,
  jobs,
  palette,
  positionSeconds = null,
  motionPositionSeconds = null,
  playingKey = null,
  focusKey = null,
  transportPlaying = null,
  transportArriving = null,
  transportLights = null,
  analyses,
  motions,
  covers,
  opening = null,
  grainShared = undefined,
  activeLensKey = 'name',
  nowMs,
  labelFromGroups = [],
  transitionGeneration = 0,
  recut = null,
  foundPlaces = null,
  foundFoot = null,
}: Props) {
  // Removed songs still own ink in the outgoing placement flights. Keep only
  // that drawing data until the flight family is replaced; it never re-enters
  // the controller's library or hit targets. Dropping it at the data commit
  // erases the exit early.
  // Progress updates rebuild the controller projection without changing songs.
  // Retain the drawing map so those updates cannot restart Skia's song mapper.
  const previousPresentations = useRef(currentPresentations);
  const presentations = useMemo(() => {
    const retained = new Map(currentPresentations);
    for (const flight of recut?.flights ?? []) {
      if (flight.targetPlacementKey !== null || retained.has(flight.entityKey))
        continue;
      const outgoing = previousPresentations.current.get(flight.entityKey);
      if (outgoing !== undefined) retained.set(flight.entityKey, outgoing);
    }
    const previous = previousPresentations.current;
    if (
      retained.size === previous.size &&
      [...retained].every(([key, next]) => {
        const old = previous.get(key);
        return old !== undefined && sameDrawnSong(old, next);
      })
    )
      return previous;
    return retained;
  }, [currentPresentations, recut]);
  previousPresentations.current = presentations;

  const displayFont = useMorphFont({
    fontFamily: font.display,
    // L1 has title plus metadata in every row; this leaves each row legible
    // at the prototype's 26-world-unit song spacing.
    fontSize: FIELD_CANVAS_KNOBS.NAME_LENS_TITLE_SIZE_PX,
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
  /*
   * The living scene's shared values (`livingScene.ts`): made once, for the
   * canvas's life. Native shared values are stable; the Jest mock is not, so
   * each is held by ref, as `useFieldCamera` holds its own.
   */
  const ownClock = useSharedValue(1);
  const sceneCandidate: LivingScene = {
    cut: useSharedValue<NativeCut | null>(null),
    clock: cutClockShared ?? ownClock,
    songs: useSharedValue<Readonly<Record<string, SongDraw>>>({}),
    focus: useSharedValue<FocusDraw | null>(null),
    playing: useSharedValue<string | null>(null),
    inkFrom: useSharedValue<Readonly<Record<string, SongInk>>>({}),
    inkClock: useSharedValue(1),
    openAt: useSharedValue<Readonly<Record<string, number>>>({}),
    soundClock: useSharedValue(1),
    motionIn: useSharedValue(0),
    focusLive: useSharedValue(-1),
    parked: useSharedValue<NativeCut | null>(null),
  };
  const scene = useRef(sceneCandidate).current;
  /**
   * Where the outgoing re-cut's clock stood when the next one was born: 1 if
   * it had landed. This is what the canvas drew the labels at, so it is what
   * an interrupted label plan is captured at (`retargetShelfLabelFlights`).
   */
  const interruptedAt = useRef(1);
  const seenGeneration = useRef<number | null>(null);
  if (recut !== null && seenGeneration.current !== recut.generation) {
    interruptedAt.current =
      seenGeneration.current === null ? 1 : scene.clock.value;
    seenGeneration.current = recut.generation;
  }
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
    // have no names.
    // Find's found shelf hangs no name over its column: the header's title
    // line is the query, and that is its name.
    const named = (groups: readonly Group[]) =>
      groups.some(group => isFoundGroup(group.key))
        ? groups.filter(group => !isFoundGroup(group.key))
        : groups;
    const from = named(labelFromGroups);
    const to = named(layout.groups);
    const planned =
      from.length === 0 ? null : planShelfLabels(from, to, monoFont, nowMs);
    return planned ?? settledShelfLabelFlights(to, nowMs);
  }, [labelFromGroups, layout, monoFont, nowMs]);
  const labelPlan = useRef<{
    generation: number;
    flights: ShelfLabelFlights | null;
  } | null>(null);
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
    const interrupted = interruptedAt.current < 1;
    labelPlan.current = {
      generation: transitionGeneration,
      flights:
        interrupted && previous?.flights != null && semanticLabelFlights != null
          ? retargetShelfLabelFlights(
              previous.flights,
              interruptedAt.current,
              semanticLabelFlights,
            )
          : semanticLabelFlights,
    };
  }
  const labelFlights = labelPlan.current?.flights ?? semanticLabelFlights;
  // The map's furniture travels the same re-cut as the names, from the same
  // groups; see `nativeMap.ts`.
  // Keyed on the groups themselves: the `labelFromGroups` default is a fresh
  // array every render, and a new plan would hand `Canvas` a new scene.
  const mapBefore =
    labelFromGroups.length === 0 ? layout.groups : labelFromGroups;
  const mapFlights = useMemo(
    () => ({
      hubs: planHubFlights(mapBefore, layout.groups),
      sections: planSectionFlights(mapBefore, layout.groups),
    }),
    [mapBefore, layout.groups],
  );
  const hubPaths = useHubCovers(layout.groups, currentPresentations);
  /*
   * The lens clock — from which lens, to which, how far — retained across
   * re-cuts on purpose: it lives out here rather than in the keyed native
   * scene, so regrouping mid-change keeps the change where it was. See
   * `lensClock.ts`.
   */
  const lensClock = useLensClock(Math.max(0, lensIndex(activeLensKey)));
  const reducedMotion = useReducedMotion();

  // Native shared values are stable; the Jest mock is not, so the fallback is
  // held by ref the way `useFieldCamera` holds its own candidates.
  const grainFallback = useSharedValue<GrainBars | null>(null);
  const grainValue = useRef(grainShared ?? grainFallback).current;
  /*
   * The jobs' marks, recorded here and drawn by the native scene.
   *
   * Recorded per job and only when that job's presentation is a new object —
   * the controller hands back the same one when nothing about it moved — and
   * kept for a job that has left the data while its outgoing flight is still
   * in the air, the way `presentations` keeps a removed song's.
   */
  const jobMarksCandidate = useSharedValue<Readonly<Record<string, JobMark>>>(
    {},
  );
  const jobMarks = useRef(jobMarksCandidate).current;
  const recordedJobs = useRef(
    new Map<string, { pending: JobPresentation; mark: JobMark }>(),
  );
  useEffect(() => {
    if (monoFont === null) return;
    const flying = new Set(recut?.flights.map(flight => flight.entityKey));
    const previous = recordedJobs.current;
    const next = new Map<string, { pending: JobPresentation; mark: JobMark }>();
    for (const [key, pending] of jobs ?? []) {
      const kept = previous.get(key);
      next.set(
        key,
        kept !== undefined && kept.pending === pending
          ? kept
          : { pending, mark: recordJobMark(pending, palette, monoFont) },
      );
    }
    for (const [key, kept] of previous) {
      if (!next.has(key) && flying.has(key)) next.set(key, kept);
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([key, entry]) => previous.get(key) === entry);
    recordedJobs.current = next;
    if (unchanged) return;
    const marks: Record<string, JobMark> = {};
    for (const [key, entry] of next) marks[key] = entry.mark;
    jobMarks.value = marks;
  }, [jobMarks, jobs, monoFont, palette, recut]);
  /**
   * The box the shelf is read inside, held by identity like everything else on
   * this canvas that outlives a camera frame.
   */
  const browsing = layout.browseBounds !== undefined;
  const veil = useMemo(
    () => (
      <>
        {browsing ? (
          <ShelfVeil
            map
            cameraShared={cameraShared}
            colour={palette.bg}
            fitScaleShared={fitScaleShared}
            viewport={viewport}
          />
        ) : null}
        <ShelfVeil
          cameraShared={cameraShared}
          colour={palette.bg}
          fitScaleShared={fitScaleShared}
          viewport={viewport}
        />
      </>
    ),
    [cameraShared, fitScaleShared, palette.bg, viewport, browsing],
  );

  /*
   * Every song's drawing, sent to the UI thread when it changes and only
   * then: a re-cut moves songs, it does not redraw them. Ink that changes
   * while you look — a file found at launch, a download landing — arrives on
   * the scene's ink clock, restarted with the songs it moves in one UI task.
   */
  const songCache = useRef(
    new Map<string, { presentation: FieldPresentation; draw: SongDraw }>(),
  );
  const lastInk = useRef<InkArrival | null>(null);
  useLayoutEffect(() => {
    if (displayFont === null || monoFont === null) return;
    const cache = songCache.current;
    const changed: Record<string, SongDraw> = {};
    let any = false;
    for (const [key, presentation] of presentations) {
      const kept = cache.get(key);
      if (
        kept !== undefined &&
        (kept.presentation === presentation ||
          sameDrawnSong(kept.presentation, presentation))
      ) {
        continue;
      }
      const draw = songDrawOf(presentation, displayFont, monoFont);
      cache.set(key, { presentation, draw });
      changed[key] = draw;
      any = true;
    }
    const removed: string[] = [];
    for (const key of [...cache.keys()]) {
      if (presentations.has(key)) continue;
      cache.delete(key);
      removed.push(key);
    }
    const ink = arriveInk(lastInk.current, presentations);
    const arriving = ink !== lastInk.current && ink.clock !== null;
    // The arrival runs on the scene's ink clock, so the next one reads where
    // this one has got to from it.
    lastInk.current = arriving ? { ...ink, clock: scene.inkClock } : ink;
    if (!any && removed.length === 0 && !arriving) return;
    const from = arriving ? Object.fromEntries(ink.from) : null;
    const songs = scene.songs;
    const inkFrom = scene.inkFrom;
    const inkClock = scene.inkClock;
    runOnUI(() => {
      'worklet';
      // A copy made here, on the UI thread, crosses nothing: only the songs
      // that changed were sent.
      const next: Record<string, SongDraw> = { ...songs.value, ...changed };
      for (let index = 0; index < removed.length; index++) {
        delete next[removed[index]];
      }
      songs.value = next;
      if (from !== null) {
        inkFrom.value = from;
        cancelAnimation(inkClock);
        inkClock.value = 0;
        inkClock.value = withTiming(1, {
          duration: ARRIVAL_KNOBS.INK_MS,
          easing: easeSmoother,
        });
      }
    })();
  }, [displayFont, monoFont, presentations, scene]);
  useEffect(() => {
    scene.playing.value = playingKey;
  }, [playingKey, scene]);
  useEffect(() => {
    scene.openAt.value =
      opening === null ? {} : Object.fromEntries(opening.plan.at);
  }, [opening, scene]);
  // The arrival's own clock while there is one, and the last one after: it
  // has run past every song by then, as an absent one reads.
  const openingFallback = useSharedValue(Infinity);
  const lastOpeningClock = useRef(opening?.clock ?? openingFallback);
  lastOpeningClock.current = opening?.clock ?? lastOpeningClock.current;
  const openingClock = lastOpeningClock.current;

  /*
   * The cut, sent as plain data and installed with its clock in one UI task:
   * the frame that first reads the new cut reads its clock at the start, and
   * no frame pairs one cut's data with another's clock. That is house rule 5,
   * kept without building a scene per cut.
   */
  const labelWidthPx = labelMaxWidthPx(viewport);
  const preparedLabels = useMemo(
    () =>
      monoFont === null
        ? []
        : prepareNativeLabels(labelFlights ?? [], monoFont, labelWidthPx),
    [labelFlights, monoFont, labelWidthPx],
  );
  const installed = useRef<number | null>(null);
  /**
   * Send a cut to the scene. From the layout effect below, after the render
   * that carries it; or straight from a keystroke in find, before React has
   * rendered it (`installRef`, `useFieldCamera`'s `recutNow`). A cut older
   * than the one on the canvas is never sent: a render still carrying it
   * would take the canvas back to it.
   */
  const sceneCut = scene.cut;
  const sceneClock = scene.clock;
  /** Put a cut on the canvas and start (or land) its clock. */
  const applyCut = (cutData: NativeCut, restart: boolean) => {
    'worklet';
    sceneCut.value = cutData;
    if (!restart) return;
    // A camera that follows its song has nowhere to travel: it is where the
    // cut puts the song, from the cut's first frame. Set with the cut, so no
    // frame draws one without the other — the camera hook sets the same
    // value when it hears the cut was drawn, which is a frame or more later.
    if (cutData.follows === true) cameraShared.value = cutData.recut.toCamera;
    cancelAnimation(sceneClock);
    // A re-cut that does not animate lands at once, so reduced motion
    // shows the new cut instead of one stale frame.
    if (!cutData.animate) {
      sceneClock.value = 1;
      return;
    }
    sceneClock.value = 0;
    sceneClock.value = withTiming(1, {
      duration: cutData.durationMs,
      easing: nativeSmootherstep,
    });
  };
  const applyCutRef = useRef(applyCut);
  applyCutRef.current = applyCut;
  /*
   * A focus layer is on the canvas: the cut built for it may go down.
   *
   * Called from the layer's passive effect, which runs after every layout
   * effect of its commit — Skia's own re-recording of this canvas among them —
   * so what it queues on the UI thread runs after the new tree is there. Told
   * from the layer's first UI-thread reaction instead, the cut went down while
   * the canvas was still drawing the old layer, for up to a third of a second.
   */
  const focusReady = useCallback(
    (generation: number) => {
      const apply = applyCutRef.current;
      const live = scene.focusLive;
      const parked = scene.parked;
      runOnUI(() => {
        'worklet';
        if (live.value < generation) live.value = generation;
        const held = parked.value;
        if (held === null || generation < held.generation) return;
        parked.value = null;
        apply(held, true);
      })();
    },
    [scene],
  );
  /** The cut the focus layer being drawn was built for; see `sendCut`. */
  const focusGeneration = useRef<number | null>(null);
  const sendCut = (
    next: FieldRecutModel,
    places: ReadonlyMap<string, string> | null,
    foot: FoundFoot | null,
  ) => {
    if (monoFont === null) return;
    if (installed.current !== null && next.generation < installed.current) {
      return;
    }
    const fitted: Record<string, string> = {};
    if (places !== null) {
      for (const [key, text] of places) {
        const song = songCache.current.get(key);
        if (song !== undefined) {
          fitted[key] = fitText(text, monoFont, song.draw.column);
        }
      }
    }
    const cutData: NativeCut = {
      generation: next.generation,
      animate: next.animate,
      durationMs: next.durationMs ?? FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      recut: {
        fromCamera: next.fromCamera,
        toCamera: next.toCamera,
        fromFitScale: next.fromFitScale,
        toFitScale: next.toFitScale,
      },
      recede: next.recede ?? null,
      gather: next.gather ?? null,
      follows: next.follows === true,
      flights: next.flights,
      places: fitted,
      // A find cut keeps the map's groups as they were, so the names on the
      // canvas are already the right ones; the render plans them anew.
      labels: preparedLabels,
      hubs: mapFlights.hubs,
      sections: mapFlights.sections,
      foundFoot: foot,
    };
    const restart = installed.current !== next.generation;
    if (seenGeneration.current !== next.generation) {
      // Sent before its render: what that render's label plan is captured
      // at, as the render would have read it; see `interruptedAt`.
      interruptedAt.current =
        seenGeneration.current === null ? 1 : scene.clock.value;
      seenGeneration.current = next.generation;
    }
    installed.current = next.generation;
    /*
     * A cut with a focus layer waits for that layer to be running.
     *
     * The layer is keyed by its cut, so the cut's arrival mounts a new one,
     * and on the Xiaomi a new layer took most of a second to start drawing.
     * Installed at once, the cut and its camera moved on while the old layer
     * — the player as the old cut placed it — went on drawing through the new
     * camera: a re-cut under the song you stand in dropped the player a row
     * off its dial for that long (the Flicker Law's fourth rule). Held until
     * the new layer says it is live, the old cut, layer and camera stay
     * together, and the new three take over in one frame.
     */
    const waits = restart && focusGeneration.current === next.generation;
    const parked = scene.parked;
    const focusLive = scene.focusLive;
    const send = () => {
      'worklet';
      const held = parked.value;
      if (!restart && held !== null && held.generation === cutData.generation) {
        // A resend of the cut still waiting: it waits with the new data.
        parked.value = cutData;
        return;
      }
      // Only once a layer has ever said so: a canvas whose layers have never
      // reported (the very first, or a test renderer) has nothing to wait on.
      if (
        waits &&
        focusLive.value >= 0 &&
        focusLive.value < cutData.generation
      ) {
        parked.value = cutData;
        return;
      }
      parked.value = null;
      applyCut(cutData, restart);
    };
    runOnUI(send)();
    if (waits) {
      const generation = next.generation;
      setTimeout(() => {
        runOnUI(() => {
          'worklet';
          const held = parked.value;
          if (held === null || held.generation !== generation) return;
          parked.value = null;
          applyCut(held, true);
        })();
      }, FOCUS_WAIT_MAX_MS);
    }
  };
  const sendCutRef = useRef(sendCut);
  sendCutRef.current = sendCut;
  if (installRef !== undefined) {
    installRef.current = sendCut;
  }
  // A layout effect, as the songs' is — that one is declared first, so a cut
  // never reaches the UI thread ahead of a song it names. The UI thread ran a
  // passive effect's install up to 56 ms after it was sent, behind the
  // commit's own view updates; a layout effect's, about one frame (measured
  // on the Xiaomi).
  useLayoutEffect(() => {
    if (recut === null) return;
    sendCutRef.current(recut, foundPlaces, foundFoot);
  }, [
    foundFoot,
    foundPlaces,
    mapFlights,
    monoFont,
    preparedLabels,
    presentations,
    recut,
  ]);

  /*
   * The focus: the one song the camera is in, whose face grows into the
   * player. Its player models go to the faces' join; its flight, row and
   * detail mount as the focus layer, keyed by the cut and the song.
   */
  const focusFlight = useMemo(
    () =>
      focusKey === null || recut === null
        ? null
        : recut.flights.find(flight => flight.targetPlacementKey === focusKey) ??
          null,
    [focusKey, recut],
  );
  const focusEntity = focusFlight?.entityKey ?? null;
  const focusPresentation =
    focusEntity === null ? undefined : presentations.get(focusEntity);
  const focusAnalysis =
    focusEntity === null ? undefined : analyses?.get(focusEntity);
  const focusCover =
    focusEntity === null ? null : covers?.get(focusEntity) ?? null;
  // The playhead is the playing song's, so only that song's player moves.
  const focusMotion =
    focusEntity === null || focusEntity !== playingKey
      ? null
      : motions?.get(focusEntity) ?? null;
  const focusDraw = useMemo<FocusDraw | null>(
    () =>
      focusKey === null || focusPresentation === undefined
        ? null
        : {
            placementKey: focusKey,
            players: LENSES.map(lens =>
              lens.player(focusPresentation.recipe, focusAnalysis, focusCover),
            ),
            seconds: focusPresentation.durationMs / 1000,
            motion: focusMotion,
          },
    [focusAnalysis, focusCover, focusKey, focusMotion, focusPresentation],
  );
  /**
   * The songs whose sound has already been shown, so a measurement that lands
   * while you are looking rises into the seal rather than appearing in it —
   * which it would otherwise do mid-descent, since a song is measured as it
   * opens.
   */
  const soundShown = useRef(new Set<string>());
  useEffect(() => {
    const key = focusPresentation?.entity.key;
    const rising =
      focusDraw !== null &&
      key !== undefined &&
      !soundShown.current.has(key) &&
      focusDraw.players.some(model => model !== null && model.sound != null);
    if (rising && key !== undefined) soundShown.current.add(key);
    const focus = scene.focus;
    const soundClock = scene.soundClock;
    const duration = reducedMotion ? 0 : SEAL_PLAYER_KNOBS.SOUND_MS;
    runOnUI(() => {
      'worklet';
      focus.value = focusDraw;
      if (!rising) return;
      cancelAnimation(soundClock);
      soundClock.value = 0;
      soundClock.value = withTiming(1, { duration, easing: Easing.linear });
    })();
  }, [focusDraw, focusPresentation, reducedMotion, scene]);
  const focusLayer = useMemo<FocusLayer | null>(() => {
    if (
      recut === null ||
      focusFlight === null ||
      focusPresentation === undefined ||
      displayFont === null ||
      monoFont === null ||
      songTitleFont === null ||
      songMetaFont === null
    ) {
      return null;
    }
    const row = nativeRowModel(
      focusPresentation,
      focusPresentation.recipe,
      displayFont,
      monoFont,
    );
    return {
      key: `${recut.generation}:${focusFlight.key}`,
      generation: recut.generation,
      recut: {
        fromCamera: recut.fromCamera,
        toCamera: recut.toCamera,
        fromFitScale: recut.fromFitScale,
        toFitScale: recut.toFitScale,
      },
      flight: focusFlight,
      row,
      titleFrom:
        lastInk.current?.from.get(focusFlight.entityKey)?.title ??
        row.titleAlpha,
      song: nativeSongModel(
        focusPresentation,
        viewport,
        row.title,
        row.meta,
        row.action === null ? 0 : textWidth(row.action, monoFont),
        {
          rowTitle: displayFont,
          songTitle: songTitleFont,
          rowMeta: monoFont,
          songMeta: songMetaFont,
        },
      ),
      detail: songDetailOf(
        recut.flights,
        presentations,
        analyses,
        focusKey,
      ),
      durationSeconds: focusPresentation.durationMs / 1000,
    };
  }, [
    analyses,
    displayFont,
    focusFlight,
    focusKey,
    focusPresentation,
    monoFont,
    presentations,
    recut,
    songMetaFont,
    songTitleFont,
    viewport,
  ]);
  focusGeneration.current = focusLayer?.generation ?? null;

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
   * Nothing here reads the camera or the cut: both reach the scene through
   * shared values on the UI thread. So the element changes only with the
   * focus, the fonts and the palette — not with a re-cut.
   */
  const hasCut = recut !== null;
  /*
   * The music at this moment, for the player — and null, which wakes nothing,
   * whenever there is no motion to draw. Reduced motion has none at all: the
   * player is today's. What sounds (`transient`) settles with the transport's
   * own pause morph, so a pause or a scrub does not freeze a kick mid-swell;
   * the form stays where the song is.
   */
  const motionClock = motionPositionSeconds ?? positionSeconds;
  // Held by ref, as the scene is: native derived values are stable, the Jest
  // mock's are not, and the scene element must not be rebuilt by a render.
  const motionFrameCandidate = useDerivedValue((): MotionFrame | null => {
    const focused = scene.focus.value;
    const track = focused === null ? null : focused.motion;
    const presence = scene.motionIn.value;
    if (track === null || presence <= 0 || reducedMotion || motionClock === null) {
      return null;
    }
    const transient =
      transportPlaying === null
        ? 1
        : Math.min(Math.max(transportPlaying.value - PLAYER_VERB_POSE.play, 0), 1);
    const frame = motionFrameAt(track, motionClock.value, transient);
    frame.presence = presence;
    return frame;
  });
  const motionFrame = useRef(motionFrameCandidate).current;
  const motionOnCandidate = useDerivedValue(() => motionFrame.value !== null);
  const motionOn = useRef(motionOnCandidate).current;
  /*
   * The player on its own canvas while it moves (`PlayerMotionLayer`).
   *
   * Re-rendering the field canvas costs most of a frame at L2 whatever moves
   * in it — its pictures' anti-aliased paths are rasterised on the CPU and
   * uploaded again on every render (reactive-player-log.md, M4) — which is
   * why its playhead is stepped. So the field hands the player to a small
   * canvas above it once the camera has landed, and the field itself is told
   * there is no motion (`fieldMotion`): it re-renders on its stepped clock, as
   * it did before the player moved.
   */
  const playerLayerCandidate: PlayerLayer = {
    draw: useSharedValue<PlayerDraw | null>(null),
    showing: useSharedValue(false),
  };
  const playerLayer = useRef(playerLayerCandidate).current;
  const fieldMotionCandidate = useDerivedValue((): MotionFrame | null => {
    const drawn = playerLayer.draw.value;
    if (playerLayer.showing.value && drawn !== null && drawn.owned) return null;
    return motionFrame.value;
  });
  const fieldMotion = useRef(fieldMotionCandidate).current;
  const nativeScene = useMemo(() => {
    if (
      !hasCut ||
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
          scene={scene}
          focus={focusLayer}
          focusReady={focusReady}
          openingClock={openingClock}
          lensClock={lensClock}
          reducedMotion={reducedMotion}
          drawnClock={drawnClockShared ?? null}
          cameraShared={cameraShared}
          fitScaleShared={fitScaleShared}
          viewport={viewport}
          grainShared={grainValue}
          jobMarks={jobMarks}
          transportPlaying={transportPlaying}
          transportArriving={transportArriving}
          transportLights={transportLights}
          positionSeconds={positionSeconds}
          motionFrame={fieldMotion}
          motionOn={motionOn}
          layer={playerLayer}
          hubPaths={hubPaths}
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
    cameraShared,
    displayFont,
    drawnClockShared,
    fitScaleShared,
    focusLayer,
    focusReady,
    grainValue,
    hubPaths,
    jobMarks,
    lensClock,
    monoFont,
    openingClock,
    palette,
    positionSeconds,
    fieldMotion,
    motionOn,
    playerLayer,
    // Only whether there is a cut, not which: a re-cut reaches the scene as
    // a shared value.
    hasCut,
    reducedMotion,
    scene,
    songMetaFont,
    songTitleFont,
    transportArriving,
    transportLights,
    transportPlaying,
    veil,
    viewport,
  ]);

  // Paper until the fonts the field is written in have loaded — a frame or
  // two at launch. There is no second way to draw the field.
  const paper = useMemo(() => <Fill color={palette.bg} />, [palette.bg]);
  return (
    <>
      <Canvas
        importantForAccessibility="no-hide-descendants"
        opaque
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        {nativeScene ?? paper}
      </Canvas>
      {viewport === null ? null : (
        <PlayerMotionLayer
          layer={playerLayer}
          motion={motionFrame}
          palette={palette}
          viewport={viewport}
        />
      )}
    </>
  );
}

/**
 * The player while it moves to the music, on a canvas of its own above the
 * field's: see `PlayerLayer`. Draws only what the field has handed it — the
 * lens's own `drawPlayer`, where the field last drew the player — and says
 * when it has, so the field can leave its face out.
 */
function PlayerMotionLayer({
  layer,
  motion,
  palette,
  viewport,
}: {
  layer: PlayerLayer;
  motion: DerivedValue<MotionFrame | null>;
  palette: Palette;
  viewport: Viewport;
}) {
  const paints = useMemo(() => createFacePaints(palette), [palette]);
  const picture = useDerivedValue(() =>
    createPicture(
      canvas => {
        const drawn = layer.draw.value;
        const frame = motion.value;
        const show = drawn !== null && drawn.owned && frame !== null;
        if (layer.showing.value !== show) layer.showing.value = show;
        if (!show) return;
        canvas.save();
        canvas.translate(drawn.x, drawn.y);
        LENS_UI[drawn.lens].drawPlayer(
          canvas,
          drawn.player,
          drawn.identity,
          drawn.size,
          drawn.alpha,
          drawn.weight,
          drawn.fill,
          drawn.arrived,
          drawn.arriving,
          drawn.soundIn,
          drawn.heard,
          FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
          paints,
          frame,
        );
        canvas.restore();
      },
      { width: viewport.width, height: viewport.height },
    ),
  );
  return (
    <Canvas
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Picture picture={picture} />
    </Canvas>
  );
}

/** The measured loudness as plain numbers; a worklet cannot hold a typed array. */
function levelsOf(analysis: SongAnalysis | undefined): readonly number[] {
  if (analysis === undefined) return [];
  return Array.from(analysis.rms);
}

/**
 * The camera scale this frame, whether the re-cut or the finger owns it.
 *
 * Defined above every worklet that calls it: the worklets plugin captures a
 * `'worklet'` helper into its caller's closure where the caller is written, so
 * one written below arrives as `undefined`. The same rule the band maths in
 * `bands.ts` is ordered by.
 */
/** Send a cut to the canvas outside a render; see `FieldCanvas`'s `sendCut`. */
export type CutInstaller = (
  recut: FieldRecutModel,
  places: ReadonlyMap<string, string> | null,
  foot: FoundFoot | null,
) => void;

/** Device pixels per canvas unit, for drawing the faces' stamps sharp. */
const PIXEL_RATIO = PixelRatio.get();

/** Before any cut is on the canvas: the clock reads 1, so the live camera. */
const EMPTY_RECUT: NativeRecut = {
  fromCamera: { x: 0, y: 0, scale: 1 },
  toCamera: { x: 0, y: 0, scale: 1 },
  fromFitScale: 1,
  toFitScale: 1,
};

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

// These camera-only values are identical for every song. Install their
// mappers once for the scene's life, rather than once per placement.
function useNativeCameraMotion(
  clock: SharedValue<number>,
  cut: SharedValue<NativeCut | null>,
  cameraShared: SharedValue<Camera>,
  fitScaleShared: SharedValue<number>,
  viewport: Viewport,
) {
  const zero = useSharedValue(0);
  const one = useSharedValue(1);
  const scale = useDerivedValue(() =>
    nativeCameraScale(
      clock.value,
      cut.value === null ? EMPTY_RECUT : cut.value.recut,
      cameraShared,
    ),
  );
  const fit = useDerivedValue(() =>
    nativeFitScale(
      clock.value,
      cut.value === null ? EMPTY_RECUT : cut.value.recut,
      fitScaleShared,
    ),
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
  const playerLineInk = useDerivedValue(
    () => 1 - lineOwnedByPlayer(nameArrived.value),
  );
  /**
   * Whether the player, rather than the row batch, draws the focused song's
   * row this frame: 1 once any part of the player has started to arrive, 0
   * while the camera is at row distance or farther.
   *
   * Decided here, from the camera, so both owners answer on the same frame.
   * It used to be a React commit: the batch left the focused row out while
   * the player's flight was mounted, so on the way back up the flight
   * unmounted and the batch's picture took the row back one passive effect
   * later — a frame with no name at all (flicker B). Now the hand-over happens
   * at row distance, where the two drawings are the same pixels, and the
   * commits that mount and unmount the flight land while it is drawing nothing.
   * A pinch cannot pass the shelf seat, so the flight is always mounted before
   * the camera can make this 1.
   */
  const owned = useDerivedValue(() =>
    shapeArrived.value > 0 || nameArrived.value > 0 || arrived.value > 0
      ? 1
      : 0,
  );
  const rowOnly = useDerivedValue(() => 1 - arrived.value);
  const walked = useDerivedValue(() => faceArrival(scale.value, fit.value));
  const written = useDerivedValue(() => nameArrival(scale.value, fit.value));
  /**
   * How much of the field is left, once the grain has opened.
   *
   * "At L3 the field gives way to one song's samples entirely" — which the
   * recorded picture said by returning early after drawing the grain, and
   * which nothing said on the native path until it owned that distance too.
   *
   * It is needed because the row and the player are written against arrivals
   * rather than bands, and an arrival does not come back down: `written` holds
   * at 1 above `NAME_WRITE`, `named` above `NAME_TRAVEL`, and `rowOnly` climbs
   * back to 1 as the song band closes — so at the grain seat the row's action
   * word and the player's name were still at full ink, over the waveform.
   *
   * A fade on the grain's own band rather than an early return, because the
   * two renderers are one now and a cut is a thing you can see.
   */
  const fieldFade = useDerivedValue(
    () => 1 - bandAlphaAt(scale.value, fit.value, REPRESENTATION_WINDOWS.grain),
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
  return {
    zero,
    one,
    becomingRow,
    shapeArrived,
    nameArrived,
    arrived,
    playerLineInk,
    owned,
    rowOnly,
    walked,
    written,
    playerAnchor,
    fieldFade,
  };
}

type NativeCameraMotion = ReturnType<typeof useNativeCameraMotion>;

/** The found shelf's last row: its words and the world point of its seat. */
export type FoundFoot = Readonly<{ text: string; x: number; y: number }>;

/** An arrival from the phone, as the canvas draws it. */
export type FieldOpening = Readonly<{
  plan: OpeningPlan;
  /** Elapsed ms; held at 0 until the arrival is shown. */
  clock: SharedValue<number>;
}>;

/**
 * The living scene's shared values, made once for the canvas's life: the
 * cut on the canvas and its clock, every song's drawing, the focus, and the
 * clocks that belong to songs rather than cuts. See `livingScene.ts`.
 */
type LivingScene = Readonly<{
  cut: SharedValue<NativeCut | null>;
  /** Eased 0 → 1 across the cut on the canvas; restarted with it. */
  clock: SharedValue<number>;
  songs: SharedValue<Readonly<Record<string, SongDraw>>>;
  focus: SharedValue<FocusDraw | null>;
  playing: SharedValue<string | null>;
  /** Where each song whose ink is arriving was drawn; see `arriveInk`. */
  inkFrom: SharedValue<Readonly<Record<string, SongInk>>>;
  inkClock: SharedValue<number>;
  /** When each arriving song opens, on the opening clock. */
  openAt: SharedValue<Readonly<Record<string, number>>>;
  /** The focused player's sound rising; 1 is risen. */
  soundClock: SharedValue<number>;
  /** The playing player's motion rising (`MotionFrame.presence`); 1 is risen. */
  motionIn: SharedValue<number>;
  /** The newest cut whose focus layer is running on the UI thread. */
  focusLive: SharedValue<number>;
  /** A cut waiting for its focus layer; see `sendCut`. */
  parked: SharedValue<NativeCut | null>;
}>;

/**
 * The focused song's flight, player and detail: the one part of the scene
 * still mounted per focus, and per cut while there is a focus (`key`).
 */
type FocusLayer = Readonly<{
  key: string;
  generation: number;
  recut: NativeRecut;
  flight: PlacementFlight;
  row: NativeRowModel;
  titleFrom: number;
  song: NativeSongModel | null;
  detail: SongDetailModel | null;
  durationSeconds: number;
}>;

type NativeFieldContentProps = Readonly<{
  scene: LivingScene;
  focus: FocusLayer | null;
  /** A focus layer is drawn; its cut may go down. See `sendCut`. */
  focusReady: (generation: number) => void;
  openingClock: SharedValue<number>;
  lensClock: LensClock;
  reducedMotion: boolean;
  /** Where the scene has drawn its cut to, for the camera hook. */
  drawnClock: SharedValue<DrawnClock> | null;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  /** The play-to-pause morph, 0..1, for the song the player holds. */
  transportPlaying: SharedValue<number> | null;
  transportArriving: SharedValue<number> | null;
  transportLights: SharedValue<number[]> | null;
  positionSeconds: SharedValue<number> | null;
  /**
   * The music at this moment for what the field draws: the frame, or null —
   * also while the motion layer is drawing the player (`PlayerMotionLayer`),
   * so the field is not re-rendered for it.
   */
  motionFrame: DerivedValue<MotionFrame | null>;
  /** Whether there is a frame at all; changes only as motion rises and goes. */
  motionOn: DerivedValue<boolean>;
  layer: PlayerLayer;
  /**
   * The decoded window L3 draws, as a shared value rather than a prop.
   *
   * It changes every time the camera resolves a new span, and this element is
   * held by identity — a decode landing as a prop would hand `Canvas` a fresh
   * element mid-zoom and re-record the whole root. See the Flicker Law note on
   * `nativeScene`.
   */
  grainShared: SharedValue<GrainBars | null>;
  /**
   * Every generating job's mark, by entity key — a shared value for the reason
   * `grainShared` is one: progress lands about once a second and must not hand
   * `Canvas` a fresh element. See `drawNativeJobs`.
   */
  jobMarks: SharedValue<Readonly<Record<string, JobMark>>>;
  /**
   * The album covers' halftone paths, a shared value for `jobMarks`' reason:
   * they land one by one after the field is drawn.
   */
  hubPaths: SharedValue<Readonly<Record<string, SkPath>>>;
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
/**
 * SPIKE — every face in the field as one picture, recorded on the UI thread.
 *
 * The renderer this canvas has is retained-mode: one React component per
 * placement, each carrying its own Skia nodes and its own Reanimated mappers.
 * That is the right shape for a screen and the wrong shape for a field, where
 * the same drawing is repeated once per song and a re-cut rebuilds all of it.
 * The face is the most multiplied thing on the canvas — every placement has
 * one, at every level, always mounted — so it is what this moves first.
 *
 * The bargain: the per-placement work stops being *components* and becomes
 * *rows of data*. One array, serialised to the UI thread once per re-cut, and
 * one mapper that walks it. Nothing here is per song except the numbers.
 *
 * What this deliberately does not move yet: the row's text and the player's
 * chrome. Those stay as nodes until this proves the frame budget on hardware,
 * which is the whole point of doing it in this order — see the note on
 * `NativePlacementFlight`.
 */
export type FaceFlight = Readonly<{
  /** The song, for its stamps; see `faceAtlas.ts`. */
  entityKey: string;
  /**
   * The song as every lens draws it, in `LENSES` order: what each lens's
   * `identity` built from the recipe (see `lenses/contract.ts`). Every lens,
   * not just the one showing, so a lens change hands the canvas nothing new.
   */
  identities: readonly LensIdentity[];
  /**
   * Every lens's player (`Lens.player`), in `LENSES` order — only for the one
   * face that is the player, whose model is built for one song, not the field.
   */
  players?: readonly (LensPlayer | null)[];
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  fromBloomX: number;
  fromBloomY: number;
  targetBloomX: number;
  targetBloomY: number;
  ownership: FlightOwnership;
  fromAlpha: number;
  targetAlpha: number;
  /** The availability alpha this face is drawn at; see `FACE_STROKE_ALPHA`. */
  weight: number;
  /** How filled it is: a downloaded song is filled rather than outlined. */
  fill: number;
  /**
   * The same two where the face stood when its ink last changed, reached by
   * the arrival clock; equal to the targets when nothing is arriving. See
   * `arriveInk`.
   */
  fromWeight: number;
  fromFill: number;
  /**
   * The song's download, as the lens draws it (`ARRIVING_NONE`, a fraction,
   * or `ARRIVING_UNKNOWN` when the node offered no size).
   */
  arriving: number;
  /** The one placement the camera has arrived at, which grows into the player. */
  isPlayer: boolean;
  /** The one song making sound, which wears the ring. */
  playing: boolean;
  /**
   * When this song opens out of a point, in ms on the opening clock; −1 when
   * it is not arriving. See `features/field/opening.ts`.
   */
  openAt: number;
  /** The flight's own window and bow in a gather; null in any other re-cut. */
  timing: FlightTiming | null;
  /** Whether it is headed for find's found shelf, which never recedes. */
  found: boolean;
}>;

/**
 * The circle's position in `LENSES`: the lens a clock with nothing to say
 * rests on (`drawFieldFaces`' defaults).
 */
const CIRCLE_LENS = lensIndex('name');

/**
 * The hand-written player morph for a change between these two lenses, either
 * way round, or null for the generic two beats.
 */
function pairMorphFor(from: number, to: number): LensPairUi | null {
  'worklet';
  for (let index = 0; index < LENS_PAIRS.length; index++) {
    const pair = LENS_PAIRS[index];
    if (
      (pair.a === from && pair.b === to) ||
      (pair.a === to && pair.b === from)
    ) {
      return pair;
    }
  }
  return null;
}

/**
 * How much of the lenses showing, together, answers yes to one of `LensUi`'s
 * numbers — `ringTicks` or `hearsPlayhead` — weighed by how much of each is
 * showing.
 */
function lensesShowing(
  of: 'ringTicks' | 'hearsPlayhead',
  from: number,
  to: number,
  t: number,
): number {
  'worklet';
  if (from === to) return LENS_UI[to][of];
  return (
    lensWeight(from, from, to, t) * LENS_UI[from][of] +
    lensWeight(to, from, to, t) * LENS_UI[to][of]
  );
}

/**
 * The field's faces as plain rows, built once per re-cut on the JS thread.
 *
 * Every field here is a number, a boolean, or an `SkPath` — which is a host
 * object and so crosses to the UI thread by reference. There is nothing in it
 * that has to be rebuilt when the camera moves, which is what lets one mapper
 * own the whole field.
 */
export function faceFlightsOf(
  flights: readonly PlacementFlight[],
  presentations: ReadonlyMap<string, FieldPresentation>,
  focusKey: string | null,
  playingKey: string | null,
  analyses?: ReadonlyMap<string, SongAnalysis>,
  ink?: InkArrival,
  covers?: ReadonlyMap<string, CoverArt>,
  opening?: ReadonlyMap<string, number>,
): readonly FaceFlight[] {
  const result: FaceFlight[] = [];
  for (const flight of flights) {
    const presentation = presentations.get(flight.entityKey);
    if (presentation === undefined) continue;
    const to = ink?.to.get(flight.entityKey) ?? songInkOf(presentation);
    const from = ink?.from.get(flight.entityKey) ?? to;
    const recipe = presentation.recipe;
    const isPlayer =
      focusKey !== null && flight.targetPlacementKey === focusKey;
    result.push({
      entityKey: flight.entityKey,
      identities: LENSES.map(lens => lens.identity(recipe)),
      players: isPlayer
        ? LENSES.map(lens =>
            lens.player(
              recipe,
              analyses?.get(flight.entityKey),
              covers?.get(flight.entityKey) ?? null,
            ),
          )
        : undefined,
      fromX: flight.fromX,
      fromY: flight.fromY,
      targetX: flight.targetX,
      targetY: flight.targetY,
      fromBloomX: flight.fromBloomX,
      fromBloomY: flight.fromBloomY,
      targetBloomX: flight.targetBloomX,
      targetBloomY: flight.targetBloomY,
      ownership: flight.ownership,
      fromAlpha: flight.fromAlpha,
      targetAlpha: flight.targetAlpha,
      weight: to.stroke,
      fill: to.fill,
      fromWeight: from.stroke,
      fromFill: from.fill,
      arriving: arrivingOf(presentation),
      // The same two questions `NativePlacementFlight` asks, asked here so the
      // gate travels with the row rather than being chosen beside it. A pose
      // shared across the field is how every mark once grew into the player.
      isPlayer,
      playing: flight.entityKey === playingKey,
      openAt: opening?.get(flight.entityKey) ?? -1,
      timing: flight.timing ?? null,
      found: isFoundGroup(flight.groupKey),
    });
  }
  return result;
}

/** The paints a field of faces needs, built once per palette. */
type FacePaints = Readonly<{
  fill: SkPaint;
  stroke: SkPaint;
  ring: SkPaint;
  /** The ground, for the seal's bead, which is a hole in the thread. */
  paper: SkPaint;
  /** What stamps are drawn with; their ink is in the image. */
  stamp?: SkPaint;
}>;

function createFacePaints(palette: Palette): FacePaints {
  const stroke = paint(palette.ink);
  stroke.setStyle(PaintStyle.Stroke);
  const ring = paint(palette.ink);
  ring.setStyle(PaintStyle.Stroke);
  ring.setStrokeWidth(NAME_LENS_KNOBS.PLAYING_RING_WIDTH_PX);
  const stamp = Skia.Paint();
  stamp.setAntiAlias(true);
  return {
    fill: paint(palette.ink),
    stroke,
    ring,
    paper: paint(palette.bg),
    stamp,
  };
}

/**
 * Draw every face in the field, at this frame's camera.
 *
 * The camera's answers are read once and then reused down the loop, which is
 * the structural win over a mapper per placement: there, every song recomputed
 * the same band alphas and the same walk because a worklet cannot see its
 * neighbour's work. Here the only per-row arithmetic is the seat it is flying
 * between and the alpha it owns.
 *
 * The paints are mutated rather than rebuilt: `drawPath` copies paint state
 * into the display list at the call, so one paint can carry a different alpha
 * for every face without allocating one each.
 */
export function drawFieldFaces(
  canvas: SkCanvas,
  faces: readonly FaceFlight[],
  paints: FacePaints,
  progress: number,
  recut: NativeRecut,
  cameraShared: SharedValue<Camera>,
  fitScaleShared: SharedValue<number>,
  viewport: Viewport,
  /** The lens clock, read by the caller: see `lensClock.ts`. */
  lensFrom = CIRCLE_LENS,
  lensTo = CIRCLE_LENS,
  lensT = 1,
  reducedMotion = false,
  soundProgress = 1,
  heard = -1,
  /** The ink arrival's clock; see `arriveInk`. */
  arrival = 1,
  /** The opening clock, elapsed ms; see `openedAt`. */
  openingMs = Infinity,
  /** The map behind find's gather; null in any other re-cut. */
  recede: Recede | null = null,
  /** The gather's two cameras; null in any other re-cut. */
  gather: GatherCameras | null = null,
  /**
   * In a gather, which faces: 0 all, 1 the map's (under the map's names), 2
   * the shelf's (over the map's names).
   */
  side = 0,
  /** Plain marks as stamps rather than paths; see `faceAtlas.ts`. */
  stamping: FaceStamping | null = null,
  /** The music at this moment, for the player; see `MotionFrame`. */
  motion: MotionFrame | null = null,
  /** Whether the player has motion at all, even while `motion` is withheld. */
  motionOn = false,
  /** The motion layer the player is handed to once landed; see `PlayerMotionLayer`. */
  motionLayer: PlayerLayer | null = null,
): void {
  'worklet';
  /*
   * Changing lens, in two beats: the lens being left draws itself in to a
   * point, then the one arriving opens out of that point. Scale, not opacity,
   * so neither drawing is ever a ghost of itself — and the lens clock is
   * linear, so running it backwards plays the same two beats the other way.
   * Reduced motion crossfades instead, as the rest of the canvas does.
   */
  const lensAt = Math.min(Math.max(lensT, 0), 1);
  const leavingScale = reducedMotion
    ? 1
    : 1 - smootherstep(Math.min(Math.max(lensAt * 2, 0), 1));
  const leavingInk = reducedMotion ? 1 - smootherstep(lensAt) : 1;
  const comingScale = reducedMotion
    ? 1
    : smootherstep(Math.min(Math.max(lensAt * 2 - 1, 0), 1));
  const comingInk = reducedMotion ? smootherstep(lensAt) : 1;
  // Both lenses in play, in `LENSES` order so the draw order never depends
  // on the direction of the change; one when the clock is at rest.
  const firstLens = lensFrom < lensTo ? lensFrom : lensTo;
  const lastLens = lensFrom < lensTo ? lensTo : lensFrom;
  const p = Math.min(Math.max(progress, 0), 1);
  // A gather's faces each keep a window of the clock: the linear time it is
  // cut from, recovered once for the whole field.
  const linear = recede === null ? p : linearOfEased(p);
  const live = p >= 1 ? cameraShared.value : null;
  const cameraX =
    live === null
      ? recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p
      : live.x;
  const cameraY =
    live === null
      ? recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p
      : live.y;
  const cameraScale = nativeCameraScale(p, recut, cameraShared);
  const fitted = nativeFitScale(p, recut, fitScaleShared);
  const bloom = 1 - gatherFraction(cameraScale, fitted);
  // Every band and every arrival the field shares, answered once.
  const dot = bandAlphaAt(cameraScale, fitted, REPRESENTATION_WINDOWS.dot);
  const becomingRow = bandAlphaAt(
    cameraScale,
    fitted,
    REPRESENTATION_WINDOWS.row,
  );
  const walked = faceArrival(cameraScale, fitted);
  const rowOnly =
    1 - bandAlphaAt(cameraScale, fitted, REPRESENTATION_WINDOWS.song);
  // The player's two answers, which exactly one row in the field may use. Held
  // beside the mark's rather than chosen into a shared value, so that no
  // hoisting can widen them to the whole field.
  const playerShapeArrived = songShapeArrival(cameraScale, fitted);
  const playerArrived = bandAlphaAt(
    cameraScale,
    fitted,
    REPRESENTATION_WINDOWS.song,
  );
  // Below the map's own scale a mark shrinks with the world, so the overview
  // is the map in miniature; see `overviewShrink`.
  const shrink = overviewShrink(cameraScale, fitted);
  const markAt = facePoseAt(walked, 0, viewport, FACE_GROWTH);
  const markPose = { ...markAt, scale: markAt.scale * shrink };
  const playerPose = facePoseAt(
    walked,
    playerShapeArrived,
    viewport,
    FACE_GROWTH,
  );

  /*
   * Find's gather draws through two cameras (`GatherCameras`): the map's,
   * held where you stood and settling back as it recedes, and the shelf's,
   * which is the real one. A face is placed between their two pictures of
   * it, and drawn somewhere between a mark and a row, by its own progress.
   */
  const drawn = gatherDrawn(gather, recede, p);
  const mapCam =
    drawn === null ? null : mapCameraAt(drawn.map, recede, linear);
  /*
   * Settled, the shelf follows the live camera — it scrolls, and you go down
   * into its songs — but only while that camera stands at the shelf: a cut
   * back to the map lands before this scene gives way to the next one.
   */
  const liveAtShelf =
    live !== null && live.scale / fitted >= LEVEL_BOUNDARIES.field
      ? live
      : null;
  const shelfTo =
    gather === null ? null : liveAtShelf ?? gather.toShelf ?? live;
  const mapWalked =
    mapCam === null ? walked : faceArrival(mapCam.scale, fitted);
  const mapShrink =
    mapCam === null ? shrink : overviewShrink(mapCam.scale, fitted);
  // Plain marks are stamped from an image drawn at the marks' size, in the
  // order the faces are met; see `faceAtlas.ts`. The map's marks: in find's
  // gather the real camera stands at the found shelf, whose faces are the
  // few drawn as paths.
  const atlas =
    stamping === null
      ? null
      : faceAtlasFor(
          stamping,
          firstLens === lastLens ? [firstLens] : [firstLens, lastLens],
          mapCam === null
            ? markPose.scale
            : facePoseAt(mapWalked, 0, viewport, FACE_GROWTH).scale *
                mapShrink,
          paints,
        );
  const batch = createStampBatch(stamping === null ? null : stamping.pool.value);
  const layerAlphas = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const mapShown =
    mapCam === null
      ? 1
      : Math.min(
          1,
          bandAlphaAt(mapCam.scale, fitted, REPRESENTATION_WINDOWS.dot) +
            bandAlphaAt(mapCam.scale, fitted, REPRESENTATION_WINDOWS.row),
        );
  // The shelf side looks as the shelf's camera sees it — which is the real
  // camera, except while a leave cuts that back to the map.
  const shelfScale =
    drawn === null
      ? cameraScale
      : (liveAtShelf !== null && drawn.toShelf !== null
          ? liveAtShelf
          : drawn.toShelf ?? drawn.fromShelf ?? cameraShared.value
        ).scale;
  const shelfShown = Math.min(
    1,
    bandAlphaAt(shelfScale, fitted, REPRESENTATION_WINDOWS.dot) +
      bandAlphaAt(shelfScale, fitted, REPRESENTATION_WINDOWS.row),
  );
  const shelfWalked = faceArrival(shelfScale, fitted);
  const shelfShrink = overviewShrink(shelfScale, fitted);

  // Whether this pass met the player; if not, the motion layer has none. In
  // find's gather the player is on the found shelf (side 2): the map's side
  // never holds it, and must not take it from the layer.
  let playerSeen = false;
  const releaseLayer = () => {
    if (side === 1) return;
    if (motionLayer !== null && !playerSeen && motionLayer.draw.value !== null) motionLayer.draw.value = null;
  };
  const drawOne = (face: FaceFlight) => {
    const timing = face.timing;
    const u = timing === null ? p : flightProgressAt(timing, linear);
    const owner =
      flightOwnerAlpha(face.ownership, face.fromAlpha, face.targetAlpha, u) *
      gatherFaceInk(recede, linear, timing, face.found, u);
    if (owner <= 0) return;
    // A song just arrived opens out of a point, as a lens's coming beat does;
    // reduced motion fades it in instead.
    const opened = openedAt(face.openAt, openingMs);
    if (opened <= 0) return;
    const openScale = reducedMotion ? 1 : opened;
    const shapeArrived = face.isPlayer ? playerShapeArrived : 0;
    const arrived = face.isPlayer ? playerArrived : 0;
    // In a gather: which picture of the face each end is.
    const fromShelf = timing !== null && timing.fromFound;
    const twoCameras = mapCam !== null && !face.isPlayer;
    const atS = timing === null ? 0 : timing.sideFrom;
    const atT = face.found ? 1 : 0;
    const towardShelf = atS + (atT - atS) * u;
    const shown = twoCameras
      ? mapShown + (shelfShown - mapShown) * towardShelf
      : Math.min(1, dot + becomingRow + arrived);
    // The map gives way as you go down into a song, as the study's does.
    const mapLeft = twoCameras ? 1 - (1 - towardShelf) * playerArrived : 1;
    const opacity =
      owner * shown * mapLeft * (reducedMotion ? opened : 1);
    if (opacity <= 0) return;

    let x = 0;
    let y = 0;
    let faceWalked = walked;
    let faceShrink = shrink;
    if (twoCameras && mapCam !== null && gather !== null) {
      const target = face.found ? shelfTo ?? cameraShared.value : mapCam;
      const source = fromShelf ? gather.fromShelf ?? target : mapCam;
      const point = flightOnScreen(
        face.fromX,
        face.fromY,
        face.fromBloomX,
        face.fromBloomY,
        face.targetX,
        face.targetY,
        face.targetBloomX,
        face.targetBloomY,
        source,
        target,
        fitted,
        viewport,
        u,
        timing === null ? 0 : timing.bowPx,
      );
      x = point.x;
      y = point.y;
      faceWalked = mapWalked + (shelfWalked - mapWalked) * towardShelf;
      faceShrink = mapShrink + (shelfShrink - mapShrink) * towardShelf;
    } else {
      const seatX = face.fromX + (face.targetX - face.fromX) * u;
      const seatY = face.fromY + (face.targetY - face.fromY) * u;
      const bloomX =
        face.fromBloomX + (face.targetBloomX - face.fromBloomX) * u;
      const bloomY =
        face.fromBloomY + (face.targetBloomY - face.fromBloomY) * u;
      const bow =
        timing === null || timing.bowPx === 0
          ? null
          : bowOffsetAt(
              face.targetX - face.fromX,
              face.targetY - face.fromY,
              timing.bowPx,
              u,
            );
      x =
        (seatX + bloomX * bloom - cameraX) * cameraScale +
        viewport.width / 2 +
        (bow?.x ?? 0);
      y =
        (seatY + bloomY * bloom - cameraY) * cameraScale +
        viewport.height / 2 +
        (bow?.y ?? 0);
    }
    // Culling, at the live camera and on the frame it is true — which is the
    // thing the node renderer could not do, because its answer would have had
    // to come back through React to unmount anything.
    const faceAt =
      twoCameras ? facePoseAt(faceWalked, 0, viewport, FACE_GROWTH) : markAt;
    const pose = face.isPlayer
      ? playerPose
      : twoCameras
      ? { ...faceAt, scale: faceAt.scale * faceShrink }
      : markPose;
    if (
      x + pose.x < -FIELD_CANVAS_KNOBS.OVERSCAN_PX ||
      x + pose.x > viewport.width + FIELD_CANVAS_KNOBS.OVERSCAN_PX ||
      y + pose.y < -FIELD_CANVAS_KNOBS.OVERSCAN_PX ||
      y + pose.y > viewport.height + FIELD_CANVAS_KNOBS.OVERSCAN_PX
    ) {
      return;
    }

    const weight = mix(face.fromWeight, face.weight, arrival);
    const fill = mix(face.fromFill, face.fill, arrival);
    const players = face.players;
    if (atlas !== null && players === undefined && !face.playing) {
      // Every pass of the face stamped, or none: a face is one object.
      const passCount = firstLens === lastLens ? 1 : 2;
      let stampable = true;
      for (let pass = 0; pass < passCount && stampable; pass++) {
        const lens = pass === 0 ? firstLens : lastLens;
        const coming = lens === lensTo;
        const size =
          pose.scale * openScale * (coming ? comingScale : leavingScale);
        const ink = coming ? comingInk : leavingInk;
        if (ink <= 0 || size <= 0.001) {
          layerAlphas[pass][0] = -1;
          continue;
        }
        const sprites = LENS_UI[lens].sprites;
        stampable =
          sprites !== undefined &&
          canStamp(atlas, lens, face.entityKey, face.identities[lens], size) &&
          sprites.alphas(
            opacity * ink,
            weight,
            fill,
            face.arriving,
            layerAlphas[pass],
          );
      }
      if (stampable) {
        for (let pass = 0; pass < passCount; pass++) {
          if (layerAlphas[pass][0] === -1) continue;
          const lens = pass === 0 ? firstLens : lastLens;
          const coming = lens === lensTo;
          const sprites = LENS_UI[lens].sprites;
          if (sprites === undefined) continue;
          stampFace(
            batch,
            atlas,
            lens,
            face.entityKey,
            x + pose.x,
            y + pose.y,
            pose.scale * openScale * (coming ? comingScale : leavingScale),
            layerAlphas[pass],
            sprites.layers,
            stamping === null ? 1 : stamping.pixelRatio,
          );
        }
        return;
      }
    }
    // Drawn as paths: what was stamped before it goes down first.
    flushStamps(canvas, batch, atlas, paints.stamp ?? paints.fill);
    canvas.save();
    canvas.translate(x + pose.x, y + pose.y);
    const pair =
      players === undefined || reducedMotion || lensFrom === lensTo
        ? null
        : pairMorphFor(lensFrom, lensTo);
    // How far the pair's morph stands toward its `b`, whichever way it runs.
    const towardB = pair === null ? 0 : lensTo === pair.b ? lensAt : 1 - lensAt;
    if (pair !== null && players !== undefined && towardB > 0) {
      // The player morphs rather than trading places: see `lenses/pairs.ts`.
      // At 0 it is `a` drawn by itself, below — the morph at 0 is `a` only
      // as nearly as its line approximates `a`'s contour.
      pair.drawPlayer(
        canvas,
        face.identities[pair.a],
        players[pair.a],
        face.identities[pair.b],
        players[pair.b],
        towardB,
        pose.scale * openScale,
        opacity,
        weight,
        fill,
        shapeArrived,
        face.arriving,
        soundProgress,
        heard,
        FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
        paints,
        motion,
      );
    } else {
      const passes = firstLens === lastLens ? 1 : 2;
      /*
       * The player with its lens at rest, fully arrived, while its song
       * moves: the motion layer's to draw. The field says where it is, and
       * leaves it out once the layer has drawn it — a frame of both rather
       * than a frame of neither, since two surfaces cannot promise one vsync.
       */
      // Landed is the player fully arrived, not the cut's clock: an ascent
      // moves the camera live with the clock already at 1, and the player
      // must follow it from the first frame.
      const owned =
        motionLayer !== null &&
        players !== undefined &&
        passes === 1 &&
        motionOn &&
        progress >= 1 &&
        shapeArrived >= LAYER_ARRIVED;
      if (motionLayer !== null && players !== undefined) {
        playerSeen = true;
        const lens = firstLens;
        const before = motionLayer.draw.value;
        const drawX = x + pose.x;
        const drawY = y + pose.y;
        const drawSize = pose.scale * openScale * (lens === lensTo ? comingScale : leavingScale);
        const drawAlpha = opacity * (lens === lensTo ? comingInk : leavingInk);
        if (
          before === null ||
          before.owned !== owned ||
          before.lens !== lens ||
          before.x !== drawX ||
          before.y !== drawY ||
          before.size !== drawSize ||
          before.alpha !== drawAlpha ||
          before.weight !== weight ||
          before.fill !== fill ||
          before.arrived !== shapeArrived ||
          before.arriving !== face.arriving ||
          before.soundIn !== soundProgress ||
          before.heard !== heard ||
          before.player !== players[lens] ||
          before.identity !== face.identities[lens]
        ) {
          motionLayer.draw.value = {
            owned,
            lens,
            identity: face.identities[lens],
            player: players[lens],
            x: drawX,
            y: drawY,
            size: drawSize,
            alpha: drawAlpha,
            weight,
            fill,
            arrived: shapeArrived,
            arriving: face.arriving,
            soundIn: soundProgress,
            heard,
          };
        }
      }
      const handedOver = owned && motionLayer !== null && motionLayer.showing.value;
      for (let pass = 0; pass < passes; pass++) {
        if (handedOver) break;
        const lens = pass === 0 ? firstLens : lastLens;
        const coming = lens === lensTo;
        const size =
          pose.scale * openScale * (coming ? comingScale : leavingScale);
        const ink = coming ? comingInk : leavingInk;
        if (ink <= 0 || size <= 0.001) continue;
        if (players !== undefined) {
          LENS_UI[lens].drawPlayer(
            canvas,
            players[lens],
            face.identities[lens],
            size,
            opacity * ink,
            weight,
            fill,
            shapeArrived,
            face.arriving,
            soundProgress,
            heard,
            FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
            paints,
            motion,
          );
        } else {
          LENS_UI[lens].drawMark(
            canvas,
            face.identities[lens],
            size,
            opacity * ink,
            weight,
            fill,
            shapeArrived,
            face.arriving,
            FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
            paints,
          );
        }
      }
    }
    canvas.restore();

    // Outside the face's own scale, for the reason the node tree gave: the
    // ring's radius is the face's extent *plus a gap*, so it is not a multiple
    // of the face and scaling it would carry the gap along.
    if (face.playing) {
      const ringWalked = twoCameras ? faceWalked : walked;
      const ringShrink = twoCameras ? faceShrink : shrink;
      paints.ring.setAlphaf(opacity * rowOnly);
      canvas.drawCircle(
        x - NAME_LENS_KNOBS.ROW_PREVIEW_OFFSET_PX * ringWalked,
        y,
        (MARK_RING_RADIUS_PX +
          (ROW_RING_RADIUS_PX - MARK_RING_RADIUS_PX) * ringWalked) *
          ringShrink,
        paints.ring,
      );
    }
  };

  if (mapCam === null) {
    for (let index = 0; index < faces.length; index++) drawOne(faces[index]);
    flushStamps(canvas, batch, atlas, paints.stamp ?? paints.fill);
    releaseLayer();
    return;
  }
  // The map first, then the shelf.
  if (side !== 2) {
    for (let index = 0; index < faces.length; index++) {
      const face = faces[index];
      if (!face.found && !(face.timing !== null && face.timing.fromFound)) {
        drawOne(face);
      }
    }
  }
  if (side === 1) {
    flushStamps(canvas, batch, atlas, paints.stamp ?? paints.fill);
    releaseLayer();
    return;
  }
  for (let index = 0; index < faces.length; index++) {
    const face = faces[index];
    if (face.found || (face.timing !== null && face.timing.fromFound)) {
      drawOne(face);
    }
  }
  flushStamps(canvas, batch, atlas, paints.stamp ?? paints.fill);
  releaseLayer();
}

/**
 * The easing every clock on this canvas runs on.
 *
 * Written above its callers, and it has to be: the worklets plugin captures a
 * `'worklet'` helper into the closure of whoever calls it, at the point the
 * *caller* is defined — so a helper below its caller arrives as `undefined` on
 * the UI thread. `bands.ts` states the same rule over its own worklet section.
 */
function nativeSmootherstep(value: number): number {
  'worklet';
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * KNOBS — how the ring becomes the grain.
 *
 * The unroll spans the two levels it joins: it begins where the player is
 * fully arrived and ends where L3 opens, both taken from the zoom model rather
 * than tuned separately, so the gesture cannot drift away from the levels it
 * is a crossing between.
 */
const UNROLL_KNOBS = {
  /** Where the ring starts to open, in multiples of FIT. */
  FROM_RATIO: LEVEL_SCALE_RATIOS.song,
  /** Where it is a straight line, which is where the grain begins. */
  TO_RATIO: GRAIN_KNOBS.ENTRY_RATIO,
  /** How long the decoded detail takes to resolve into the coarse ticks. */
  RESOLVE_MS: 320,
} as const;

/**
 * The song's own measurement, as plain rows the UI thread can hold.
 *
 * `Float32Array` cannot cross into a worklet, which is the same reason
 * `levelsOf` exists one level up.
 */
export type GrainBars = Readonly<{
  min: readonly number[];
  max: readonly number[];
  startSeconds: number;
  endSeconds: number;
  label: string;
}>;

/** Flatten a decoded window into something a worklet can read. */
export function grainBarsOf(grain: GrainRender | null): GrainBars | null {
  if (grain === null) return null;
  const channel = grain.window.channels[0];
  if (channel === undefined || grain.window.buckets <= 0) return null;
  return {
    min: Array.from(channel.min),
    max: Array.from(channel.max),
    startSeconds: grain.window.startSeconds,
    endSeconds: grain.window.endSeconds,
    label: grain.label,
  };
}

/**
 * Where the song being looked at sits, and how loud it is.
 *
 * The seat rather than a screen point, because the ring has to stay concentric
 * with the face on every frame of the crossing and the face is drawn from the
 * seat. Everything else here is a function of the song alone.
 */
export type SongDetailModel = Readonly<{
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  fromBloomX: number;
  fromBloomY: number;
  targetBloomX: number;
  targetBloomY: number;
  levels: readonly number[];
  durationSeconds: number;
}>;

/**
 * The measurement, from the ring it is drawn on to the grain it becomes.
 *
 * One drawing and two poses, which is the same claim the face makes across
 * three. A tick at `turn` through the song is a spoke about the player's
 * centre at one end of the crossing and a column on the grain's own time axis
 * at the other, and it is drawn between them the whole way — so the ring does
 * not hand over to the waveform, it *is* the waveform, opened out.
 *
 * The axis opens as it straightens. At the ring the whole song is the circle;
 * at L3 only `ENTRY_SECONDS` are on screen. Interpolating the visible span
 * geometrically rather than linearly is what makes that read as one continuous
 * zoom into the playhead rather than as a stretch — the same reason the camera
 * carries scale in logs.
 *
 * The decoded detail resolves *into* the ticks rather than replacing them:
 * they are the same measurement at two resolutions, and the coarse one is
 * already in the right place by the time the fine one has been read off the
 * disk.
 */
export function drawSongDetail(
  canvas: SkCanvas,
  model: SongDetailModel,
  paints: FacePaints,
  progress: number,
  recut: NativeRecut,
  cameraShared: SharedValue<Camera>,
  fitScaleShared: SharedValue<number>,
  positionSeconds: SharedValue<number> | null,
  grain: GrainBars | null,
  resolved: number,
  drawn: number,
  viewport: Viewport,
  lensProgress = 0,
  /** The music at this moment; see `MotionFrame`. */
  motion: MotionFrame | null = null,
): void {
  'worklet';
  if (drawn <= 0) return;
  const p = Math.min(Math.max(progress, 0), 1);
  const cameraScale = nativeCameraScale(p, recut, cameraShared);
  const fitted = nativeFitScale(p, recut, fitScaleShared);
  if (!(fitted > 0)) return;
  const ratio = cameraScale / fitted;
  const opacity = songDetailOpacity(ratio);
  if (opacity <= 0) return;
  const opening =
    (ratio - UNROLL_KNOBS.FROM_RATIO) /
    (UNROLL_KNOBS.TO_RATIO - UNROLL_KNOBS.FROM_RATIO);
  const unrolled = nativeSmootherstep(
    opening < 0 ? 0 : opening > 1 ? 1 : opening,
  );

  // The ring's own centre: the face's seat under this frame's camera, plus the
  // pose the face is standing at. Computed rather than assumed, so a re-cut or
  // a flight still in the air keeps the spokes on the contour they grew from.
  const live = p >= 1 ? cameraShared.value : null;
  const cameraX =
    live === null
      ? recut.fromCamera.x + (recut.toCamera.x - recut.fromCamera.x) * p
      : live.x;
  const cameraY =
    live === null
      ? recut.fromCamera.y + (recut.toCamera.y - recut.fromCamera.y) * p
      : live.y;
  const bloom = 1 - gatherFraction(cameraScale, fitted);
  const seatX = model.fromX + (model.targetX - model.fromX) * p;
  const seatY = model.fromY + (model.targetY - model.fromY) * p;
  const bloomX = model.fromBloomX + (model.targetBloomX - model.fromBloomX) * p;
  const bloomY = model.fromBloomY + (model.targetBloomY - model.fromBloomY) * p;
  const pose = facePoseAt(
    faceArrival(cameraScale, fitted),
    songShapeArrival(cameraScale, fitted),
    viewport,
    FACE_GROWTH,
  );
  const cx =
    (seatX + bloomX * bloom - cameraX) * cameraScale +
    viewport.width / 2 +
    pose.x;
  const cy =
    (seatY + bloomY * bloom - cameraY) * cameraScale +
    viewport.height / 2 +
    pose.y;

  const knobs = PLAYER_RING_KNOBS;
  const radius = playerRadiusPx(viewport.width);
  const inner = radius * PLAYER_POSE_KNOBS.SONG_ARC_RATIO;
  const midY = viewport.height / 2;
  const half = viewport.height * FIELD_CANVAS_KNOBS.GRAIN_HEIGHT_RATIO;
  const duration = model.durationSeconds;
  const at =
    positionSeconds === null || duration <= 0
      ? 0
      : positionSeconds.value / duration;
  const head = at < 0 ? 0 : at > 1 ? 1 : at;
  // The window the axis is showing, opening from the whole song to L3's own.
  /*
   * The window the axis is showing, opening from the whole song to L3's own.
   *
   * The far end is the *decoded* window's span rather than `ENTRY_SECONDS`,
   * because the two part company as soon as you are past L3's entry:
   * `visibleSecondsAt` keeps halving the span for every doubling of scale, so
   * at the grain seat it asks for about three seconds, not twelve. Held at
   * twelve the axis drew a three-second window across a quarter of the screen
   * and left the rest empty. Following it, the detail fills the width at every
   * distance, and going further in is the axis closing rather than the drawing
   * shrinking.
   */
  const shownSpan =
    grain === null
      ? GRAIN_KNOBS.ENTRY_SECONDS
      : Math.max(
          GRAIN_KNOBS.MIN_SECONDS,
          grain.endSeconds - grain.startSeconds,
        );
  const span =
    duration <= 0
      ? shownSpan
      : Math.exp(
          Math.log(duration) +
            (Math.log(shownSpan) - Math.log(duration)) * unrolled,
        );
  const perTurn = span > 0 ? (duration / span) * viewport.width : 0;
  /*
   * The second the axis is centred on, which is the playhead until it cannot be.
   *
   * `grainWindow` slides its window to stay inside the song rather than
   * letting it hang off an end, so at the very start the playhead is the
   * window's left edge and not its middle. Centring the drawing on the
   * playhead there put twelve seconds of audio in the right half of the screen
   * and nothing in the left — and a song opened and not yet played is at
   * exactly that position, which makes it the common case rather than an edge
   * one.
   *
   * So the axis follows the window's own centre. Away from the ends the two
   * are the same second and this changes nothing; at them, the detail fills
   * the screen and the playhead sits where it honestly falls. The ticks read
   * the same centre, so the coarse measurement and the fine one stay over each
   * other either way.
   */
  const axisSeconds =
    grain === null
      ? head * duration
      : (grain.startSeconds + grain.endSeconds) / 2;
  const axis = duration > 0 ? axisSeconds / duration : 0;

  const levels = model.levels;
  const levelCount = levels.length;
  /*
   * The coarse measurement between its own samples.
   *
   * `levels` is one value per Cantor interval — thirty-two of them for the
   * whole song — and the axis below opens until a screen holds twelve seconds
   * of it. Read nearest-neighbour that is a staircase of two or three steps;
   * read between them it is an envelope, which is the honest drawing of a
   * measurement this coarse and the only one that survives the zoom.
   */
  const levelAt = (turn: number): number => {
    if (levelCount === 0) return 0;
    if (levelCount === 1) return levels[0] ?? 0;
    const at = Math.min(Math.max(turn, 0), 1) * (levelCount - 1);
    const lower = Math.floor(at);
    const upper = Math.min(levelCount - 1, lower + 1);
    const t = at - lower;
    return (levels[lower] ?? 0) * (1 - t) + (levels[upper] ?? 0) * t;
  };
  /*
   * The bulge at the playhead: the coarse level over half a turn, or — while
   * the song's motion has risen — the music at this moment over a tenth
   * (`ringMotionLevel`), so it lifts with each hit and lets go between them.
   * The motion leaves as the ring unrolls: on the axis the playhead stands
   * still in the middle, and a bulge riding it would only pulse in place.
   */
  const moving = motion === null ? 0 : motion.presence * (1 - unrolled);
  const now = levelAt(head) * (1 - moving) + (motion === null ? 0 : ringMotionLevel(motion)) * moving;
  const pulseWindow =
    knobs.SONG_PULSE_WINDOW + (RING_MOTION_KNOBS.WINDOW - knobs.SONG_PULSE_WINDOW) * moving;

  /*
   * How many ticks the measurement is drawn with, which grows as it opens.
   *
   * Fixed at ninety-six the ring was right and the axis was empty: the ticks
   * span the whole song, so once a screen holds a twelfth of it only eight
   * were left on screen. Growing the count with the spread holds the *screen*
   * spacing still instead — `width / SONG_WAVE_TICKS`, whatever the camera is
   * doing — so the measurement fills the axis it is opening onto.
   *
   * It is an upsample, not new information, and it is capped to say so: past
   * `SONG_WAVE_MAX_TICKS` the detail below has long since taken the drawing
   * over, and more ticks would only cost the frame.
   */
  const spread = span > 0 && duration > 0 ? duration / span : 1;
  const ticks = Math.max(
    knobs.SONG_WAVE_TICKS,
    Math.min(
      knobs.SONG_WAVE_MAX_TICKS,
      Math.round(knobs.SONG_WAVE_TICKS * spread),
    ),
  );

  // The detail arrives *as* the axis opens: it is a dense sliver at the
  // playhead while the ring is still a ring, and there is no room for it there.
  const detail = resolved * unrolled;
  const coarse =
    (1 - detail) * (1 - smootherstep(lensProgress) * (1 - unrolled));
  if (coarse > 0) {
    paints.stroke.setAlphaf(knobs.SONG_WAVE_ALPHA * coarse * opacity);
    paints.stroke.setStrokeWidth(knobs.SONG_WAVE_WIDTH_PX);
    for (let index = 0; index < ticks; index += 1) {
      const drew = writeSubAlpha(drawn, index, ticks);
      if (drew <= 0) continue;
      const turn = index / ticks;
      // Wrapped to the shortest way round, so the ticks behind the playhead
      // open to the left rather than racing the long way across the screen.
      const offset = turn - axis;
      const shortest =
        offset > 0.5 ? offset - 1 : offset < -0.5 ? offset + 1 : offset;
      // Off the end of the opened axis. Bounded before the trig rather than
      // after it, because the count grows with the zoom and most of the song
      // is off screen by the time it has: a tick is drawn between a circle no
      // wider than the player and a line this far out, so past a screen's
      // travel it cannot be on screen at all.
      if (unrolled * Math.abs(shortest) * perTurn > viewport.width) continue;

      const level = levelAt(turn);
      // The beat: a bulge that rides the playhead, which is not always the
      // second the axis is centred on. Wrapped, so it crosses twelve o'clock
      // on the ring without a seam.
      const toHead = Math.abs(turn - head);
      const gap = toHead > 0.5 ? 1 - toHead : toHead;
      const near = 1 - gap / pulseWindow;
      const lift = near > 0 ? near * near * now * knobs.SONG_PULSE_GAIN : 0;
      const amp = Math.min(1, level * knobs.SONG_WAVE_GAIN + lift) * drew;

      const angle = turn * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const outer = inner + amp * radius * knobs.SONG_WAVE_REACH_RATIO;
      const lineX = viewport.width / 2 + shortest * perTurn;
      const x0 = cx + cos * inner + (lineX - (cx + cos * inner)) * unrolled;
      const y0 =
        cy + sin * inner + (midY - amp * half - (cy + sin * inner)) * unrolled;
      const x1 = cx + cos * outer + (lineX - (cx + cos * outer)) * unrolled;
      const y1 =
        cy + sin * outer + (midY + amp * half - (cy + sin * outer)) * unrolled;
      canvas.drawLine(x0, y0, x1, y1, paints.stroke);
    }
  }

  if (grain === null || detail <= 0 || duration <= 0) return;
  const buckets = grain.min.length;
  const windowSpan = grain.endSeconds - grain.startSeconds;
  if (buckets <= 0 || windowSpan <= 0) return;
  /*
   * The detail, on the same axis and by the same clock.
   *
   * Placed by the second it was decoded from rather than by its index, which
   * is what makes it grow. The window is `ENTRY_SECONDS` wide whatever the
   * camera is doing, so while the axis still holds the whole song it is a
   * narrow dense band at the playhead, and it widens to fill the screen as the
   * axis closes on it. Same mapping as the ticks above, so the coarse
   * measurement and the fine one are over each other the whole way — the
   * crossfade has nowhere to slip.
   */
  paints.fill.setAlphaf(detail * opacity);
  const bucketSeconds = windowSpan / buckets;
  const columnWidth = (bucketSeconds / span) * viewport.width;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const seconds = grain.startSeconds + (bucket + 0.5) * bucketSeconds;
    const offset = seconds / duration - axis;
    const shortest =
      offset > 0.5 ? offset - 1 : offset < -0.5 ? offset + 1 : offset;
    const lineX = viewport.width / 2 + shortest * perTurn;
    // Blended out of the ring like the ticks are, and it has to be: the ring's
    // centre is a `playerRisePx` above the middle of the screen, so a column
    // drawn straight onto the axis sat below the ticks it is replacing for the
    // whole crossing, and the crossfade swapped one drawing for another a
    // finger's width away. Both ends of the same blend now, so they are over
    // each other at every frame of it.
    const centreX = cx + (lineX - cx) * unrolled;
    if (centreX < -columnWidth || centreX > viewport.width + columnWidth) {
      continue;
    }
    const low = grain.min[bucket] ?? 0;
    const high = grain.max[bucket] ?? 0;
    const top = cy + (midY - high * half - cy) * unrolled;
    const bottom = cy + (midY - low * half - cy) * unrolled;
    canvas.drawRect(
      {
        x: centreX - columnWidth / 2,
        y: Math.min(top, bottom),
        width: Math.max(0.7, columnWidth * 0.85),
        height: Math.max(0.7, Math.abs(bottom - top)),
      },
      paints.fill,
    );
  }
}

/**
 * The measurement's own element: one picture, two clocks, no React per frame.
 *
 * Held apart from the placement nodes because it outlives them — the song band
 * closes at 178 and the grain runs to the camera's ceiling — and because it is
 * viewport work rather than field work. Everything it needs that changes as
 * you move arrives through a shared value, so a decode landing mid-zoom does
 * not hand `Canvas` a fresh element.
 */
function NativeSongDetail({
  lensClock,
  model,
  clock,
  ink,
  songKey,
  recut,
  cameraShared,
  fitScaleShared,
  positionSeconds,
  grainShared,
  palette,
  viewport,
  motionFrame = null,
}: {
  lensClock: LensClock;
  model: SongDetailModel | null;
  clock: SharedValue<number>;
  /** Which song's measurement is fully drawn, across this layer's remounts. */
  ink: SharedValue<DetailInk>;
  songKey: string;
  recut: NativeRecut;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  positionSeconds: SharedValue<number> | null;
  grainShared: SharedValue<GrainBars | null>;
  palette: Palette;
  viewport: Viewport;
  /** The music at this moment, for the bulge at the playhead; see `drawSongDetail`. */
  motionFrame?: SharedValue<MotionFrame | null> | null;
}) {
  const paints = useMemo(() => createFacePaints(palette), [palette]);
  // The entry window has three states: reset only when hidden, reveal
  // when settled, and preserve the ink while the camera carries it out.
  const phase = useDerivedValue(() => {
    const fitted = nativeFitScale(clock.value, recut, fitScaleShared);
    const ratio =
      fitted > 0
        ? nativeCameraScale(clock.value, recut, cameraShared) / fitted
        : 0;
    return songDetailPhase(ratio);
  });
  /*
   * The layer is keyed by the cut, so a re-cut under a song you are already
   * in — a song just made landing in the same shelf — mounts it again with
   * the camera already there. Drawn in from nothing, the ticks wiped and
   * traced back in under a player that had not moved. A layer that takes
   * over a song whose measurement is already in starts it in — from its
   * first frame, not from the reaction below, which runs after it.
   */
  const drawn = useSharedValue(
    ink.value.key === songKey && ink.value.drawn ? 1 : 0,
  );
  useAnimatedReaction(
    () => phase.value,
    (next, before) => {
      if (next === before) return;
      cancelAnimation(drawn);
      if (next === 'hidden') {
        drawn.value = 0;
        ink.value = { key: songKey, drawn: false };
        return;
      }
      if (before === null && ink.value.key === songKey && ink.value.drawn) {
        drawn.value = 1;
        return;
      }
      if (next === 'reveal') {
        drawn.value = withTiming(
          1,
          {
            duration: PLAYER_RING_KNOBS.SONG_WAVE_DRAW_MS,
            easing: easeSmoother,
          },
          finished => {
            if (finished) ink.value = { key: songKey, drawn: true };
          },
        );
      }
    },
  );
  /*
   * A measurement that lands after the reveal draws itself in, rather than
   * appearing at whatever ink the reveal had already reached.
   *
   * The reveal is started by the camera, and the camera often arrives before
   * the decode does — so without this the ticks popped in, whole, seconds
   * after the descent. Declared ahead of the picture below on purpose: the
   * clock is back at zero before the picture's mapper is rebuilt around the
   * new levels, so no frame shows them at full ink first.
   */
  const hasLevels = (model?.levels.length ?? 0) > 0;
  const hadLevels = useRef(hasLevels);
  useEffect(() => {
    const arrived = hasLevels && !hadLevels.current;
    hadLevels.current = hasLevels;
    if (!arrived || phase.value === 'hidden') return;
    cancelAnimation(drawn);
    drawn.value = 0;
    drawn.value = withTiming(1, {
      duration: PLAYER_RING_KNOBS.SONG_WAVE_DRAW_MS,
      easing: easeSmoother,
    });
  }, [drawn, hasLevels, phase]);
  /** How much of the decoded detail has resolved into the coarse ticks. */
  const resolved = useSharedValue(0);
  useAnimatedReaction(
    () => grainShared.value !== null,
    (has, before) => {
      if (has === before) return;
      cancelAnimation(resolved);
      resolved.value = withTiming(has ? 1 : 0, {
        duration: UNROLL_KNOBS.RESOLVE_MS,
        easing: easeSmoother,
      });
    },
  );
  const picture = useDerivedValue(() =>
    createPicture(
      canvas => {
        if (model === null) return;
        drawSongDetail(
          canvas,
          model,
          paints,
          clock.value,
          recut,
          cameraShared,
          fitScaleShared,
          positionSeconds,
          grainShared.value,
          resolved.value,
          drawn.value,
          viewport,
          // The tick ring is the sound of the lenses that show it (the
          // circle's); it leaves as they do.
          1 -
            lensesShowing(
              'ringTicks',
              lensClock.from.value,
              lensClock.to.value,
              lensClock.t.value,
            ),
          motionFrame === null ? null : motionFrame.value,
        );
      },
      { width: viewport.width, height: viewport.height },
    ),
  );
  return <Picture picture={picture} />;
}

/** The song the camera has arrived at, as the detail loop needs it. */
function songDetailOf(
  flights: readonly PlacementFlight[],
  presentations: ReadonlyMap<string, FieldPresentation>,
  analyses: ReadonlyMap<string, SongAnalysis> | undefined,
  focusKey: string | null,
): SongDetailModel | null {
  if (focusKey === null) return null;
  const flight = flights.find(
    candidate => candidate.targetPlacementKey === focusKey,
  );
  if (flight === undefined) return null;
  const presentation = presentations.get(flight.entityKey);
  if (presentation === undefined) return null;
  return {
    fromX: flight.fromX,
    fromY: flight.fromY,
    targetX: flight.targetX,
    targetY: flight.targetY,
    fromBloomX: flight.fromBloomX,
    fromBloomY: flight.fromBloomY,
    targetBloomX: flight.targetBloomX,
    targetBloomY: flight.targetBloomY,
    levels: levelsOf(analyses?.get(flight.entityKey)),
    durationSeconds: presentation.durationMs / 1000,
  };
}

const NativeFieldContent = React.memo(function NativeFieldContent({
  scene,
  focus,
  focusReady,
  openingClock,
  lensClock,
  reducedMotion,
  drawnClock,
  cameraShared,
  fitScaleShared,
  viewport,
  transportPlaying,
  transportArriving,
  transportLights,
  positionSeconds,
  motionFrame,
  motionOn,
  layer,
  grainShared,
  jobMarks,
  hubPaths,
  displayFont,
  songTitleFont,
  songMetaFont,
  font: monoFont,
  palette,
}: NativeFieldContentProps) {
  const cutShared = scene.cut;
  const clock = scene.clock;
  // Where the canvas has drawn the cut to, for the camera hook, which
  // captures an interrupted gather from it.
  useAnimatedReaction(
    () => ({
      generation: cutShared.value === null ? 0 : cutShared.value.generation,
      eased: clock.value,
    }),
    drawn => {
      if (drawnClock !== null) drawnClock.value = drawn;
    },
  );
  const motion = useNativeCameraMotion(
    clock,
    cutShared,
    cameraShared,
    fitScaleShared,
    viewport,
  );
  /**
   * Which song's measurement has been drawn in, held across the focus
   * layer's remounts; see `NativeSongDetail`.
   */
  const detailInk = useSharedValue<DetailInk>({ key: null, drawn: false });
  /*
   * The whole field's faces, as one node and one mapper. See `drawFieldFaces`.
   *
   * Joined on the UI thread from the cut and the songs (`joinFaces`) when
   * either changes, and drawn every frame from the join: nothing here is
   * rebuilt by a re-cut, so no re-cut installs a worklet.
   */
  const facePaints = useMemo(() => createFacePaints(palette), [palette]);
  // The faces' stamps, drawn on the UI thread when the songs, the lenses
  // showing or the marks' size change; see `faceAtlas.ts`.
  const faceAtlas = useSharedValue<FaceAtlas | null>(null);
  const stampPool = useSharedValue<StampPool>({ xforms: [], colors: [] });
  useEffect(() => {
    // Their ink is the palette's.
    faceAtlas.value = null;
  }, [faceAtlas, facePaints]);
  const songs = scene.songs;
  const focusDraw = scene.focus;
  const playing = scene.playing;
  const inkFrom = scene.inkFrom;
  const openAt = scene.openAt;
  const inkClock = scene.inkClock;
  const soundClock = scene.soundClock;
  const faceFlights = useDerivedValue(() =>
    joinFaces(
      cutShared.value,
      songs.value,
      focusDraw.value,
      playing.value,
      inkFrom.value,
      openAt.value,
    ),
  );
  /*
   * A player's sound waits for the descent, as the circle's ring does.
   *
   * During the flight the seal only opens — its dots splitting into the dots
   * they hold — and the sound, the thread and the bead draw themselves on once
   * the camera has arrived. Riding the flight instead put every change the
   * player makes into the same few hundred milliseconds, and it read as the
   * seal stopping and then appearing. The same three phases as the ring's:
   * reset only while hidden, keep the ink while the camera carries it out.
   */
  const soundPhase = useDerivedValue(() => {
    const cut = cutShared.value;
    const nativeRecut = cut === null ? EMPTY_RECUT : cut.recut;
    const fitted = nativeFitScale(clock.value, nativeRecut, fitScaleShared);
    const ratio =
      fitted > 0
        ? nativeCameraScale(clock.value, nativeRecut, cameraShared) / fitted
        : 0;
    return songDetailPhase(ratio);
  });
  const soundDrawn = useSharedValue(0);
  useAnimatedReaction(
    () => soundPhase.value,
    (next, before) => {
      if (next === before) return;
      cancelAnimation(soundDrawn);
      if (next === 'hidden') soundDrawn.value = 0;
      else if (next === 'reveal') {
        soundDrawn.value = withTiming(1, {
          duration: reducedMotion ? 0 : SEAL_PLAYER_KNOBS.SOUND_MS,
          easing: easeSmoother,
        });
      }
    },
  );
  /*
   * The motion's own arrival (`MotionFrame.presence`): 0 until the playing
   * song's track exists and the camera has landed, then written on over the
   * ring's draw time. Like the ring of ticks it waits for the descent rather
   * than riding it, and a track that lands after the camera rises the same
   * way rather than appearing at full strength.
   */
  const motionDrawn = scene.motionIn;
  useAnimatedReaction(
    () => {
      const focus = focusDraw.value;
      if (focus === null || focus.motion === null) return 'hidden';
      return `${soundPhase.value}:${focus.placementKey}`;
    },
    (next, before) => {
      if (next === before) return;
      cancelAnimation(motionDrawn);
      if (next === 'hidden' || next.startsWith('hidden:')) {
        motionDrawn.value = 0;
        return;
      }
      if (!next.startsWith('reveal:')) return;
      // Another song: its motion starts from nothing, not from the last one's.
      if (before === null || before.slice(before.indexOf(':')) !== next.slice(next.indexOf(':'))) {
        motionDrawn.value = 0;
      }
      motionDrawn.value = withTiming(1, {
        duration: reducedMotion ? 0 : PLAYER_RING_KNOBS.SONG_WAVE_DRAW_MS,
        easing: easeSmoother,
      });
    },
  );
  /*
   * How far the player's song has been heard, for the seal's dots — and a
   * constant whenever no seal is showing.
   *
   * The faces' picture holds every mark in the field, and a picture is
   * re-recorded whenever anything it reads moves. Reading the playhead there
   * directly re-recorded the whole field on every frame of playback, for a
   * number only the seal draws. A shared value set to what it already holds
   * wakes nothing (Reanimated's `valueSetter`), so on the circle this settles
   * at -1 and the faces stay recorded while the song plays.
   */
  const heard = useDerivedValue(() => {
    const seconds =
      focusDraw.value === null ? 0 : focusDraw.value.seconds;
    if (
      lensesShowing(
        'hearsPlayhead',
        lensClock.from.value,
        lensClock.to.value,
        lensClock.t.value,
      ) <= 0 ||
      positionSeconds === null ||
      seconds <= 0
    ) {
      return -1;
    }
    return positionSeconds.value / seconds;
  });
  const mapPaints = useMemo(() => createMapPaints(palette), [palette]);
  const facePicture = useDerivedValue(() =>
    createPicture(
      canvas => {
        const cut = cutShared.value;
        if (cut === null) return;
        const nativeRecut = cut.recut;
        const recede = cut.recede;
        // The lattice is the ground the faces stand on, so it is drawn first
        // in their recording; see `drawLattice`.
        const p = Math.min(Math.max(clock.value, 0), 1);
        const live = p >= 1 ? cameraShared.value : null;
        // While find gathers, the map's ground is the map camera's.
        const drawnGather = gatherDrawn(cut.gather, recede, p);
        const mapDrawn =
          drawnGather === null
            ? null
            : mapCameraAt(
                drawnGather.map,
                recede,
                recede === null ? p : linearOfEased(p),
              );
        // A field with nothing in it — no song, no job — has no ground
        // either: the empty field's words stand on paper
        // (`flow.html#f-empty`).
        if (cut.flights.length > 0)
          drawLattice(
            canvas,
            mapDrawn === null
              ? {
                  x:
                    live?.x ??
                    nativeRecut.fromCamera.x +
                      (nativeRecut.toCamera.x - nativeRecut.fromCamera.x) * p,
                  y:
                    live?.y ??
                    nativeRecut.fromCamera.y +
                      (nativeRecut.toCamera.y - nativeRecut.fromCamera.y) * p,
                  scale: nativeCameraScale(p, nativeRecut, cameraShared),
                }
              : mapDrawn,
            nativeFitScale(p, nativeRecut, fitScaleShared),
            viewport,
            mapPaints.lattice,
            1 -
              (1 - GATHER_KNOBS.RECEDE_LATTICE_INK) *
                recededAt(recede, recede === null ? p : linearOfEased(p)),
          );
        drawFieldFaces(
          canvas,
          faceFlights.value,
          facePaints,
          clock.value,
          nativeRecut,
          cameraShared,
          fitScaleShared,
          viewport,
          lensClock.from.value,
          lensClock.to.value,
          lensClock.t.value,
          reducedMotion,
          smootherstep(soundClock.value) * soundDrawn.value,
          heard.value,
          inkClock.value,
          openingClock.value,
          recede,
          drawnGather,
          drawnGather === null ? 0 : 1,
          {
            atlas: faceAtlas,
            pool: stampPool,
            songs: songs.value,
            pixelRatio: PIXEL_RATIO,
            hairlinePx: FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
          },
          motionFrame.value,
          motionOn.value,
          layer,
        );
      },
      { width: viewport.width, height: viewport.height },
    ),
  );
  /**
   * The row the player's flight has taken over, once that flight is live on
   * the UI thread; null otherwise.
   *
   * Written by the flight itself, from a reaction — which only runs once its
   * mappers do — so "the player draws this row" and "the batch leaves it out"
   * turn on the same shared value in the same pass. A React prop could not say
   * this: the batch's picture learnt a new focus one passive effect after the
   * flight had mounted and started drawing from the JS thread's idea of the
   * camera, and for those frames the same name was drawn twice, a few pixels
   * apart (seen on the phone at the start of a descent).
   */
  const playerRow = useSharedValue<PlayerRow | null>(null);
  // Every row, the focused one included: who draws it is decided per frame,
  // by `motion.owned`, not by which rows this list holds.
  const rows = useDerivedValue(() =>
    joinRows(cutShared.value, songs.value, inkFrom.value, openAt.value),
  );
  const rowPaints = useMemo(
    () =>
      createRowPaints(
        palette.ink,
        palette.muted,
        ROW_ARRIVAL_KNOBS.TRACE_STROKE_PX,
      ),
    [palette],
  );
  const rowFonts = useMemo(
    () => ({ title: displayFont, mono: monoFont }),
    [displayFont, monoFont],
  );
  const labelPaints = useMemo(
    () => createLabelPaints(palette.muted, palette.faint),
    [palette],
  );
  const rowsPicture = useDerivedValue(() => {
    const cut = cutShared.value;
    const p = Math.min(Math.max(clock.value, 0), 1);
    if (cut === null) return createPicture(() => {}, viewport);
    const nativeRecut = cut.recut;
    const recede = cut.recede;
    const foundFoot = cut.foundFoot;
    const live = p >= 1 ? cameraShared.value : null;
    const rowCamera = {
      x:
        live?.x ??
        nativeRecut.fromCamera.x +
          (nativeRecut.toCamera.x - nativeRecut.fromCamera.x) * p,
      y:
        live?.y ??
        nativeRecut.fromCamera.y +
          (nativeRecut.toCamera.y - nativeRecut.fromCamera.y) * p,
      scale: nativeCameraScale(p, nativeRecut, cameraShared),
    };
    const hubCovers = hubPaths.value;
    // While find gathers, the map's furniture is drawn by the map's camera.
    const drawnGather = gatherDrawn(cut.gather, recede, p);
    const mapCamera =
      drawnGather === null
        ? rowCamera
        : mapCameraAt(
            drawnGather.map,
            recede,
            recede === null ? p : linearOfEased(p),
          );
    return createPicture(canvas => {
      const fit = nativeFitScale(p, nativeRecut, fitScaleShared);
      drawSections(
        canvas,
        cut.sections,
        p,
        mapCamera,
        fit,
        viewport,
        monoFont,
        mapPaints.line,
        mapPaints.word,
      );
      drawHubs(
        canvas,
        cut.hubs,
        hubCovers,
        p,
        mapCamera,
        fit,
        viewport,
        mapPaints.hub,
      );
      drawNativeLabels(
        canvas,
        cut.labels as ReturnType<typeof prepareNativeLabels>,
        p,
        mapCamera,
        fit,
        viewport,
        monoFont,
        labelPaints,
        FIELD_CANVAS_KNOBS.SHELF_LABEL_GAP_PX,
        FIELD_CANVAS_KNOBS.SHELF_KEY_GAP_PX,
        recede === null
          ? 1
          : (1 -
              (1 - GATHER_KNOBS.RECEDE_HEAD_INK) *
                recededAt(recede, p >= 1 ? 1 : linearOfEased(p))) *
              // Behind a gather the map gives way as you go into a song.
              (drawnGather === null ? 1 : 1 - motion.arrived.value),
      );
      if (drawnGather !== null) {
        // The found shelf's faces over the map's names.
        drawFieldFaces(
          canvas,
          faceFlights.value,
          facePaints,
          clock.value,
          nativeRecut,
          cameraShared,
          fitScaleShared,
          viewport,
          lensClock.from.value,
          lensClock.to.value,
          lensClock.t.value,
          reducedMotion,
          smootherstep(soundClock.value) * soundDrawn.value,
          heard.value,
          inkClock.value,
          openingClock.value,
          recede,
          drawnGather,
          2,
          {
            atlas: faceAtlas,
            pool: stampPool,
            songs: songs.value,
            pixelRatio: PIXEL_RATIO,
            hairlinePx: FIELD_CANVAS_KNOBS.FACE_STROKE_PX,
          },
          motionFrame.value,
          motionOn.value,
          layer,
        );
      }
      drawNativeRows(
        canvas,
        rows.value,
        p,
        rowCamera,
        fit,
        viewport,
        motion.written.value,
        motion.fieldFade.value,
        rowFonts,
        rowPaints,
        motion.owned.value > 0 ? playerRow.value?.key ?? null : null,
        inkClock.value,
        openingClock.value,
        recede,
        drawnGather,
        // The ghost behind a gather has faces and no words, as the study's
        // map has none: opened inside a shelf, its rows' names would lie
        // under the found rows' own.
        drawnGather === null
          ? 0
          : nameArrival(mapCamera.scale, fit) *
            (1 - recededAt(recede, recede === null ? p : linearOfEased(p))),
        drawnGather === null
          ? motion.written.value
          : nameArrival(
              (p >= 1 &&
              drawnGather.toShelf !== null &&
              cameraShared.value.scale / fit >= LEVEL_BOUNDARIES.field
                ? cameraShared.value
                : drawnGather.toShelf ?? drawnGather.fromShelf ?? rowCamera
              ).scale,
              fit,
            ),
      );
      // The found shelf's last row, in the meta's face at the title's
      // column, present as much as the gather is.
      if (foundFoot !== null && recede !== null) {
        const mapInk = recedeInkAt(recede, p >= 1 ? 1 : linearOfEased(p));
        const present = Math.min(
          Math.max((1 - mapInk) / (1 - GATHER_KNOBS.RECEDE_INK), 0),
          1,
        );
        const alpha = present * motion.written.value * motion.fieldFade.value;
        if (alpha > 0) {
          rowPaints.meta.setAlphaf(alpha);
          canvas.drawText(
            foundFoot.text,
            (foundFoot.x - rowCamera.x) * rowCamera.scale +
              viewport.width / 2 -
              NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX,
            (foundFoot.y - rowCamera.y) * rowCamera.scale +
              viewport.height / 2 +
              NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
            rowPaints.meta,
            monoFont,
          );
        }
      }
    }, viewport);
  });
  // Whatever in this re-cut is not a song is a job; one whose mark has not
  // arrived, or has left, draws nothing.
  const jobFlights = useDerivedValue(() =>
    joinJobs(cutShared.value, songs.value),
  );
  const jobLayer = useMemo(() => Skia.Paint(), []);
  const jobFade = useMemo(() => Skia.Paint(), []);
  const jobsPicture = useDerivedValue(() => {
    const cut = cutShared.value;
    const p = Math.min(Math.max(clock.value, 0), 1);
    if (cut === null) return createPicture(() => {}, viewport);
    const nativeRecut = cut.recut;
    const recede = cut.recede;
    const live = p >= 1 ? cameraShared.value : null;
    const jobCamera = {
      x:
        live?.x ??
        nativeRecut.fromCamera.x +
          (nativeRecut.toCamera.x - nativeRecut.fromCamera.x) * p,
      y:
        live?.y ??
        nativeRecut.fromCamera.y +
          (nativeRecut.toCamera.y - nativeRecut.fromCamera.y) * p,
      scale: nativeCameraScale(p, nativeRecut, cameraShared),
    };
    const marks = jobMarks.value;
    const drawnGather = gatherDrawn(cut.gather, recede, p);
    // A job is never found: it goes as the map recedes behind a gather.
    const jobsLeft =
      drawnGather === null
        ? 1
        : 1 - recededAt(recede, recede === null ? p : linearOfEased(p));
    return createPicture(canvas => {
      if (jobsLeft <= 0) return;
      if (jobsLeft < 1) {
        jobFade.setAlphaf(jobsLeft);
        canvas.saveLayer(jobFade);
      }
      drawNativeJobs(
        canvas,
        jobFlights.value,
        marks,
        p,
        drawnGather === null
          ? jobCamera
          : mapCameraAt(
              drawnGather.map,
              recede,
              recede === null ? p : linearOfEased(p),
            ),
        nativeFitScale(p, nativeRecut, fitScaleShared),
        viewport,
        jobLayer,
      );
      if (jobsLeft < 1) canvas.restore();
    }, viewport);
  });
  return (
    <>
      <Fill color={palette.bg} />
      <Picture picture={facePicture} />
      {/*
        Under the arc and the hand, which is where the ring's ticks were drawn
        when they were the ring's — the measurement is what the timeline is
        drawn over, at either end of the crossing.
      */}
      {focus === null ? null : (
        <FocusDetail
          key={`detail:${focus.key}`}
          detailInk={detailInk}
          focus={focus}
          scene={scene}
          lensClock={lensClock}
          cameraShared={cameraShared}
          fitScaleShared={fitScaleShared}
          grainShared={grainShared}
          palette={palette}
          positionSeconds={positionSeconds}
          viewport={viewport}
          motionFrame={motionFrame}
        />
      )}
      <Picture picture={rowsPicture} />
      {focus === null ? null : (
        <FocusFlight
          key={`flight:${focus.key}`}
          focus={focus}
          focusReady={focusReady}
          scene={scene}
          lensClock={lensClock}
          playerRow={playerRow}
          motion={motion}
          cameraShared={cameraShared}
          fitScaleShared={fitScaleShared}
          viewport={viewport}
          songTitleFont={songTitleFont}
          songMetaFont={songMetaFont}
          positionSeconds={positionSeconds}
          transportPlaying={transportPlaying}
          transportArriving={transportArriving}
          transportLights={transportLights}
          displayFont={displayFont}
          monoFont={monoFont}
          palette={palette}
        />
      )}
      <Picture picture={jobsPicture} />
    </>
  );
});

/**
 * A focus layer's clock: the scene's while the cut it was built for is the
 * one on the canvas, and landed once another has replaced it — so a layer on
 * its way out never draws one frame against the next cut's clock (house rule
 * 5, kept for the one part of the scene that still mounts per focus).
 */
function useFocusClock(scene: LivingScene, generation: number) {
  const cut = scene.cut;
  const clock = scene.clock;
  // And held at its start until its own cut is on the canvas. React mounts a
  // layer before the UI thread installs the cut it was built for; read as
  // landed, a re-cut under the song you stand in drew the player at its new
  // seat while the camera, rightly, still waited at the old one.
  return useDerivedValue(() =>
    cut.value === null
      ? 1
      : cut.value.generation === generation
      ? clock.value
      : cut.value.generation < generation
      ? 0
      : 1,
  );
}

/** The row the player's flight has taken over, and which flight holds it. */
type PlayerRow = Readonly<{ key: string; owner: number }>;
let nextRowOwner = 1;

/** Whose measurement the focus layer has drawn in; see `NativeSongDetail`. */
type DetailInk = Readonly<{ key: string | null; drawn: boolean }>;

/** The focused song's detail loop, under the rows; see `NativeSongDetail`. */
function FocusDetail({
  detailInk,
  focus,
  scene,
  lensClock,
  cameraShared,
  fitScaleShared,
  grainShared,
  palette,
  positionSeconds,
  viewport,
  motionFrame,
}: {
  detailInk: SharedValue<DetailInk>;
  focus: FocusLayer;
  scene: LivingScene;
  lensClock: LensClock;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  grainShared: SharedValue<GrainBars | null>;
  palette: Palette;
  positionSeconds: SharedValue<number> | null;
  viewport: Viewport;
  motionFrame: SharedValue<MotionFrame | null>;
}) {
  const clock = useFocusClock(scene, focus.generation);
  return (
    <NativeSongDetail
      lensClock={lensClock}
      cameraShared={cameraShared}
      clock={clock}
      ink={detailInk}
      songKey={focus.flight.entityKey}
      fitScaleShared={fitScaleShared}
      grainShared={grainShared}
      model={focus.detail}
      palette={palette}
      positionSeconds={positionSeconds}
      recut={focus.recut}
      viewport={viewport}
      motionFrame={motionFrame}
    />
  );
}

/** The focused song's flight and player, over the rows. */
function FocusFlight({
  focus,
  focusReady,
  scene,
  lensClock,
  playerRow,
  motion,
  cameraShared,
  fitScaleShared,
  viewport,
  songTitleFont,
  songMetaFont,
  positionSeconds,
  transportPlaying,
  transportArriving,
  transportLights,
  displayFont,
  monoFont,
  palette,
}: {
  focus: FocusLayer;
  focusReady: (generation: number) => void;
  scene: LivingScene;
  lensClock: LensClock;
  playerRow: SharedValue<PlayerRow | null>;
  motion: NativeCameraMotion;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  viewport: Viewport;
  songTitleFont: NonNullable<ReturnType<typeof useMorphFont>>;
  songMetaFont: NonNullable<ReturnType<typeof useMorphFont>>;
  positionSeconds: SharedValue<number> | null;
  transportPlaying: SharedValue<number> | null;
  transportArriving: SharedValue<number> | null;
  transportLights: SharedValue<number[]> | null;
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>;
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>;
  palette: Palette;
}) {
  const clock = useFocusClock(scene, focus.generation);
  // The song's form on its clock: its sections and drops, once per track.
  const formCuts = useDerivedValue(() => {
    const focused = scene.focus.value;
    return clockCutsOf(focused === null ? null : focused.motion);
  });
  // On the canvas: its cut may go down now (see `focusReady`).
  const generation = focus.generation;
  useEffect(() => {
    focusReady(generation);
  }, [focusReady, generation]);
  return (
    <NativePlacementFlight
      lensClock={lensClock}
      playerRow={playerRow}
      motion={motion}
      flight={focus.flight}
      clock={clock}
      cameraShared={cameraShared}
      fitScaleShared={fitScaleShared}
      recut={focus.recut}
      viewport={viewport}
      row={focus.row}
      titleFrom={focus.titleFrom}
      inkClock={scene.inkClock}
      formCuts={formCuts}
      formInk={scene.motionIn}
      song={focus.song}
      songTitleFont={songTitleFont}
      songMetaFont={songMetaFont}
      positionSeconds={positionSeconds}
      transportPlaying={transportPlaying}
      transportArriving={transportArriving}
      transportLights={transportLights}
      durationSeconds={focus.durationSeconds}
      displayFont={displayFont}
      monoFont={monoFont}
      color={palette.ink}
      mutedColor={palette.muted}
    />
  );
}

/**
 * Everything about a row that does not answer to the camera.
 *
 * The strings, the cut and the widths are a function of the song and the fonts
 * alone, so they are settled on the JS thread and the UI thread only moves and
 * fades what comes out of here. The measuring is the reason: `fitText` searches
 * the proportional display face for the longest prefix that fits, which is not
 * something to do on a frame — and every piece of it is memoised on that same
 * recipe, so a re-cut that changes only where a song sits rebuilds none of it.
 *
 * The offsets are `nameLens`'s own knobs, and the strings come from the same
 * two functions the lens calls, because a row that changed shape when the
 * renderer changed would be a different row.
 */

/**
 * A song's download as its mark draws it: a fraction while bytes move, held
 * (faint, where it stopped) when nothing is moving them, or none.
 */
function arrivingOf(presentation: FieldPresentation): number {
  if (presentation.localAudio.state !== 'partial') return ARRIVING_NONE;
  const share = arrivingFraction(
    presentation.localAudio.bytes,
    presentation.byteLength ?? undefined,
  );
  const moving =
    presentation.source !== 'node' || presentation.transfer === 'moving';
  if (!moving) return arrivingHeld(share);
  return share ?? ARRIVING_UNKNOWN;
}

/**
 * A song as the scene keeps it, whatever cut it is in (`SongDraw`): built once
 * per drawn change of its presentation.
 */
function songDrawOf(
  presentation: FieldPresentation,
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>,
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>,
): SongDraw {
  return {
    identities: LENSES.map(lens => lens.identity(presentation.recipe)),
    row: nativeRowModel(presentation, presentation.recipe, displayFont, monoFont),
    column: rowColumnOf(presentation, monoFont).column,
    ink: songInkOf(presentation),
    arriving: arrivingOf(presentation),
  };
}

/**
 * A row's action word and the column its lines are cut to: the action is
 * right-aligned against the row's edge and the title is cut to whatever is
 * left, so a long title cannot run under the word that acts on it.
 */
function rowColumnOf(
  presentation: FieldPresentation,
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>,
) {
  const availability = availabilityOf(presentation.localAudio.state);
  const transfer =
    presentation.source === 'node' ? presentation.transfer : null;
  const action = presentation.audioActions
    ? availabilityAction(availability, transfer)
    : null;
  const titleLeft = -NAME_LENS_KNOBS.ROW_TITLE_OFFSET_PX;
  const rowRight = NAME_LENS_KNOBS.ROW_RIGHT_PX;
  const actionWidth = action === null ? 0 : textWidth(action, monoFont);
  const titleRight =
    action === null
      ? rowRight
      : rowRight - actionWidth - NAME_LENS_KNOBS.ROW_TITLE_GAP_PX;
  return {
    availability,
    transfer,
    action,
    actionX: rowRight - actionWidth,
    titleLeft,
    column: titleRight - titleLeft,
  };
}

function nativeRowModel(
  presentation: FieldPresentation,
  recipe: Parameters<typeof nameLensFacePath>[0],
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>,
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>,
  /** A line said instead of the availability: a found row's place. */
  metaOverride: string | null = null,
): NativeRowModel {
  // Both measured from the row's own point, which is the origin of the
  // group the UI thread moves.
  const { availability, transfer, action, actionX, titleLeft, column } =
    rowColumnOf(presentation, monoFont);
  const title = fitText(presentation.title, displayFont, column);
  return {
    action,
    actionX,
    title,
    titleTrace: titleTracePaths(
      title,
      displayFont,
      titleLeft,
      NAME_LENS_KNOBS.ROW_TITLE_BASELINE_PX,
    ),
    titleAlpha: TITLE_ALPHA[availability],
    meta: fitText(
      // Cut to the same column as the title: `CACHED · MAY BE RECLAIMED` is
      // the longest line here and it must not run under the action word. A
      // device song's file was never downloaded: its line is who made it.
      // A found row says where it came from instead; its face's ink still
      // says what is on the phone.
      metaOverride !== null
        ? metaOverride
        : presentation.source === 'device'
        ? presentation.label.toUpperCase()
        : availabilityLine(
            {
              audioState: presentation.localAudio.state,
              arriving: arrivingFraction(
                presentation.localAudio.bytes,
                presentation.byteLength ?? undefined,
              ),
              byteLength: presentation.byteLength,
              nodeLabel: presentation.label,
            },
            transfer,
            presentation.source === 'node' && presentation.noConnection,
          ),
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
  formCuts = null,
  formInk = null,
  motion,
  playerRow,
  lensClock,
  flight,
  clock,
  cameraShared,
  fitScaleShared,
  recut,
  viewport,
  row,
  titleFrom,
  inkClock,
  song,
  songTitleFont,
  songMetaFont,
  positionSeconds,
  transportPlaying,
  transportArriving,
  transportLights,
  durationSeconds,
  displayFont,
  monoFont,
  color,
  mutedColor,
}: {
  /** The song's form on its clock; see `ClockCuts`. */
  formCuts?: DerivedValue<ClockCuts> | null;
  formInk?: SharedValue<number> | null;
  motion: NativeCameraMotion;
  /** Where this flight says it has taken its row over; see `playerRow`. */
  playerRow: SharedValue<PlayerRow | null>;
  lensClock: LensClock;
  flight: PlacementFlight;
  clock: SharedValue<number>;
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  recut: NativeRecut;
  viewport: Viewport;
  row: NativeRowModel;
  /** The name's alpha when its ink last changed; see `arriveInk`. */
  titleFrom: number;
  inkClock: SharedValue<number> | null;
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
  transportPlaying: SharedValue<number> | null;
  transportArriving: SharedValue<number> | null;
  transportLights: SharedValue<number[]> | null;
  durationSeconds: number;
  displayFont: NonNullable<ReturnType<typeof useMorphFont>>;
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>;
  color: string;
  mutedColor: string;
}) {
  const titleTo = row.titleAlpha;
  const titleAlpha = useDerivedValue(() =>
    mix(titleFrom, titleTo, inkClock?.value ?? 1),
  );
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
  const playerAnchor = motion.playerAnchor;
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
   * Shape first, then the name. See `SONG_ARRIVAL`. The shape's own beat is
   * read by `drawFieldFaces` now, which is where the face is drawn.
   */
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
  const written = motion.written;
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
      titleAlpha.value *
      rowTitleInk.value *
      writePhase(writeSubAlpha(written.value, traceCount - 1, traceCount))
        .borderAlpha,
  );
  const titleOpacity = useDerivedValue(
    () =>
      owner.value *
      titleAlpha.value *
      rowTitleInk.value *
      writePhase(writeSubAlpha(written.value, traceCount - 1, traceCount))
        .fillAlpha,
  );
  /** The pre-write behaviour, kept for where an outline cannot be had. */
  const rowTitleFade = useDerivedValue(
    () => owner.value * titleAlpha.value * rowTitleInk.value * written.value,
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
  /*
   * Live: take the row over from the batch. The reaction's first run is on the
   * UI thread, after this flight's own mappers are installed, so from that
   * frame on everything below is drawn from the live camera. Released on
   * unmount — by then the camera is at row distance and neither owner is
   * drawing anything the other is not.
   */
  const rowKey = flight.targetPlacementKey;
  /*
   * Released only by the flight that holds it. A re-cut under the song you
   * stand in mounts the next cut's flight for the same row, and it takes the
   * row over before this one unmounts: released by key, the outgoing flight
   * took the row back from it — the player gone and the row drawn in its
   * place, for a frame, or for good when nothing took it over again.
   *
   * And not while it still owns the row at all. React unmounts this flight
   * as it mounts the next, which then takes some frames to start: released
   * here, the row went back to the batch for those frames and the player
   * showed as a row. A claim left behind is read only while a player owns
   * the row (`motion.owned`), and the next flight writes over it.
   */
  const holder = useRef(nextRowOwner++).current;
  useAnimatedReaction(
    () => rowKey,
    key => {
      playerRow.value = key === null ? null : { key, owner: holder };
    },
    [rowKey],
  );
  useEffect(
    () => () => {
      runOnUI(() => {
        'worklet';
        if (playerRow.value?.owner === holder && motion.owned.value <= 0) {
          playerRow.value = null;
        }
      })();
    },
    [holder, motion, playerRow],
  );
  /**
   * Drawn only while it owns the row, and only once live. At row distance the
   * batch draws it, as it draws every other row; see `owned` and `playerRow`.
   */
  const flightOpacity = useDerivedValue(() =>
    isPlayer && playerRow.value?.key !== rowKey
      ? 0
      : motion.fieldFade.value * (isPlayer ? motion.owned.value : 1),
  );
  return (
    <SkiaGroup opacity={flightOpacity} transform={transform}>
      {/*
        The name arrives by being written; the facts about it arrive by fading.
        A row is one name and two pieces of metadata, and writing all three at
        once would read as a machine typing rather than as a name being put
        down.
      */}
      {row.titleTrace === null ? null : (
        <SkiaGroup opacity={traceOpacity}>
          <TracedTitle paths={row.titleTrace} written={written} color={color} />
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
          lensClock={lensClock}
          formCuts={formCuts}
          formInk={formInk}
          letterFont={monoFont}
          arrived={arrived}
          named={nameArrived}
          colour={color}
          durationSeconds={durationSeconds}
          model={song}
          mutedColour={mutedColor}
          positionSeconds={positionSeconds}
          transportPlaying={transportPlaying}
          arriving={transportArriving}
          lights={transportLights}
          anchor={playerAnchor}
          songMetaFont={songMetaFont}
          songTitleFont={songTitleFont}
          viewport={viewport}
        />
      )}
    </SkiaGroup>
  );
}

/** Resolved samples and the label for the L3 span. */
export type GrainRender = Readonly<{ window: SampleWindow; label: string }>;

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
/** A job's mark at map and shelf size, around the origin; see `JobMark`. */
function recordJobMark(
  pending: JobPresentation,
  palette: Palette,
  monoFont: NonNullable<ReturnType<typeof useMorphFont>>,
): JobMark {
  const paints = createPaints(palette);
  const record = (row: boolean) => {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(-256, -128, 512, 256));
    drawJobMark(
      canvas,
      { paints, fonts: { mono: monoFont } },
      { x: 0, y: 0 },
      row ? pending : { ...pending, caption: null },
      { dot: row ? 0 : 1, row: row ? 1 : 0, song: 0, grain: 0 },
    );
    return recorder.finishRecordingAsPicture();
  };
  return { dot: record(false), row: record(true) };
}

export function drawJobMark(
  canvas: SkCanvas,
  request: { paints: LensPaints; fonts: Pick<LensFonts, 'mono'> },
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
      stageGlyphPath(
        model.symbol as SymbolName,
        FIELD_CANVAS_KNOBS.JOB_GLYPH_PX,
      ),
      paint,
    );
    canvas.restore();
  }

  // Compact map clusters show the job ring/symbol. State words arrive
  // with the shelf, where each entity owns a full row.
  if (alpha.row > 0.01) {
    const label = jobStateLabel(pending.job);
    const counted =
      model.progress.kind === 'determinate'
        ? ` ${model.progress.completed}/${model.progress.total}`
        : '';
    const line = `${label}${counted}`;
    request.paints.muted.setAlphaf(alpha.row * quiet);
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
  /** The text on the screen, as `heldLabelText` reads it. */
  primary: string;
  secondary: string;
  survives: boolean;
  alpha: number;
}>;

/**
 * Retarget label flights from the text, world anchor and ink drawn by the
 * interrupted generation: the next filter never restarts from either semantic
 * endpoint when the person taps the dial mid-change.
 *
 * `progress` is the value the canvas drew at — the re-cut's clock, which is
 * already eased — so it is used as it is. It once took React's un-eased copy
 * and eased it here; on the native path React's copy stands at 0 for the
 * whole flight, and the names restarted from their source.
 *
 * The canvas draws a name as text crossfading between two lines, so the text
 * is what is captured. This used to sample every changing name's glyph
 * outlines for a path morph the canvas never draws: about 120 ms on the
 * Samsung, during which the interrupted re-cut stood held on the screen.
 */
function retargetShelfLabelFlights(
  current: ShelfLabelFlights,
  progress: number,
  next: ShelfLabelFlights,
): ShelfLabelFlights {
  const travel = progress;
  const capturedByGroup = new Map<string, CapturedShelfFlight>();
  for (const flight of current) {
    if (flight.toGroupKey === null) continue;
    // A name standing still is already where the next plan starts it, as the
    // next plan says it.
    if (standingStill(flight)) continue;
    const captured: CapturedShelfFlight = {
      point: {
        x: flight.from.x + (flight.to.x - flight.from.x) * travel,
        y: flight.from.y + (flight.to.y - flight.from.y) * travel,
      },
      top: flight.fromTop + (flight.toTop - flight.fromTop) * travel,
      topGathered:
        flight.fromTopGathered +
        (flight.toTopGathered - flight.fromTopGathered) * travel,
      primary: heldLabelText(flight.primaryFrom, flight.primaryTo, progress),
      secondary: heldLabelText(
        flight.secondaryFrom,
        flight.secondaryTo,
        progress,
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
      primaryFrom: captured.primary,
      secondaryFrom: captured.secondary,
    };
  });
}

/** A label flight that neither moves, morphs nor changes its ink. */
function standingStill(flight: LabelFlight): boolean {
  return (
    flight.primary === null &&
    flight.secondary === null &&
    flight.primaryFrom === flight.primaryTo &&
    flight.secondaryFrom === flight.secondaryTo &&
    flight.from.x === flight.to.x &&
    flight.from.y === flight.to.y &&
    flight.fromTop === flight.toTop &&
    flight.fromTopGathered === flight.toTopGathered &&
    flight.fromAlpha === flight.targetAlpha
  );
}

/**
 * Memoised so a screen re-render that leaves the camera and content untouched
 * does not re-record the picture. A camera change still re-records: the level
 * crossfades and screen-space type genuinely differ at every scale.
 */
export const FieldCanvas = React.memo(FieldCanvasImpl);
