import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { cameraSummary, type OriginFrame } from './cameraSummary';
import { CURTAIN_KNOBS, releaseTarget, unrollMs } from '../curtain';
import {
  inBrowseFrame,
  GLIDE_KNOBS,
  GRAIN_ENABLED,
  GRAIN_KNOBS,
  LAYOUT_KNOBS,
  containToSeat,
  gatherFraction,
  hitTestPlacement,
  hitTestRowAction,
  interpolatePositiveScale,
  isShelfDistance,
  isSongDistance,
  LEVEL_BOUNDARIES,
  LEVEL_SCALE_RATIOS,
  levelCameraTarget,
  levelOf,
  flightCameraAt,
  glideEase,
  glideSpeedPxS,
  mapCameraAround,
  mapCameraRange,
  mapFrame,
  nearestSeat,
  overviewMinRatio,
  placementFlightAt,
  placementPoint,
  planGlide,
  planPlacementFlights,
  RAIL_KNOBS,
  railCamera,
  railExtent,
  railWanted,
  seatAfterRelease,
  seatCameraAround,
  seatCameraBounds,
  shelfSeats,
  smootherstep,
  worldToScreen,
  zoomAroundFocalPoint,
  type Camera,
  type FieldLayout,
  type FlightAnchor,
  type Group,
  type Level,
  type MapFrame,
  type Placement,
  type PlacementFlight,
  type Point,
  type RailExtent,
  type ShelfSeat,
  type Viewport,
} from '../../field';

/** KNOBS — durations in ms, positions in screen pixels, scales relative to FIT. */
export const FIELD_CAMERA_KNOBS = {
  CAMERA_FLIGHT_MS: 700,
  RELAYOUT_MS: 850,
  TAP_SLOP_PX: 8,
  /**
   * Hold acts. Long enough that a slow tap is still a tap and a pan that
   * starts late is still a pan, short enough to feel like an answer.
   */
  HOLD_MS: 380,
  HOLD_SLOP_PX: 12,
  PAN_SLOP_PX: 4,
  /**
   * How near an edge a drag must start to be a pull on that edge's blind, and
   * how straight down or up it has to run to stay one.
   *
   * Where a released pull ends up is not decided here: that is the blind's own
   * rule, `releaseTarget`, so a throw and a slow drag are answered the same way
   * whether the blind is being pulled out or folded away.
   */
  EDGE_PULL_ZONE_PX: 110,
  EDGE_PULL_HORIZONTAL_TOLERANCE_PX: 50,
  /** How long the camera takes to fall back into a seat it was pulled out of. */
  SEAT_SETTLE_MS: 340,
  /**
   * Each of the two legs of a step from one song to the next on its shelf:
   * the player folding back into its row, then the neighbour opening.
   * Shorter than `CAMERA_FLIGHT_MS` because a step does not cross the field —
   * the two rows are one seat apart — and two full flights read as a detour.
   */
  STEP_LEG_MS: 520,
  /**
   * The camera's floor at the map's own scale; below it is the overview, whose
   * floor depends on the map (`overviewMinRatio`, `OVERVIEW_KNOBS.MIN_RATIO`).
   * This is what a map with no overview — one that already fits — stops at.
   */
  MIN_SCALE_RATIO: 1,
  /**
   * The camera's ceiling. It bounds a *camera*, not a pinch — see
   * `PINCH_CEILING_RATIO`.
   *
   * With L3 open it is the scale that shows the closest look the grain offers,
   * derived from the grain knobs so the two cannot drift apart: zooming further
   * would resolve nothing new. With L3 closed it is the song's own seat, so the
   * player is the end of the road and nothing can be flown, pinched or
   * rubber-banded past it into a level that is not being drawn.
   */
  MAX_SCALE_RATIO: GRAIN_ENABLED
    ? GRAIN_KNOBS.ENTRY_RATIO *
      (GRAIN_KNOBS.ENTRY_SECONDS / GRAIN_KNOBS.MIN_SECONDS)
    : LEVEL_SCALE_RATIOS.song,
  /**
   * How close a pinch may take you: the shelf's own seat, and no further.
   *
   * Zoom carries you between the map and a shelf, in both directions. It does
   * not open a song — a song is opened by touching it, and the zoom you see
   * afterwards is `descend`'s flight. So the gesture stops where L1 does, and
   * `PINCH_RUBBER_LOG` makes that stop something you can feel rather than a
   * wall you hit.
   */
  PINCH_CEILING_RATIO: LEVEL_SCALE_RATIOS.shelf,
  /**
   * How far past either end the elastic stretches, in natural-log units of
   * scale — because zoom is exponential and a limit written in ratio would
   * feel tight at one end and loose at the other.
   *
   * `rubberBand` never actually reaches its limit, so this is an asymptote:
   * ln 2 of headroom means the hardest possible pinch is a shade under twice
   * the ceiling, and the first fraction of an octave past it is still free.
   */
  PINCH_RUBBER_LOG: Math.LN2,
  /**
   * How near the fingers a song must be for a pinch to hold on to it, in
   * screen pixels. Farther than this the pinch is over empty field and holds
   * the world point under the fingers, as it always did.
   */
  PINCH_ANCHOR_REACH_PX: 220,
} as const;

type PullDirection = 'compose' | 'engines';

/**
 * The curve a camera flight runs on. A flight you asked for leaves and arrives
 * at rest (smootherstep); a glide leaves at the speed the finger let go at and
 * only arrives at rest (`glideEase`). A jump along the rail is a smootherstep
 * too, tagged apart so a drag on the rail knows the flight it may steer is
 * still its own: anything that stops it resets the tag.
 */
const FLIGHT_CURVE = { SMOOTH: 0, GLIDE: 1, RAIL: 2 } as const;

type Options = {
  layout: FieldLayout | null;
  viewport: Viewport | null;
  onOpenComposer: () => void;
  onOpenEngines: () => void;
  /**
   * A tap on the action word at the end of a row, at L1.
   *
   * Returns whether it was consumed: the camera knows where the column is but
   * not what a song promises, so a row with no action to offer answers `false`
   * and the tap descends into the song as any other tap would.
   */
  onRowAction?: (placement: Placement) => boolean;
  /**
   * A hold on a mark or a row: everything about a song that is not listening
   * to it. Tap descends, hold acts — the convention the design asks for, and
   * the only unclaimed gesture that fights neither pan nor pinch.
   */
  onHoldPlacement?: (placement: Placement) => void;
  /**
   * A tap on a mark the screen wants for itself — a generating job, which has
   * no inside to descend into. Returns whether it was consumed.
   */
  onClaimTap?: (placement: Placement) => boolean;
  /**
   * Which axis the layout is cut on — the arrangement, and for the date axis
   * its resolution. Leaving an axis remembers where on its map the camera
   * was, and coming back to it returns there; see `axisCameras`. Without it
   * a regroup keeps the camera where it is, as it always did.
   */
  axisKey?: string;
  /**
   * Whether the layout is narrowed by a tag filter. The first filtered layout
   * keeps the camera it replaced, and the first unfiltered one after it goes
   * back there; while filtered, the per-axis memory is neither read nor
   * written, so a place on a narrowed map never overwrites one on the whole.
   */
  filtered?: boolean;
  /**
   * The next re-cut happens out of sight, behind a blind: no flights, and the
   * camera lands at once — at the new layout's home, or where it was before
   * the filter when the filter is the thing going. The same switch reduced
   * motion throws. Read only on the render whose layout changes.
   */
  recutQuiet?: boolean;
};

type CameraState = {
  camera: Camera;
  focus: Placement | null;
  /**
   * The placement whose player the canvas should draw, which lags `focus` by a
   * level: entering a shelf does not set it. See `commitFocus`.
   */
  playerFocus: Placement | null;
  level: Level;
  /**
   * The cluster the camera is standing in, or null when it is not standing in
   * one. Unlike `focus` this follows the camera rather than the last tap, so
   * panning from September to August renames the header.
   */
  groupKey: string | null;
  renderedPlacements: readonly Placement[];
  /** Drawn placements, including fading alignment copies during a split/fold. */
  visualPlacements: readonly Placement[];
  layoutProgress: number;
  /** The relayout tween without its easing. */
  relayoutLinear: number;
  /** FIT as it is currently drawn, not the new layout's terminal value. */
  renderFitScale: number;
  /** Semantic source groups for this transition's label plan. */
  labelFromGroups: readonly Group[];
  /** Born with every accepted target; stale frames cannot cross generations. */
  transitionGeneration: number;
  /** Static endpoints consumed by the native-clock L0 renderer. */
  recut: FieldRecutModel | null;
  gesture: ReturnType<typeof Gesture.Simultaneous>;
  /**
   * The index rail's touch: a finger on the rail flies the map there, then
   * follows. Attach it to a view over the rail's strip (`RAIL_KNOBS.WIDTH_PX`
   * in from the right edge); it does nothing away from the map or when the
   * map is too short to have a rail (`rail`).
   */
  railGesture: ReturnType<typeof Gesture.Pan>;
  /** The map's extent down the rail, or null when it is too short for one. */
  rail: RailExtent | null;
  cameraShared: SharedValue<Camera>;
  focusKeyShared: SharedValue<string | null>;
  fitScaleShared: SharedValue<number>;
  /** How far an edge pull has come, in screen pixels; see the shared value. */
  pullShared: SharedValue<number>;
  /** Where the blind is currently headed, or NaN while a finger owns it. */
  pullDestinationShared: SharedValue<number>;
  descend: (placement: Placement) => void;
  /**
   * Move a player that is open onto another song on the same shelf.
   *
   * Not a lateral glide: the player is drawn off its own mark and cannot change
   * owner while it is full size without a flash (see `commitFocus`). So a step
   * is the two moves the zoom model already makes — back into the row, then
   * down into the neighbour — chained on the first one's landing. Does nothing
   * unless a player is open.
   */
  step: (placement: Placement) => void;
  /** The song a step in its first leg is headed for, or null. */
  stepping: () => Placement | null;
  /** Fly to a song from anywhere and open it: the now-playing jump. */
  visit: (placement: Placement) => void;
  ascend: () => boolean;
  home: () => void;
  cancelGesture: () => void;
};

type PanStart = {
  x: number;
  y: number;
  camera: Camera;
  pull: PullDirection | null;
  /**
   * The seat the finger went down in, or -1 when it went down anywhere else.
   *
   * Held for the length of the gesture rather than looked up again on release:
   * the damped camera can drift nearer a neighbour than to the seat it is
   * being held in, and re-deciding at the end would let a pull the person
   * abandoned still count as leaving.
   */
  seat: number;
  /**
   * A second finger came down during this drag. The release speed of what is
   * left of a pinch is not a throw, so such a drag never glides.
   */
  pinched: boolean;
};

type PinchStart = {
  focal: Point;
  camera: Camera;
  /**
   * The bloom offset of the song nearest the fingers, and the gather the pinch
   * began at — or null when no song is near enough to hold on to. See the
   * pinch's update.
   */
  anchor: Readonly<{ bloomX: number; bloomY: number; gather: number }> | null;
};

const EMPTY_CAMERA: Camera = { x: 0, y: 0, scale: 0.9 };

type RecutEnds = Readonly<{
  fromCamera: Camera;
  toCamera: Camera;
  fromFitScale: number;
  toFitScale: number;
}>;

export type FieldRecutModel = Readonly<{
  generation: number;
  layout: FieldLayout;
  flights: readonly PlacementFlight[];
  fromFitScale: number;
  toFitScale: number;
  fromCamera: Camera;
  toCamera: Camera;
  fromGroups: readonly Group[];
  animate: boolean;
  /** The axis this layout is cut on; see `Options.axisKey`. */
  axisKey?: string;
  /** Whether this layout is narrowed; see `Options.filtered`. */
  filtered?: boolean;
}>;

/** A map camera kept for an axis, with its scale relative to that map's FIT. */
type AxisCamera = Readonly<{ x: number; y: number; ratio: number }>;

type RecutClock = Readonly<{
  generation: number;
  linear: number;
}>;

/**
 * Owns the field's interaction state. Shared values mirror the rendered state
 * for the M2 camera seam; React state records the one Skia picture per frame.
 */
export function useFieldCamera({
  layout,
  viewport,
  onOpenComposer,
  onOpenEngines,
  onRowAction,
  onHoldPlacement,
  onClaimTap,
  axisKey,
  filtered = false,
  recutQuiet = false,
}: Options): CameraState {
  const reducedMotion = useReducedMotion();
  const [camera, setCameraState] = useState<Camera>(EMPTY_CAMERA);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** The focus the canvas draws a player for; see `commitFocus`. */
  const [playerKey, setPlayerKey] = useState<string | null>(null);
  /** A descent held until the commit that mounts its player has landed. */
  const pendingDescent = useRef<Camera | null>(null);
  /*
   * Whether a camera flight is in the air, and the re-cut that took one over.
   * A re-cut born mid-flight plans from where the flight was going, and the
   * flight is cancelled when the re-cut starts — two tweens writing
   * `cameraShared` at once is the one thing this hook is built not to do, and
   * a regroup used to ignore a flight home and leave the camera wherever the
   * flight had got to (see C5 in the rewrite log).
   */
  const cameraFlying = useRef(false);
  const absorbedFlight = useRef<number | null>(null);
  /** What to do when the current flight lands; dropped with the flight. */
  const flightThen = useRef<(() => void) | null>(null);
  /** A step's second leg, waiting for the commit that mounts its player. */
  const pendingStepLeg = useRef<Camera | null>(null);
  /**
   * Where a step still folding back into its row will go down again.
   *
   * Navigation focus is null for that whole leg — the player is on its way
   * out — so this is the only record that the camera is, in intent, already
   * on the next song. The queue can move twice in that time (a song that
   * refuses at once is stepped over), and the second move has to land.
   */
  const stepTarget = useRef<Placement | null>(null);
  const [descentTicket, setDescentTicket] = useState(0);
  const [recutClock, setRecutClock] = useState<RecutClock>({
    generation: 0,
    linear: 1,
  });
  const cameraRef = useRef(camera);
  const layoutRef = useRef(layout);
  const focusKeyRef = useRef(focusKey);
  const recutModel = useRef<FieldRecutModel | null>(null);
  /**
   * Where the camera stood on each axis's map when that axis was left: album
   * → date → album comes back to the albums you were reading, not to the top.
   * Held for the session only; an axis never visited opens at its home.
   */
  const axisCameras = useRef(new Map<string, AxisCamera>());
  /**
   * The camera the first filter replaced, at any level, and the axis it was
   * on: where clearing the filter goes back to. Null while unfiltered.
   */
  const beforeFilter = useRef<(AxisCamera & { axisKey?: string }) | null>(
    null,
  );
  const lastVisualPlacements = useRef<readonly Placement[]>([]);
  /** See the capture beside `focus`, and the strand it answers in the re-cut. */
  const standing = useRef<Placement | null>(null);
  /** The generation whose re-cut climbed out of a removed song, once. */
  const strandedFocus = useRef<number | null>(null);
  const lastRenderFitScale = useRef<number | null>(null);
  // Gesture state lives on the UI thread, because that is where the gesture
  // now runs. Each write replaces the whole record: mutating a field of an
  // object held by a shared value does not propagate.
  const panStart = useSharedValue<PanStart | null>(null);
  const pinchStart = useSharedValue<PinchStart | null>(null);
  const pinching = useSharedValue(false);
  /** The generation whose re-cut is in the air, or null once it has landed. */
  const nativeFlight = useRef<number | null>(null);
  // Native shared values are stable. Keep that property in the Jest mock too,
  // which deliberately returns a fresh object for every render.
  const cameraSharedCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const focusKeySharedCandidate = useSharedValue<string | null>(null);
  const fitScaleSharedCandidate = useSharedValue(EMPTY_CAMERA.scale);
  const layoutFitSharedCandidate = useSharedValue(0);
  const mirrorBusyCandidate = useSharedValue(false);
  /** The summary React last heard; see `cameraSummary`. */
  const summarySharedCandidate = useSharedValue('');
  const originSharedCandidate = useSharedValue<OriginFrame>({
    centerX: 0,
    groupCount: 0,
  });
  /**
   * Every cluster's column, in world units, for the UI thread.
   *
   * The gesture needs the geometry the layout owns — which seat it is in, and
   * how far that seat runs — and it needs it inside the same worklet as the
   * finger. A shared value is the only way across; `shelfSeats` is cheap and
   * runs once per layout rather than once per frame.
   */
  const shelfSeatsSharedCandidate = useSharedValue<readonly ShelfSeat[]>([]);
  /**
   * A camera flight, as three shared values the UI thread owns.
   *
   * It used to be a `requestAnimationFrame` loop calling `commitCamera`, which
   * made every flight exactly as smooth as React could re-render and re-record
   * the picture — the same ceiling a pan used to have. The clock is linear and
   * the *camera* is eased, which is where the house curve has always been:
   * `interpolateCamera` smoothersteps position and moves scale logarithmically
   * so a zoom reads as even.
   */
  /**
   * A re-cut's own camera and fit, on the UI thread: a linear clock and the
   * endpoints it runs between, as a camera flight is. It used to tick on the
   * JS thread by `requestAnimationFrame`, writing both shared values from JS
   * and rebuilding every placement's pose on every frame — work the canvas
   * never reads (it runs the re-cut from its own clock) and that only the
   * next re-cut needs, once, if it interrupts this one (`liveCapture`).
   */
  const recutProgressCandidate = useSharedValue(1);
  const recutEndsCandidate = useSharedValue<RecutEnds | null>(null);
  const flightFromCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const flightToCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const flightProgressCandidate = useSharedValue(1);
  const flightCurveCandidate = useSharedValue<number>(FLIGHT_CURVE.SMOOTH);
  /** The song the flight holds on to, or null; see `flightCameraAt`. */
  const flightAnchorCandidate = useSharedValue<FlightAnchor | null>(null);
  const flightDurationCandidate = useSharedValue(0);
  /** The map's content, for a throw at L0 to be held inside; see `mapFrame`. */
  const mapFrameSharedCandidate = useSharedValue<MapFrame | null>(null);
  /**
   * The touch going down now stopped a glide, so it is not a tap. Written by
   * whichever recogniser sees the touch first, cleared when the tap finishes.
   */
  const caughtGlideCandidate = useSharedValue(false);
  /** The map's extent down the rail, or null while the map has no rail. */
  const railExtentSharedCandidate = useSharedValue<RailExtent | null>(null);
  /** A finger on the rail is steering the camera. */
  const railActiveCandidate = useSharedValue(false);
  /**
   * Every placement's gathered seat and bloom offset, four numbers each, for
   * the pinch to find the song under the fingers on the UI thread.
   */
  const anchorsSharedCandidate = useSharedValue<readonly number[]>([]);
  /** The map's own zoom floor, for the pinch; see `overviewMinRatio`. */
  const minRatioSharedCandidate = useSharedValue<number>(
    FIELD_CAMERA_KNOBS.MIN_SCALE_RATIO,
  );
  /**
   * How far an edge pull has come, in screen pixels: positive is the composer
   * being drawn down from the top, negative is engines being drawn up from the
   * bottom, zero is neither.
   *
   * A surface reads this directly on the UI thread, so a pull *is* the sheet
   * moving rather than a gesture whose result appears afterwards. It stays the
   * one place that position lives: the gesture writes it with the finger, and
   * React writes it — through a timing curve — when the sheet opens or closes.
   */
  const pullSharedCandidate = useSharedValue(0);
  /**
   * Where a released blind is headed, so the release is animated exactly once.
   *
   * The gesture starts the run itself, on the UI thread, at the instant the
   * finger lifts — a blind must not stand still for the commit that tells
   * React the sheet is open. React then reads this, sees the run is already
   * going where it wants it to go, and leaves it alone. NaN means a finger has
   * it: nothing is headed anywhere while it is still being held.
   */
  const pullDestinationCandidate = useSharedValue(0);
  const cameraShared = useRef(cameraSharedCandidate).current;
  const focusKeyShared = useRef(focusKeySharedCandidate).current;
  const fitScaleShared = useRef(fitScaleSharedCandidate).current;
  /** The live layout's terminal FIT, which is what the pinch clamps against. */
  const layoutFitShared = useRef(layoutFitSharedCandidate).current;
  const mirrorBusy = useRef(mirrorBusyCandidate).current;
  const summaryShared = useRef(summarySharedCandidate).current;
  const originShared = useRef(originSharedCandidate).current;
  const pullShared = useRef(pullSharedCandidate).current;
  const pullDestination = useRef(pullDestinationCandidate).current;
  const shelfSeatsShared = useRef(shelfSeatsSharedCandidate).current;
  const recutProgress = useRef(recutProgressCandidate).current;
  const recutEnds = useRef(recutEndsCandidate).current;
  const flightFrom = useRef(flightFromCandidate).current;
  const flightTo = useRef(flightToCandidate).current;
  const flightProgress = useRef(flightProgressCandidate).current;
  const flightCurve = useRef(flightCurveCandidate).current;
  const flightAnchor = useRef(flightAnchorCandidate).current;
  const flightDuration = useRef(flightDurationCandidate).current;
  const mapFrameShared = useRef(mapFrameSharedCandidate).current;
  const caughtGlide = useRef(caughtGlideCandidate).current;
  const railExtentShared = useRef(railExtentSharedCandidate).current;
  const railActive = useRef(railActiveCandidate).current;
  const minRatioShared = useRef(minRatioSharedCandidate).current;
  const anchorsShared = useRef(anchorsSharedCandidate).current;

  layoutRef.current = layout;
  const seats = useMemo(
    () => (layout === null ? [] : shelfSeats(layout)),
    [layout],
  );
  const layoutFrame = useMemo(
    () => (layout === null ? null : mapFrame(layout)),
    [layout],
  );
  const railNow = useMemo(() => {
    if (layout === null || layoutFrame === null || viewport === null)
      return null;
    const extent = railExtent(layoutFrame, layout.fitScale);
    return railWanted(extent, layout.fitScale, viewport) ? extent : null;
  }, [layoutFrame, layout, viewport]);
  useEffect(() => {
    shelfSeatsShared.value = seats;
    mapFrameShared.value = layoutFrame;
    railExtentShared.value = railNow;
    anchorsShared.value =
      layout === null
        ? []
        : layout.placements.flatMap(placement => [
            placement.targetX,
            placement.targetY,
            placement.targetBloomX,
            placement.targetBloomY,
          ]);
    minRatioShared.value =
      layoutFrame === null || viewport === null
        ? FIELD_CAMERA_KNOBS.MIN_SCALE_RATIO
        : overviewMinRatio(layoutFrame, viewport);
    originShared.value = {
      centerX: layout?.fieldCenter.x ?? 0,
      groupCount: layout?.groups.length ?? 0,
    };
  }, [
    anchorsShared,
    layoutFrame,
    layout,
    mapFrameShared,
    minRatioShared,
    originShared,
    railNow,
    railExtentShared,
    seats,
    shelfSeatsShared,
    viewport,
  ]);

  /**
   * FIT as the field is drawn right now: the re-cut's own value while one is
   * in the air, since that is written on the UI thread and not to React.
   */
  const renderedFit = useCallback(
    (fallback: number): number =>
      nativeFlight.current !== null
        ? fitScaleShared.value
        : lastRenderFitScale.current ?? fallback,
    [fitScaleShared],
  );
  /**
   * Where every mark is drawn right now, for the re-cut that interrupts this
   * one to start from. Worked out when it is asked for — once, by the next
   * re-cut — rather than on every frame of this one.
   */
  const liveCapture = useCallback((): readonly Placement[] => {
    const model = recutModel.current;
    if (model === null || nativeFlight.current !== model.generation) {
      return lastVisualPlacements.current;
    }
    const eased = smootherstep(Math.min(Math.max(recutProgress.value, 0), 1));
    return model.flights.map(flight => placementFlightAt(flight, eased));
  }, [recutProgress]);
  const commitCamera = useCallback(
    (next: Camera) => {
      cameraRef.current = next;
      cameraShared.value = next;
      // React is being handed this camera, so this is what it has heard.
      summaryShared.value = cameraSummary(
        next,
        fitScaleShared.value,
        shelfSeatsShared.value,
        originShared.value,
      );
      setCameraState(next);
    },
    [
      cameraShared,
      fitScaleShared,
      originShared,
      shelfSeatsShared,
      summaryShared,
    ],
  );
  /**
   * Copy a UI-thread camera frame into React.
   *
   * The camera is authored on the UI thread while a finger is down, and React
   * is a mirror of it rather than its owner. Only one mirror is allowed in
   * flight at a time — `mirrorBusy` is cleared by the effect below, after the
   * commit that used the frame — so React receives camera frames exactly as
   * fast as it can commit them. Publishing every touch frame instead made a
   * pan re-render the whole screen, and re-record the Skia picture, per event,
   * with a backlog that outlived the gesture.
   */
  const mirrorCamera = useCallback(
    (next: Camera) => {
      // A frame React already holds would be a bail-out, and a bail-out never
      // reaches the effect that reopens the mirror — so clear it here instead
      // of leaving the gesture permanently unable to reach React again.
      if (cameraRef.current === next) {
        mirrorBusy.value = false;
        return;
      }
      cameraRef.current = next;
      const fit = renderedFit(layoutRef.current?.fitScale ?? 1);
      if (
        focusKeyRef.current === null &&
        next.scale <= fit * LEVEL_SCALE_RATIOS.shelf
      ) {
        setPlayerKey(null);
      }
      setCameraState(next);
    },
    [renderedFit, mirrorBusy],
  );
  useEffect(() => {
    mirrorBusy.value = false;
  }, [camera, mirrorBusy]);
  /**
   * Tell React about a moving camera only when something React shows of it
   * has changed — see `cameraSummary`. Everything drawn from the camera reads
   * `cameraShared` on the UI thread; what React holds is for the chrome, which
   * changes at thresholds, and for hit tests, which read it once a gesture has
   * ended (`mirrorNow`). A summary React could not take yet is left unsent
   * rather than recorded, so the next frame asks again.
   */
  const mirrorOnChange = useCallback(
    (next: Camera) => {
      'worklet';
      const summary = cameraSummary(
        next,
        fitScaleShared.value,
        shelfSeatsShared.value,
        originShared.value,
      );
      if (summary === summaryShared.value || mirrorBusy.value) return;
      summaryShared.value = summary;
      mirrorBusy.value = true;
      runOnJS(mirrorCamera)(next);
    },
    [
      fitScaleShared,
      mirrorBusy,
      mirrorCamera,
      originShared,
      shelfSeatsShared,
      summaryShared,
    ],
  );
  /** Hand React this camera now: a gesture has ended or a flight landed. */
  const mirrorNow = useCallback(
    (next: Camera) => {
      'worklet';
      summaryShared.value = cameraSummary(
        next,
        fitScaleShared.value,
        shelfSeatsShared.value,
        originShared.value,
      );
      mirrorBusy.value = true;
      runOnJS(mirrorCamera)(next);
    },
    [
      fitScaleShared,
      mirrorBusy,
      mirrorCamera,
      originShared,
      shelfSeatsShared,
      summaryShared,
    ],
  );
  useEffect(() => {
    layoutFitShared.value = layout?.fitScale ?? 0;
  }, [layout, layoutFitShared]);
  /**
   * Record what the tap landed on.
   *
   * Two states rather than one, because "the placement you descended through"
   * and "the placement whose player is drawn" are different questions with
   * different costs. The first is read by the shelf's accessibility list and
   * by the climb back out, and it is true the moment you tap. The second is
   * what the canvas mounts the player's chrome from — and the canvas is a
   * Skia scene held by identity, so changing it re-records the whole tree from
   * whatever the JS thread last held. See the Flicker Law note in
   * `FieldCanvas`.
   *
   * Entering a *shelf* has no player in it: the flight ends at
   * `LEVEL_SCALE_RATIOS.shelf` and the song band does not open until 12. So
   * writing the player's focus there bought nothing and cost the whole L0 → L1
   * descent one re-recorded frame — a flicker on the tap, and none on the
   * pinch, which never touches this.
   */
  const commitFocus = useCallback(
    (next: string | null, drawsPlayer: boolean) => {
      focusKeyRef.current = next;
      focusKeyShared.value = next;
      setFocusKey(next);
      // Logical focus leaves immediately; the outgoing drawing keeps its
      // owner until the camera has returned it to the row pose.
      const fit = renderedFit(layoutRef.current?.fitScale ?? 1);
      if (next !== null && drawsPlayer) setPlayerKey(next);
      else if (cameraShared.value.scale <= fit * LEVEL_SCALE_RATIOS.shelf) {
        setPlayerKey(null);
      }
    },
    [renderedFit, cameraShared, focusKeyShared],
  );
  const cancelCameraFlight = useCallback(() => {
    // A descent still waiting for its commit is a flight like any other, so
    // anything that takes the camera somewhere else drops it. The newest
    // flight wins, which is what every other caller here already assumes.
    pendingDescent.current = null;
    pendingStepLeg.current = null;
    stepTarget.current = null;
    flightThen.current = null;
    cameraFlying.current = false;
    cancelAnimation(flightProgress);
    // A glide stopped from here is not a glide still moving, which is what a
    // touch asks `catchGlide` before it decides it was not a tap.
    flightCurve.value = FLIGHT_CURVE.SMOOTH;
  }, [flightCurve, flightProgress]);
  const landFlight = useCallback(() => {
    cameraFlying.current = false;
    const then = flightThen.current;
    flightThen.current = null;
    then?.();
  }, []);
  const cancelRelayout = useCallback(() => {
    cancelAnimation(recutProgress);
  }, [recutProgress]);
  const cancelGesture = useCallback(() => {
    cancelCameraFlight();
    pinching.value = false;
    pinchStart.value = null;
    panStart.value = null;
  }, [cancelCameraFlight, panStart, pinchStart, pinching]);

  /** The closest the camera may stand back from this map, as a multiple of FIT. */
  const minRatioOf = useCallback(
    (field: FieldLayout): number => {
      const frame = mapFrame(field);
      return frame === null || viewport === null
        ? FIELD_CAMERA_KNOBS.MIN_SCALE_RATIO
        : overviewMinRatio(frame, viewport);
    },
    [viewport],
  );
  const clampScale = useCallback(
    (scale: number, field: FieldLayout): number => {
      return Math.min(
        Math.max(scale, field.fitScale * minRatioOf(field)),
        field.fitScale * FIELD_CAMERA_KNOBS.MAX_SCALE_RATIO,
      );
    },
    [minRatioOf],
  );

  /**
   * A flight's arrival, for every flight's clock.
   *
   * Arrival does not depend on the reaction below having run. The reaction is
   * what makes the flight *smooth*; this is what makes it *land*, so a flight
   * can never leave the camera short of the target it was given.
   */
  const flightLanded = useCallback(
    (finished?: boolean) => {
      'worklet';
      if (finished !== true) return;
      const landed = flightTo.value;
      cameraShared.value = landed;
      mirrorNow(landed);
      // Queued after the mirror, so whatever runs on landing already reads the
      // camera the flight arrived at.
      runOnJS(landFlight)();
    },
    [cameraShared, flightTo, landFlight, mirrorNow],
  );
  const flyTo = useCallback(
    (
      target: Camera,
      durationMs: number = FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS,
      then: (() => void) | null = null,
      /** The song the flight is about, held as its cluster reshapes. */
      anchor: Placement | null = null,
    ) => {
      cancelCameraFlight();
      if (reducedMotion) {
        commitCamera(target);
        then?.();
        return;
      }
      flightThen.current = then;
      cameraFlying.current = true;
      flightCurve.value = FLIGHT_CURVE.SMOOTH;
      flightDuration.value = durationMs;
      flightAnchor.value =
        anchor === null
          ? null
          : { bloomX: anchor.targetBloomX, bloomY: anchor.targetBloomY };
      // From the *live* camera, not React's copy of it. A flight that begins
      // where the last mirrored frame happened to land would start with a jump
      // back to it — the exact distance the gesture covered after React's last
      // commit, which is precisely when flights are asked for.
      flightFrom.value = cameraShared.value;
      flightTo.value = target;
      flightProgress.value = 0;
      // Linear, because `interpolateCamera` in the reaction below is where the
      // house curve lives. Easing both would smootherstep a smootherstep.
      flightProgress.value = withTiming(
        1,
        { duration: durationMs, easing: Easing.linear },
        flightLanded,
      );
    },
    [
      cameraShared,
      cancelCameraFlight,
      commitCamera,
      flightAnchor,
      flightCurve,
      flightDuration,
      flightFrom,
      flightLanded,
      flightProgress,
      flightTo,
      reducedMotion,
    ],
  );
  /**
   * A glide the gesture has already launched on the UI thread, told to JS:
   * it is a flight like any other, so a re-cut or a tap that arrives while it
   * is moving treats it as one. Anything still waiting to fly is dropped,
   * because the newest flight wins.
   */
  const beginGlide = useCallback(() => {
    pendingDescent.current = null;
    pendingStepLeg.current = null;
    stepTarget.current = null;
    flightThen.current = null;
    cameraFlying.current = true;
  }, []);

  /**
   * The flight itself, one frame at a time on the UI thread.
   *
   * `interpolateCamera` inlined rather than called. Not because the call would
   * cross a module — `zoomAroundFocalPoint` already does that from the pinch —
   * but because it reaches `smootherstep` in `bands.ts`, which is not a
   * worklet, and neither is the `lerp` below it in `camera.ts`. Making it
   * callable from here means marking a chain of helpers in two other modules
   * and moving one of them above its caller, which is a larger change than the
   * six lines it would save. The maths is the same: smootherstep on position,
   * logarithmic on scale, so a zoom reads as even. A glide swaps the
   * smootherstep for `glideEase`, which is a worklet already.
   *
   * React learns the camera exactly as fast as it can commit one, through the
   * same back-pressure a pan uses; the picture's transform covers every frame in
   * between. The last frame is mirrored unconditionally, because a flight has to
   * *end* with React holding the camera it landed on.
   */
  useAnimatedReaction(
    () => flightProgress.value,
    progress => {
      'worklet';
      if (progress >= 1) {
        const landed = flightTo.value;
        cameraShared.value = landed;
        mirrorNow(landed);
        return;
      }
      const from = flightFrom.value;
      const to = flightTo.value;
      if (!(from.scale > 0) || !(to.scale > 0)) return;
      const t = progress;
      const eased =
        flightCurve.value === FLIGHT_CURVE.GLIDE
          ? glideEase(t)
          : t * t * t * (t * (t * 6 - 15) + 10);
      const next = flightCameraAt(
        from,
        to,
        eased,
        flightAnchor.value,
        layoutFitShared.value,
      );
      cameraShared.value = next;
      mirrorOnChange(next);
    },
  );

  /*
   * Diff and capture during render, following the motion engine's trigger
   * ritual. The prop change itself creates a born generation at progress zero;
   * no commit can therefore expose the new target under the old 1.0 clock.
   */
  if (
    layout !== null &&
    (recutModel.current === null ||
      layoutsDiffer(recutModel.current.layout, layout))
  ) {
    const previous = recutModel.current;
    const generation = (previous?.generation ?? 0) + 1;
    const firstLayout = previous === null;
    const fromFitScale = renderedFit(previous?.toFitScale ?? layout.fitScale);
    const fromCamera = firstLayout
      ? levelCameraTarget('field', layout) ?? EMPTY_CAMERA
      : cameraShared.value;
    /*
     * The song you are standing in can leave the field under you: forgetting
     * an engine takes its songs while you may be reading one.
     *
     * Carrying the camera's distance ratio through the new fit — which is all
     * the correction below does — leaves it at song scale over a seat nothing
     * is in any more. On the device that read as a small zoom and a nudge,
     * with no way out but the system's back button.
     *
     * So the climb out rides the re-cut's own clock rather than a camera
     * flight of its own: two tweens both writing `cameraShared` for the same
     * few hundred milliseconds is the one thing this hook is built not to do.
     * Its shelf when that shelf survived it and home when it did not, which is
     * the answer `ascend` gives from a placement it can no longer find.
     *
     * Asked of the *entity*, not the placement key: re-arranging re-keys every
     * placement in the field without one song leaving it, and that must never
     * throw the camera out of the song you are reading.
     */
    const held = standing.current;
    const stranded =
      held !== null &&
      !firstLayout &&
      isSongDistance(fromCamera.scale, fromFitScale) &&
      !layout.placements.some(
        placement => placement.entityKey === held.entityKey,
      );
    if (stranded) standing.current = null;
    /*
     * Where the camera is headed, not only where it is: a flight in the air
     * is an intention, and a regroup that planned from the flight's midpoint
     * stranded it there. A flight to the old field's home is a flight home.
     */
    const flying = !firstLayout && cameraFlying.current;
    const heading = flying ? flightTo.value : fromCamera;
    const oldHome =
      previous === null ? null : levelCameraTarget('field', previous.layout);
    const flyingHome =
      flying && oldHome !== null && sameCamera(heading, oldHome);
    const newHome = levelCameraTarget('field', layout);
    const fitCorrected = {
      ...heading,
      scale: clampScale(
        (heading.scale / fromFitScale) * layout.fitScale,
        layout,
      ),
    };
    /*
     * A change of axis on the map: the camera's position on the old map means
     * nothing on the new one — a height among albums is not a height among
     * weeks. So the axis being left keeps where it was, and the axis being
     * entered is opened where it was last left, or at its home. Held inside
     * the new map's range: the library may have grown or shrunk since.
     *
     * Only at the map. Inside a shelf or a song a regroup keeps you where you
     * are, as it always has.
     */
    const previousAxis = previous?.axisKey;
    const axisChanged =
      !firstLayout && axisKey !== undefined && previousAxis !== axisKey;
    const atMap =
      heading.scale / fromFitScale < LEVEL_BOUNDARIES.field && !stranded;
    const wasFiltered = previous?.filtered ?? false;
    const filterArrives = !firstLayout && filtered && !wasFiltered;
    const filterLeaves = !firstLayout && !filtered && wasFiltered;
    if (filterArrives) {
      const kept = {
        x: heading.x,
        y: heading.y,
        ratio: heading.scale / fromFitScale,
      };
      beforeFilter.current = { ...kept, axisKey: previousAxis };
      // The whole map's place on this axis is the one being left.
      if (atMap && previousAxis !== undefined) {
        axisCameras.current.set(previousAxis, kept);
      }
    }
    let axisCamera: Camera | null = null;
    if (axisChanged && atMap && filtered && wasFiltered) {
      // A narrowed map has no place of its own to keep or return to.
      axisCamera = newHome;
    } else if (axisChanged && atMap) {
      if (previousAxis !== undefined) {
        axisCameras.current.set(previousAxis, {
          x: heading.x,
          y: heading.y,
          ratio: heading.scale / fromFitScale,
        });
      }
      const kept = axisCameras.current.get(axisKey);
      const frame = mapFrame(layout);
      if (kept !== undefined && frame !== null && viewport !== null) {
        const scale = clampScale(kept.ratio * layout.fitScale, layout);
        const range = mapCameraRange(frame, viewport, scale);
        axisCamera = {
          scale,
          x: Math.min(Math.max(kept.x, range.minX), range.maxX),
          y: Math.min(Math.max(kept.y, range.minY), range.maxY),
        };
      } else {
        axisCamera = newHome;
      }
    }
    /*
     * The filter going: back to where the first filter found the camera —
     * on this axis, or this axis's own place when the axis changed since —
     * held inside the whole map's range, which a library change may have
     * moved.
     */
    let restored: Camera | null = null;
    if (filterLeaves) {
      const stash = beforeFilter.current;
      beforeFilter.current = null;
      const kept =
        stash !== null && stash.axisKey === axisKey
          ? stash
          : axisKey === undefined
          ? undefined
          : axisCameras.current.get(axisKey);
      const frame = mapFrame(layout);
      if (
        kept !== undefined &&
        kept !== null &&
        frame !== null &&
        viewport !== null
      ) {
        const scale = clampScale(kept.ratio * layout.fitScale, layout);
        const atShelf = kept.ratio >= LEVEL_BOUNDARIES.field;
        const range = mapCameraRange(frame, viewport, scale);
        restored = atShelf
          ? { scale, x: kept.x, y: kept.y }
          : {
              scale,
              x: Math.min(Math.max(kept.x, range.minX), range.maxX),
              y: Math.min(Math.max(kept.y, range.minY), range.maxY),
            };
      } else {
        restored = newHome;
      }
    }
    let toCamera = firstLayout
      ? fromCamera
      : restored !== null
      ? restored
      : axisCamera !== null
      ? axisCamera
      : recutQuiet && newHome !== null
      ? newHome
      : stranded
      ? levelCameraTarget('shelf', layout, held) ?? newHome ?? fitCorrected
      : flyingHome
      ? newHome ?? fitCorrected
      : fitCorrected;
    /*
     * The shelf you stand in can leave the field as well: a tag filter that
     * keeps none of its songs, a forgotten node that took all of them. At
     * shelf distance over where it stood, the page was empty under a header
     * naming whichever seat was now nearest, with nothing to say why. So the
     * re-cut goes home — the same answer the map gives to space it no longer
     * fills, below.
     */
    if (
      previous !== null &&
      !stranded &&
      restored === null &&
      newHome !== null &&
      isShelfDistance(heading.scale, fromFitScale) &&
      !isSongDistance(heading.scale, fromFitScale)
    ) {
      const leaving = shelfSeats(previous.layout);
      const seat = nearestSeat(leaving, heading);
      if (
        seat >= 0 &&
        !layout.groups.some(group => group.key === leaving[seat].key)
      ) {
        toCamera = newHome;
      }
    }
    /*
     * At the map, a regroup that would leave the camera over space the new
     * layout does not fill goes home instead: groups move when the field is
     * re-cut, and the camera standing where one used to be showed an empty
     * field with nothing to say why.
     */
    if (
      !firstLayout &&
      !stranded &&
      newHome !== null &&
      viewport !== null &&
      toCamera.scale / layout.fitScale < LEVEL_BOUNDARIES.field &&
      !anyPlacementInView(layout, toCamera, viewport)
    ) {
      toCamera = newHome;
    }
    if (flying) absorbedFlight.current = generation;
    const sources = firstLayout
      ? layout.placements
      : liveCapture().filter(stillDrawn);
    const flights = planPlacementFlights(
      sources,
      layout.placements,
      generation,
    );
    const fromGroups = previous?.layout.groups ?? [];
    const animate =
      !firstLayout &&
      !reducedMotion &&
      !recutQuiet &&
      (flightsMove(flights) ||
        groupsChanged(fromGroups, layout.groups) ||
        camerasDiffer(fromCamera, toCamera) ||
        fromFitScale !== layout.fitScale);
    recutModel.current = {
      generation,
      layout,
      flights,
      fromFitScale,
      toFitScale: layout.fitScale,
      fromCamera,
      toCamera,
      fromGroups,
      animate,
      axisKey,
      filtered,
    };
    if (stranded) strandedFocus.current = generation;
  }

  const activeRecut = recutModel.current;
  const recutBorn =
    activeRecut !== null && recutClock.generation !== activeRecut.generation;
  const relayoutLinear =
    activeRecut === null
      ? 1
      : recutBorn
      ? activeRecut.animate
        ? 0
        : 1
      : recutClock.linear;
  const layoutProgress = smootherstep(relayoutLinear);
  const renderedCamera =
    activeRecut !== null && recutBorn ? activeRecut.fromCamera : camera;
  const renderFitScale =
    activeRecut === null
      ? layout?.fitScale ?? EMPTY_CAMERA.scale
      : interpolatePositiveScale(
          activeRecut.fromFitScale,
          activeRecut.toFitScale,
          layoutProgress,
        );
  const visualPlacements = useMemo(
    () =>
      activeRecut === null
        ? []
        : activeRecut.flights.map(flight =>
            placementFlightAt(flight, layoutProgress),
          ),
    [activeRecut, layoutProgress],
  );
  const renderedPlacements = useMemo(
    () =>
      visualPlacements.filter(
        placement => placement.targetPlacementKey !== null,
      ),
    [visualPlacements],
  );
  // Native-driven frames update these refs from their lightweight clock tick.
  // A parent data refresh must not overwrite that live capture with the born
  // React snapshot while the UI-runtime canvas is already farther along — and
  // "born" is one render, while the flight is hundreds of milliseconds during
  // which anything upstream may re-render. The flight itself is the window.
  const nativeFlightLive =
    activeRecut !== null &&
    activeRecut.animate &&
    (recutBorn || nativeFlight.current === activeRecut.generation);
  if (!nativeFlightLive) {
    lastVisualPlacements.current = visualPlacements;
    lastRenderFitScale.current = renderFitScale;
  }

  /** A re-cut has landed: React takes the camera and the settled clock. */
  const landRecut = useCallback(
    (generation: number) => {
      const model = recutModel.current;
      if (model === null || model.generation !== generation) return;
      nativeFlight.current = null;
      setRecutClock({ generation, linear: 1 });
      commitCamera(model.toCamera);
    },
    [commitCamera],
  );
  /**
   * The re-cut's camera and fit, one frame at a time on the UI thread.
   *
   * The same curves a camera flight uses (see the reaction on
   * `flightProgress`): smootherstep on position, logarithmic on scale, and the
   * fit on the same eased clock.
   */
  useAnimatedReaction(
    () => recutProgress.value,
    (progress, previous) => {
      'worklet';
      if (progress === previous) return;
      const ends = recutEnds.value;
      if (ends === null) return;
      const t = Math.min(Math.max(progress, 0), 1);
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      const from = ends.fromCamera;
      const to = ends.toCamera;
      fitScaleShared.value = Math.exp(
        Math.log(ends.fromFitScale) +
          (Math.log(ends.toFitScale) - Math.log(ends.fromFitScale)) * eased,
      );
      if (!(from.scale > 0) || !(to.scale > 0)) return;
      cameraShared.value = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        scale: Math.exp(
          Math.log(from.scale) +
            (Math.log(to.scale) - Math.log(from.scale)) * eased,
        ),
      };
    },
  );

  useEffect(() => {
    const model = recutModel.current;
    if (model === null) return;
    const generation = model.generation;
    if (absorbedFlight.current === generation) {
      absorbedFlight.current = null;
      cancelCameraFlight();
    }
    cancelRelayout();
    if (!model.animate) {
      nativeFlight.current = null;
      commitCamera(model.toCamera);
      fitScaleShared.value = model.toFitScale;
      setRecutClock({ generation, linear: 1 });
      return;
    }
    fitScaleShared.value = model.fromFitScale;
    nativeFlight.current = generation;
    setRecutClock({ generation, linear: 0 });
    // React is not told about the frames between: the canvas plays the
    // re-cut from its own clock, the reaction below moves the camera and fit
    // on the UI thread, and React hears the landing.
    recutEnds.value = {
      fromCamera: model.fromCamera,
      toCamera: model.toCamera,
      fromFitScale: model.fromFitScale,
      toFitScale: model.toFitScale,
    };
    recutProgress.value = 0;
    recutProgress.value = withTiming(
      1,
      { duration: FIELD_CAMERA_KNOBS.RELAYOUT_MS, easing: Easing.linear },
      finished => {
        'worklet';
        if (finished === true) runOnJS(landRecut)(generation);
      },
    );
  }, [
    activeRecut?.generation,
    cancelCameraFlight,
    cancelRelayout,
    commitCamera,
    fitScaleShared,
    landRecut,
    recutEnds,
    recutProgress,
  ]);

  useEffect(
    () => () => {
      cancelCameraFlight();
      cancelRelayout();
    },
    [cancelCameraFlight, cancelRelayout],
  );

  const focus = useMemo(
    () =>
      renderedPlacements.find(placement => placement.key === focusKey) ?? null,
    [focusKey, renderedPlacements],
  );
  /**
   * The placement the canvas draws a player for, which is not always the focus.
   *
   * Held apart for the reason `commitFocus` gives: this one changing is a
   * re-recorded Skia scene, so it may only change when a player is genuinely
   * on its way. Entering a shelf leaves it exactly where it was.
   */
  const playerFocus = useMemo(
    () =>
      renderedPlacements.find(placement => placement.key === playerKey) ?? null,
    [playerKey, renderedPlacements],
  );
  const focusRef = useRef<Placement | null>(null);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
  /*
   * The placement the camera is standing in, held past its own removal.
   *
   * `focus` is a lookup into the placements actually being drawn, so it empties
   * the instant its song leaves the field — the one moment the climb out needs
   * it, to name the shelf to climb back to. Captured here rather than written
   * by `commitFocus` so it follows what is on screen: a placement that survives
   * a re-arrangement under a new key is still the one you are reading.
   */
  standing.current = focus ?? standing.current;
  const level =
    layout === null ? 'field' : levelOf(renderedCamera.scale, renderFitScale);

  /**
   * The cluster the camera is standing in — geometry's answer, not the tap's.
   *
   * `focus` is the placement you descended through and is written only by
   * `descend`, so the header it fed named the shelf you *entered*: pan from
   * September to August and it still said September. This asks where the
   * camera is instead, which is the question the chrome was always asking.
   *
   * Derived in React rather than pushed from the gesture: the header can only
   * change as fast as React commits anyway, and React already re-renders on
   * every camera frame it can take, because that is what records the picture.
   */
  const groupKey = useMemo(() => {
    if (level === 'field' || seats.length === 0) return null;
    // Below L1 the camera is inside one song, and the shelf it belongs to is
    // the one that song was seated in — a nearest-seat answer would name
    // whichever column the camera happens to be over.
    //
    // Unless there is no focus left to ask. Leaving a song clears it before the
    // flight back to the shelf has finished, so for the first part of that
    // climb this is the only question still worth asking — and at this distance
    // it answers well, because a camera standing inside a song is standing over
    // that song's own column. Without the fallback the header empties for a
    // few frames and fills again, which is the flicker `nearestSeat` was
    // brought in to remove one level up.
    if (level !== 'shelf' && focus !== null) return focus.groupKey;
    const index = nearestSeat(seats, renderedCamera);
    return index < 0 ? null : seats[index].key;
  }, [focus, level, renderedCamera, seats]);

  /**
   * A shelf with one song's row on screen: the column, with the camera as near
   * that row as the column's run allows.
   *
   * Where a tap on the map enters a shelf, and where a song climbs back out to.
   * `levelCameraTarget` seats the camera in the column's middle, which in a
   * column taller than the screen is somewhere you did not touch: a tap near
   * the top of a big cluster flew to its middle, and every mark on screen left
   * it at full speed. Seats are handed out top to bottom (`browseCluster`), so
   * the row a mark gathers into is at the height you touched it.
   */
  const shelfAround = useCallback(
    (field: FieldLayout, placement: Placement): Camera | null => {
      const shelf = levelCameraTarget('shelf', field, placement);
      if (shelf === null || viewport === null) return shelf;
      const seat = shelfSeats(field).find(
        candidate => candidate.key === placement.groupKey,
      );
      if (seat === undefined) return shelf;
      return seatCameraAround(seat, placement.targetY, viewport, shelf.scale);
    },
    [viewport],
  );
  /**
   * Move one level closer to the tapped placement.
   *
   * Descending is always a single step, never a jump: the zoom model is the
   * navigation, so skipping a level would skip the only thing that tells you
   * where you are.
   */
  const descend = useCallback(
    (placement: Placement) => {
      const field = layoutRef.current;
      if (field === null) return;
      const current = levelOf(
        cameraShared.value.scale,
        renderedFit(field.fitScale),
      );
      // Where the descent stops is `GRAIN_ENABLED`'s to say: with L3 closed a
      // song is the end of it, and tapping the player again does nothing rather
      // than flying to a distance nothing is drawn at.
      const next =
        current === 'field'
          ? 'shelf'
          : current === 'shelf'
          ? 'song'
          : current === 'song' && GRAIN_ENABLED
          ? 'grain'
          : null;
      if (next === null) return;
      const target =
        next === 'shelf'
          ? shelfAround(field, placement)
          : levelCameraTarget(next, field, placement);
      if (!target) return;
      const drawsPlayer = next === 'song' || next === 'grain';
      commitFocus(placement.key, drawsPlayer);
      if (!drawsPlayer) {
        flyTo(target, FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS, null, placement);
        return;
      }
      /*
       * A descent that mounts a player waits for the commit that mounts it.
       *
       * The player's words are measured and cut on the JS thread, so putting
       * one on the canvas is a React commit however it is written — and a
       * commit hands `Canvas` a fresh element, which makes Skia stop the
       * animation mapper, re-record the whole root from the values the JS
       * thread holds, paint that frame, and only then restart. Those values
       * are stale exactly when the camera is moving.
       *
       * So the flight is what moves, not the commit. Started here it would
       * already be running by the time React committed — `setState` in an
       * event handler is batched — and the re-record would land a frame or two
       * into the descent and paint the field where it no longer is. Held for
       * the effect below, the re-record happens against a camera that has not
       * moved yet, where a stale value and a live one are the same value.
       *
       * The same trick, and for the same reason, as the re-cut clock that
       * starts in `NativeFieldContent`'s effect rather than in the canvas's
       * layout effect.
       */
      pendingDescent.current = target;
      setDescentTicket(ticket => ticket + 1);
    },
    [renderedFit, cameraShared, commitFocus, flyTo, shelfAround],
  );
  /*
   * Ticket rather than the focus itself: descending from a song into its grain
   * keeps the same placement, so a key would not change and the flight would
   * never leave. A counter always does.
   */
  useEffect(() => {
    const leg = pendingStepLeg.current;
    if (leg !== null) {
      pendingStepLeg.current = null;
      flyTo(leg, FIELD_CAMERA_KNOBS.STEP_LEG_MS);
      return;
    }
    const target = pendingDescent.current;
    if (target === null) return;
    pendingDescent.current = null;
    flyTo(target);
  }, [descentTicket, flyTo]);
  /*
   * Drop the focus the re-cut just climbed out of.
   *
   * The camera is already on its way — the re-cut is flying it — so this is
   * only the bookkeeping: `focusKey` still names a placement that no longer
   * exists, and `ascend` and the hit tests both read it. Deferred to an effect
   * because the strand is decided during render, where React state may not be
   * written.
   */
  useEffect(() => {
    if (strandedFocus.current === null) return;
    strandedFocus.current = null;
    commitFocus(null, true);
  }, [commitFocus, activeRecut?.generation]);
  const ascend = useCallback((): boolean => {
    const field = layoutRef.current;
    if (field === null) return false;
    const current = levelOf(
      cameraShared.value.scale,
      renderedFit(field.fitScale),
    );
    if (current === 'field') return false;

    // Leaving a song returns to its shelf, which needs the placement we came
    // in through; without one there is no group to return to, so go home.
    if (current !== 'shelf') {
      const placement = focusRef.current;
      const shelf = placement ? shelfAround(field, placement) : null;
      if (shelf) {
        flyTo(shelf);
        // Drop navigation focus now, retaining the outgoing canvas owner
        // until mirrorCamera observes the fully collapsed row pose.
        commitFocus(null, true);
        return true;
      }
    }
    commitFocus(null, true);
    // Leaving a shelf returns to the map with that shelf's cluster still on
    // screen, not to the top of the field: the climb out of a song keeps your
    // place in the column, and this keeps it on the map. The shelf is the one
    // the camera is standing in, which a pan may have changed since the tap.
    const seat =
      current === 'shelf' ? nearestSeat(seats, cameraShared.value) : -1;
    const target =
      (seat >= 0 && viewport !== null
        ? mapCameraAround(field, seats[seat].key, viewport)
        : null) ?? levelCameraTarget('field', field);
    // The row in the middle of the view is the song the climb holds on to, so
    // the shelf closes into its cluster around it rather than sliding away.
    let held: Placement | null = null;
    if (seat >= 0) {
      const y = cameraShared.value.y;
      for (const placement of field.placements) {
        if (placement.groupKey !== seats[seat].key) continue;
        if (
          held === null ||
          Math.abs(placement.targetY - y) < Math.abs(held.targetY - y)
        ) {
          held = placement;
        }
      }
    }
    if (target) flyTo(target, FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS, null, held);
    return true;
  }, [
    renderedFit,
    cameraShared,
    commitFocus,
    flyTo,
    seats,
    shelfAround,
    viewport,
  ]);
  const step = useCallback(
    (placement: Placement) => {
      // Still folding back into the row: retarget where it goes down again.
      if (stepTarget.current !== null) {
        stepTarget.current = placement;
        return;
      }
      const field = layoutRef.current;
      const from = focusRef.current;
      if (field === null || from === null || from.key === placement.key) {
        return;
      }
      const current = levelOf(
        cameraShared.value.scale,
        renderedFit(field.fitScale),
      );
      if (current !== 'song' && current !== 'grain') return;
      const shelf = shelfAround(field, from);
      if (!shelf) return;
      commitFocus(null, true);
      flyTo(shelf, FIELD_CAMERA_KNOBS.STEP_LEG_MS, () => {
        const destination = stepTarget.current ?? placement;
        stepTarget.current = null;
        const landedOn = layoutRef.current;
        if (landedOn === null) return;
        const target = levelCameraTarget('song', landedOn, destination);
        if (!target) return;
        // `descend`'s own path, one level: commit the new owner, then fly on
        // the commit that mounts it. See the note in `descend`.
        commitFocus(destination.key, true);
        pendingStepLeg.current = target;
        setDescentTicket(ticket => ticket + 1);
      });
      // After `flyTo`, which drops any earlier step's target with its flight.
      stepTarget.current = placement;
    },
    [renderedFit, cameraShared, commitFocus, flyTo, shelfAround],
  );
  const stepping = useCallback(() => stepTarget.current, []);
  /**
   * Go to a song from wherever the camera is: the now-playing jump.
   *
   * The same two moves the zoom model already makes, so the trip reads as
   * travel and not as a cut: out to the song's row in its shelf — across the
   * map if it has to — then down into the song, on the commit that mounts its
   * player as every descent does. Already in it, nothing moves.
   */
  const visit = useCallback(
    (placement: Placement) => {
      const field = layoutRef.current;
      if (field === null) return;
      if (focusRef.current?.key === placement.key) {
        const current = levelOf(
          cameraShared.value.scale,
          renderedFit(field.fitScale),
        );
        if (current === 'song' || current === 'grain') return;
      }
      const shelf = shelfAround(field, placement);
      if (shelf === null) return;
      commitFocus(null, true);
      flyTo(
        shelf,
        FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS,
        () => {
          const landedOn = layoutRef.current;
          if (landedOn === null) return;
          // The layout may have been re-cut under the flight; the song is asked
          // for by its key in whatever is there now.
          const there =
            landedOn.placements.find(each => each.key === placement.key) ??
            landedOn.placements.find(
              each => each.entityKey === placement.entityKey,
            );
          if (there === undefined) return;
          const target = levelCameraTarget('song', landedOn, there);
          if (target === null) return;
          commitFocus(there.key, true);
          pendingDescent.current = target;
          setDescentTicket(ticket => ticket + 1);
        },
        placement,
      );
    },
    [renderedFit, cameraShared, commitFocus, flyTo, shelfAround],
  );
  const home = useCallback(() => {
    const field = layoutRef.current;
    if (field === null) return;
    commitFocus(null, true);
    const target = levelCameraTarget('field', field);
    if (target) flyTo(target);
  }, [commitFocus, flyTo]);
  /** What a tap or a hold landed on, at whatever distance the camera is. */
  const placementAt = useCallback(
    (point: Point): Placement | null => {
      const field = layoutRef.current;
      const size = viewport;
      if (field === null || size === null) return null;
      const hitFitScale = renderedFit(field.fitScale);
      if (
        field.browseBounds &&
        levelOf(cameraShared.value.scale, hitFitScale) === 'field' &&
        !inBrowseFrame(point, size)
      )
        return null;
      return hitTestPlacement(
        renderedPlacements,
        cameraShared.value,
        size,
        point,
        levelOf(cameraShared.value.scale, hitFitScale),
        hitFitScale,
      );
    },
    [renderedFit, cameraShared, renderedPlacements, viewport],
  );

  const holdAt = useCallback(
    (point: Point) => {
      const hit = placementAt(point);
      if (hit !== null) onHoldPlacement?.(hit);
    },
    [onHoldPlacement, placementAt],
  );

  const tapAt = useCallback(
    (point: Point) => {
      const field = layoutRef.current;
      const size = viewport;
      if (field === null || size === null) return;
      const hitFitScale = renderedFit(field.fitScale);
      const hitLevel = levelOf(cameraShared.value.scale, hitFitScale);
      if (
        field.browseBounds &&
        hitLevel === 'field' &&
        !inBrowseFrame(point, size)
      )
        return;
      // The action column is answered before the row it sits in, so `GET` on a
      // song you are not opening does not also open it.
      const actionRow = hitTestRowAction(
        renderedPlacements,
        cameraShared.value,
        size,
        point,
        hitLevel,
        hitFitScale,
      );
      if (actionRow !== null && onRowAction?.(actionRow) === true) return;
      const hit = hitTestPlacement(
        renderedPlacements,
        cameraShared.value,
        size,
        point,
        hitLevel,
        hitFitScale,
      );
      if (hit === null) return;
      // A job is a mark with nothing inside it: tapping one opens what it is
      // doing rather than flying the camera into an empty seat.
      if (onClaimTap?.(hit) === true) return;
      descend(hit);
    },
    [
      renderedFit,
      cameraShared,
      descend,
      onClaimTap,
      onRowAction,
      renderedPlacements,
      viewport,
    ],
  );

  /**
   * Put the camera back in a seat when the finger lifts.
   *
   * The gesture decides *which* seat, because only it knows what the finger
   * asked for before the damping answered; this only flies there. Short, because
   * it is the end of a movement the person is still watching rather than a
   * navigation they asked for — `SEAT_SETTLE_MS`, not `CAMERA_FLIGHT_MS`.
   */
  const settleIntoSeat = useCallback(
    (seatIndex: number) => {
      const size = viewport;
      if (size === null) return;
      const seat = seats[seatIndex];
      if (seat === undefined) return;
      const current = cameraShared.value;
      const bounds = seatCameraBounds(seat, size, current.scale);
      const target: Camera = {
        scale: current.scale,
        x: seat.cx,
        y: Math.min(Math.max(current.y, bounds.min), bounds.max),
      };
      if (
        target.x === current.x &&
        target.y === current.y &&
        target.scale === current.scale
      ) {
        return;
      }
      flyTo(target, FIELD_CAMERA_KNOBS.SEAT_SETTLE_MS);
    },
    [cameraShared, flyTo, seats, viewport],
  );

  /** Leaving the field by an edge pull, which is a JS-side navigation. */
  const completePull = useCallback(
    (pull: PullDirection) => {
      cancelGesture();
      if (pull === 'compose') onOpenComposer();
      else onOpenEngines();
    },
    [cancelGesture, onOpenComposer, onOpenEngines],
  );

  /**
   * Pan, pinch and tap, resolved on the UI thread.
   *
   * The camera moves with the finger inside one worklet: no thread hop per
   * touch event, no React render per frame, and at L0 no JS involvement at all
   * because the canvas reads `cameraShared` directly. React still learns every
   * camera it can keep up with, which is what the level chrome and hit
   * testing are drawn from.
   */
  const gestures = useMemo(() => {
    const knobs = FIELD_CAMERA_KNOBS;
    const publish = (next: Camera) => {
      'worklet';
      cameraShared.value = next;
      mirrorOnChange(next);
    };
    /** A gesture always ends with React holding the camera it ended on. */
    const settle = () => {
      'worklet';
      mirrorNow(cameraShared.value);
    };
    /**
     * A flight started from the UI thread: `flyTo`'s clock, launched in the
     * frame a finger asked for it. A throw that waited a hop for JS to launch
     * it would stand still for a frame at its fastest, and a touch on the rail
     * would answer a frame late. Starting the clock replaces any flight still
     * running, here and now rather than a hop later.
     */
    const launchFlight = (
      target: Camera,
      durationMs: number,
      curve: number,
    ) => {
      'worklet';
      // Told before the clock starts, so the landing it queues is the later
      // of the two calls JS receives.
      runOnJS(beginGlide)();
      flightCurve.value = curve;
      flightAnchor.value = null;
      flightDuration.value = durationMs;
      flightFrom.value = cameraShared.value;
      flightTo.value = target;
      flightProgress.value = 0;
      flightProgress.value = withTiming(
        1,
        { duration: durationMs, easing: Easing.linear },
        flightLanded,
      );
    };
    /**
     * A finger coming down on a glide stops it where it is.
     *
     * On the UI thread and before anything reads the camera, so the pan that
     * follows starts from the frame the finger landed on rather than racing a
     * glide still writing for the length of a hop. A glide still moving fast
     * marks the touch as a catch, which the tap then does not answer.
     */
    const catchGlide = () => {
      'worklet';
      const u = flightProgress.value;
      if (flightCurve.value !== FLIGHT_CURVE.GLIDE || u >= 1) return;
      const speed = glideSpeedPxS(
        flightFrom.value,
        flightTo.value,
        flightDuration.value,
        u,
      );
      cancelAnimation(flightProgress);
      flightCurve.value = FLIGHT_CURVE.SMOOTH;
      if (speed > GLIDE_KNOBS.CATCH_SPEED_PX_S) caughtGlide.value = true;
      mirrorNow(cameraShared.value);
      runOnJS(cancelCameraFlight)();
    };
    /** Carry a throw on, on the glide's curve. */
    const launchGlide = (target: Camera, durationMs: number) => {
      'worklet';
      launchFlight(target, durationMs, FLIGHT_CURVE.GLIDE);
    };
    /** Where a finger at `y` on the rail puts the camera, or null off the map. */
    const railTarget = (y: number): Camera | null => {
      'worklet';
      const extent = railExtentShared.value;
      const frame = mapFrameShared.value;
      const size = viewport;
      const fitScale = layoutFitShared.value;
      const current = cameraShared.value;
      if (
        extent === null ||
        frame === null ||
        size === null ||
        !(fitScale > 0) ||
        current.scale / fitScale >= LEVEL_BOUNDARIES.field
      ) {
        return null;
      }
      return railCamera(
        y,
        current,
        extent,
        size,
        mapCameraRange(frame, size, current.scale),
      );
    };
    /*
     * The rail. A touch flies the map to the finger — a short flight, because
     * the map may be many screens away and a jump would lose you — and a drag
     * then moves it with the finger. A drag that starts while that flight is
     * still in the air moves where it is going instead, so the camera never
     * leaves its curve for a frame.
     */
    const rail = Gesture.Pan()
      .minDistance(0)
      .maxPointers(1)
      .onBegin(event => {
        'worklet';
        const target = pullDestination.value === 0 ? railTarget(event.y) : null;
        railActive.value = target !== null;
        if (target === null) return;
        launchFlight(target, RAIL_KNOBS.JUMP_MS, FLIGHT_CURVE.RAIL);
      })
      .onUpdate(event => {
        'worklet';
        if (!railActive.value) return;
        const target = railTarget(event.y);
        if (target === null) return;
        if (
          flightCurve.value === FLIGHT_CURVE.RAIL &&
          flightProgress.value < 1
        ) {
          flightTo.value = target;
          return;
        }
        publish(target);
      })
      .onFinalize(() => {
        'worklet';
        if (!railActive.value) return;
        railActive.value = false;
        // A flight still in the air lands, and mirrors, by itself.
        if (
          flightCurve.value !== FLIGHT_CURVE.RAIL ||
          flightProgress.value >= 1
        ) {
          settle();
        }
      });
    const pinch = Gesture.Pinch()
      .onStart(event => {
        'worklet';
        runOnJS(cancelCameraFlight)();
        pinching.value = true;
        const drag = panStart.value;
        if (drag !== null) panStart.value = { ...drag, pinched: true };
        const startCamera = cameraShared.value;
        // Zoom is still the navigation, so a pinch is how you leave a song —
        // but inside one it pulls against the middle of the view rather than
        // against the fingers. Anchored to the fingers it translates as well as
        // scales, which is the same complaint the pan answers: the player is
        // not a map and must not slide out from under itself.
        //
        // Decided once, from the camera the pinch began on, rather than read
        // live: a gesture that swapped its anchor halfway through would jump by
        // the distance between the fingers and the centre, exactly as it
        // crossed back out into the shelf.
        const centred = isSongDistance(
          startCamera.scale,
          layoutFitShared.value,
        );
        const size = viewport;
        const focal =
          centred && size !== null
            ? { x: size.width / 2, y: size.height / 2 }
            : { x: event.focalX, y: event.focalY };
        /*
         * The song under the fingers, as drawn at this distance.
         *
         * Zooming between the map and the shelf reshapes every cluster: the
         * bloom closes into a column, and the columns above push everything
         * below them down the world. The world point under the fingers holds
         * still, but the cluster you are zooming into does not — it slid out
         * from under them, a long way. So the pinch holds a song instead.
         */
        const fitScale = layoutFitShared.value;
        const anchors = anchorsShared.value;
        let anchor: PinchStart['anchor'] = null;
        if (size !== null && fitScale > 0 && !centred) {
          const gather = gatherFraction(startCamera.scale, fitScale);
          const reach = knobs.PINCH_ANCHOR_REACH_PX;
          let best = reach * reach;
          for (let index = 0; index + 3 < anchors.length; index += 4) {
            const bloomX = anchors[index + 2];
            const bloomY = anchors[index + 3];
            const worldX = anchors[index] + bloomX * (1 - gather);
            const worldY = anchors[index + 1] + bloomY * (1 - gather);
            const dx =
              (worldX - startCamera.x) * startCamera.scale +
              size.width / 2 -
              focal.x;
            const dy =
              (worldY - startCamera.y) * startCamera.scale +
              size.height / 2 -
              focal.y;
            const distance = dx * dx + dy * dy;
            if (distance < best) {
              best = distance;
              anchor = { bloomX, bloomY, gather };
            }
          }
        }
        pinchStart.value = { focal, camera: startCamera, anchor };
      })
      .onUpdate(event => {
        'worklet';
        const fitScale = layoutFitShared.value;
        const size = viewport;
        const start = pinchStart.value;
        if (fitScale <= 0 || size === null || start === null) return;
        const clamped = Math.min(
          Math.max(
            start.camera.scale * event.scale,
            fitScale * minRatioShared.value,
          ),
          fitScale * knobs.MAX_SCALE_RATIO,
        );
        const zoomed = zoomAroundFocalPoint(
          start.camera,
          start.focal,
          clamped / start.camera.scale,
          size,
        );
        const anchor = start.anchor;
        if (anchor === null) {
          publish(zoomed);
          return;
        }
        // However far the held song has moved as its cluster reshapes, the
        // camera moves with it, so it stays under the fingers. Outside the
        // gather nothing reshapes, and this is the plain zoom.
        const moved = anchor.gather - gatherFraction(clamped, fitScale);
        publish({
          scale: zoomed.scale,
          x: zoomed.x + anchor.bloomX * moved,
          y: zoomed.y + anchor.bloomY * moved,
        });
      })
      .onEnd(() => {
        'worklet';
        pinching.value = false;
        pinchStart.value = null;
        // Zoomed out past the map, a pinch tends to leave it hanging from the
        // middle of the band with nothing above it. It settles back inside the
        // map's range, which at this distance centres a map that fits.
        const frame = mapFrameShared.value;
        const size = viewport;
        const current = cameraShared.value;
        if (
          !reducedMotion &&
          frame !== null &&
          size !== null &&
          current.scale < frame.fitScale
        ) {
          const range = mapCameraRange(frame, size, current.scale);
          const x = Math.min(Math.max(current.x, range.minX), range.maxX);
          const y = Math.min(Math.max(current.y, range.minY), range.maxY);
          if (x !== current.x || y !== current.y) {
            launchFlight(
              { scale: current.scale, x, y },
              knobs.SEAT_SETTLE_MS,
              FLIGHT_CURVE.SMOOTH,
            );
            return;
          }
        }
        settle();
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(knobs.PAN_SLOP_PX)
      .onBegin(event => {
        'worklet';
        catchGlide();
        runOnJS(cancelCameraFlight)();
        const startCamera = cameraShared.value;
        panStart.value = {
          x: event.x,
          y: event.y,
          camera: startCamera,
          pull: null,
          seat: isShelfDistance(startCamera.scale, layoutFitShared.value)
            ? nearestSeat(shelfSeatsShared.value, startCamera)
            : -1,
          pinched: false,
        };
      })
      .onUpdate(event => {
        'worklet';
        const size = viewport;
        const start = panStart.value;
        if (
          layoutFitShared.value <= 0 ||
          size === null ||
          start === null ||
          pinching.value
        )
          return;
        const horizontal = Math.abs(event.translationX);
        const vertical = event.translationY;
        /*
         * One blind at a time.
         *
         * A sheet leaves a strip of field showing, and that strip contains an
         * edge zone: with the composer down, a drag in the peek at the top is
         * still a top-edge pull, and it would write the composer's own
         * position back to the finger's twenty pixels — the sheet collapsing
         * to a sliver mid-use. A pull already under way is exempt, so a
         * gesture the finger owns is never interrupted by its own first frame.
         */
        const edgeReady = start.pull !== null || pullDestination.value === 0;
        /*
         * Which blind this drag belongs to, decided once and then kept.
         *
         * Kept, because the decision is the *drag's*, not the frame's. Asking
         * again every frame meant a drag that came back above where it started
         * stopped matching its own edge test, fell through to the pan below,
         * and left the blind frozen at whatever pixel it had reached — a sheet
         * hanging in mid-air under a finger still touching the screen, with no
         * way to put it back but to lift and let it settle. A hand that changes
         * its mind mid-pull is the ordinary case, so the pull follows it all
         * the way home to zero and waits there.
         */
        const pulling =
          start.pull !== null
            ? start.pull
            : edgeReady && horizontal < knobs.EDGE_PULL_HORIZONTAL_TOLERANCE_PX
            ? start.y < knobs.EDGE_PULL_ZONE_PX && vertical > 0
              ? 'compose'
              : start.y > size.height - knobs.EDGE_PULL_ZONE_PX && vertical < 0
              ? 'engines'
              : null
            : null;
        if (pulling !== null) {
          const pullSign = pulling === 'compose' ? 1 : -1;
          const seatPx = Math.max(0, size.height - CURTAIN_KNOBS.PEEK_PX);
          // Clamped to the blind's own travel at both ends: it cannot be
          // dragged off its roller, and it cannot be pushed past the seat.
          const drawn = Math.min(Math.max(vertical * pullSign, 0), seatPx);
          // Written once, at the frame the drag becomes a pull, rather than
          // every frame: `panStart` is a shared value and this runs at 120 Hz.
          if (start.pull === null) panStart.value = { ...start, pull: pulling };
          // The finger owns the value while it is down, so nothing is headed
          // anywhere: the destination is wherever it is let go.
          pullDestination.value = Number.NaN;
          pullShared.value = pullSign * drawn;
          return;
        }
        /*
         * A blind is down, and the field is not what the finger is on.
         *
         * The sheet covers the screen, but a plain view over a gesture
         * detector does not stop the detector seeing the touch, so a drag on
         * an open sheet was still panning the map underneath it. Nothing
         * visible moved; the field was simply somewhere else on the way back.
         */
        if (!edgeReady) return;
        // A song is a page, not a map. Once the camera is standing in one there
        // is nothing beside it to pan to — the whole field is one song wide at
        // this distance — so a drag that moved the camera only slid the player
        // off the screen and left the person holding an empty white frame.
        //
        // Read from the *live* camera rather than from the camera the drag
        // began on, so the lock takes effect the moment a pinch or a flight
        // crosses into the song and lifts the moment one leaves it.
        //
        // After the edge pulls, deliberately: the composer and the engines are
        // reachable from everywhere, and neither of them moves the camera.
        if (isSongDistance(cameraShared.value.scale, layoutFitShared.value))
          return;
        const moved = {
          scale: start.camera.scale,
          x: start.camera.x - event.translationX / start.camera.scale,
          y: start.camera.y - event.translationY / start.camera.scale,
        };
        // A shelf is somewhere you stand, not somewhere you pass through. At
        // L1 the camera is held in its column — damped sideways, clamped to
        // the column's run — so a pan cannot walk into the empty world between
        // clusters. It is resistance rather than a wall: the surface is still
        // continuous, and a deliberate drag still leaves for the neighbour.
        const liveSeats = shelfSeatsShared.value;
        if (
          start.seat >= 0 &&
          start.seat < liveSeats.length &&
          isShelfDistance(moved.scale, layoutFitShared.value)
        ) {
          publish(
            containToSeat(
              moved,
              liveSeats[start.seat],
              size,
              LAYOUT_KNOBS.SHELF_GAP_WORLD,
            ),
          );
          return;
        }
        publish(moved);
      })
      .onEnd(event => {
        'worklet';
        const start = panStart.value;
        panStart.value = null;
        if (start?.pull != null) {
          // The rest of the way, launched here rather than by the commit that
          // opens the sheet: it carries on from exactly where the finger left
          // it, at the speed it was thrown at, and React finds it already
          // going where it would have sent it.
          const pullSign = start.pull === 'compose' ? 1 : -1;
          const seat =
            viewport === null
              ? 0
              : Math.max(0, viewport.height - CURTAIN_KNOBS.PEEK_PX);
          const drawn = Math.min(
            Math.max(pullShared.value * pullSign, 0),
            seat,
          );
          // The throw in the blind's own direction: positive is still opening.
          const thrown = pullSign * event.velocityY;
          const target = releaseTarget(drawn, seat, thrown);
          pullDestination.value = pullSign * target;
          pullShared.value = withTiming(pullSign * target, {
            duration: unrollMs(drawn, target, thrown),
            easing: easeSmoother,
          });
          if (target > 0) {
            runOnJS(completePull)(start.pull);
            return;
          }
          // Rolled back up: the camera it was pulled over is still where the
          // finger found it, and has its own settle to finish.
          settle();
          return;
        }
        // A throw carries on — unless reduced motion is asked for, a pinch
        // was part of it, or a blind was down and the drag never moved the
        // field at all.
        const throwable =
          !reducedMotion &&
          start !== null &&
          !start.pinched &&
          pullDestination.value === 0;
        const liveSeats = shelfSeatsShared.value;
        if (
          start !== null &&
          start.seat >= 0 &&
          start.seat < liveSeats.length &&
          isShelfDistance(cameraShared.value.scale, layoutFitShared.value)
        ) {
          // Against what the finger asked for, not against where the damping
          // left the camera: a person who drags a full screen sideways has
          // asked to leave even though the camera only moved a third of it.
          const released = {
            scale: start.camera.scale,
            x: start.camera.x - event.translationX / start.camera.scale,
            y: start.camera.y - event.translationY / start.camera.scale,
          };
          const seatIndex = seatAfterRelease(
            liveSeats,
            released,
            start.seat,
            LAYOUT_KNOBS.SHELF_GAP_WORLD,
          );
          // Staying in the column, a throw runs on down it. Only from inside
          // its run: a camera released in the overscroll goes back to the
          // end it passed, and a glide too short to also bring the column
          // back under the middle of the view is a settle after all.
          const current = cameraShared.value;
          const size = viewport;
          if (throwable && seatIndex === start.seat && size !== null) {
            const seat = liveSeats[seatIndex];
            const run = seatCameraBounds(seat, size, current.scale);
            const glide =
              current.y >= run.min && current.y <= run.max
                ? planGlide(
                    current,
                    { x: 0, y: event.velocityY },
                    {
                      minX: seat.cx,
                      maxX: seat.cx,
                      minY: run.min,
                      maxY: run.max,
                    },
                  )
                : null;
            if (glide !== null && glide.durationMs >= knobs.SEAT_SETTLE_MS) {
              launchGlide({ ...glide.target, x: seat.cx }, glide.durationMs);
              return;
            }
          }
          // React first, so the flight starts from the camera the finger left
          // rather than from whichever frame the mirror last managed to take.
          settle();
          runOnJS(settleIntoSeat)(seatIndex);
          return;
        }
        // On the map a throw runs on in both axes, inside the map's range.
        const frame = mapFrameShared.value;
        const size = viewport;
        const current = cameraShared.value;
        const fitScale = layoutFitShared.value;
        if (
          throwable &&
          frame !== null &&
          size !== null &&
          fitScale > 0 &&
          current.scale / fitScale < LEVEL_BOUNDARIES.field
        ) {
          const glide = planGlide(
            current,
            { x: event.velocityX, y: event.velocityY },
            mapCameraRange(frame, size, current.scale),
          );
          if (glide !== null) {
            launchGlide(glide.target, glide.durationMs);
            return;
          }
        }
        settle();
      });
    const tap = Gesture.Tap()
      .maxDistance(knobs.TAP_SLOP_PX)
      .onBegin(() => {
        'worklet';
        catchGlide();
      })
      .onEnd((event, success) => {
        'worklet';
        if (success && !pinching.value && !caughtGlide.value) {
          runOnJS(tapAt)({ x: event.x, y: event.y });
        }
      })
      .onFinalize(() => {
        'worklet';
        caughtGlide.value = false;
      });
    // The hold fires the moment it is recognised rather than on release, so
    // the sheet is already arriving when the finger lifts. A hold that turned
    // into a pinch is not a hold.
    const hold = Gesture.LongPress()
      .minDuration(knobs.HOLD_MS)
      .maxDistance(knobs.HOLD_SLOP_PX)
      .onStart(event => {
        'worklet';
        if (pinching.value) return;
        runOnJS(holdAt)({ x: event.x, y: event.y });
      });
    // Exclusive, so a recognised hold cancels the tap that would otherwise
    // fire under it and descend a level the person did not ask for.
    return {
      field: Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(hold, tap)),
      rail,
    };
  }, [
    beginGlide,
    cameraShared,
    cancelCameraFlight,
    caughtGlide,
    flightAnchor,
    completePull,
    flightCurve,
    flightDuration,
    flightFrom,
    flightProgress,
    flightTo,
    anchorsShared,
    layoutFitShared,
    minRatioShared,
    mapFrameShared,
    mirrorNow,
    mirrorOnChange,
    railActive,
    railExtentShared,
    panStart,
    pinchStart,
    pinching,
    pullDestination,
    pullShared,
    holdAt,
    reducedMotion,
    flightLanded,
    settleIntoSeat,
    shelfSeatsShared,
    tapAt,
    viewport,
  ]);

  return {
    camera: renderedCamera,
    focus,
    playerFocus,
    groupKey,
    level,
    renderedPlacements,
    visualPlacements,
    layoutProgress,
    relayoutLinear,
    renderFitScale,
    labelFromGroups: activeRecut?.fromGroups ?? [],
    transitionGeneration: activeRecut?.generation ?? 0,
    recut: activeRecut,
    gesture: gestures.field,
    railGesture: gestures.rail,
    rail: railNow,
    cameraShared,
    focusKeyShared,
    fitScaleShared,
    pullShared,
    pullDestinationShared: pullDestination,
    descend,
    step,
    stepping,
    visit,
    ascend,
    home,
    cancelGesture,
  };
}

/**
 * Whether a captured placement is still worth carrying into the next re-cut.
 *
 * The capture is the *visual* field, so an exit that is halfway faded belongs
 * in it: interrupt a removal and the copy has to keep fading from where it is,
 * not snap back. But an exit that has reached zero is finished, and the
 * capture is also what the next re-cut plans its sources from — leaving it
 * there re-plans the same dead exit for every transition after, one more with
 * each song forgotten. Those flights name entities the controller no longer
 * presents, which is how forgetting an engine used to strand the field on the
 * picture renderer, with no wave morph and a visible seam at every level
 * change, until the app was restarted.
 */
function stillDrawn(placement: Placement): boolean {
  return placement.targetPlacementKey !== null || (placement.opacity ?? 1) > 0;
}

/** Ignore data refreshes that rebuild an identical layout object. */
function layoutsDiffer(left: FieldLayout, right: FieldLayout): boolean {
  if (left === right) return false;
  if (
    left.browseBounds?.minY !== right.browseBounds?.minY ||
    left.browseBounds?.maxY !== right.browseBounds?.maxY ||
    left.fitScale !== right.fitScale ||
    left.fieldCenter.x !== right.fieldCenter.x ||
    left.fieldCenter.y !== right.fieldCenter.y ||
    boxesDiffer(left.targetBounds, right.targetBounds) ||
    left.groups.length !== right.groups.length ||
    left.placements.length !== right.placements.length
  ) {
    return true;
  }
  for (let index = 0; index < left.groups.length; index += 1) {
    const before = left.groups[index];
    const after = right.groups[index];
    if (
      before.key !== after.key ||
      before.label !== after.label ||
      before.cx !== after.cx ||
      before.cy !== after.cy ||
      before.entityKeys.length !== after.entityKeys.length ||
      before.entityKeys.some(
        (key, entityIndex) => key !== after.entityKeys[entityIndex],
      )
    ) {
      return true;
    }
  }
  for (let index = 0; index < left.placements.length; index += 1) {
    const before = left.placements[index];
    const after = right.placements[index];
    if (
      before.key !== after.key ||
      before.entityKey !== after.entityKey ||
      before.groupKey !== after.groupKey ||
      before.x !== after.x ||
      before.y !== after.y ||
      before.fromX !== after.fromX ||
      before.fromY !== after.fromY ||
      before.targetX !== after.targetX ||
      before.targetY !== after.targetY ||
      before.bloomX !== after.bloomX ||
      before.bloomY !== after.bloomY ||
      before.fromBloomX !== after.fromBloomX ||
      before.fromBloomY !== after.fromBloomY ||
      before.targetBloomX !== after.targetBloomX ||
      before.targetBloomY !== after.targetBloomY ||
      before.opacity !== after.opacity ||
      before.targetPlacementKey !== after.targetPlacementKey
    ) {
      return true;
    }
  }
  return false;
}

function boxesDiffer(
  left: FieldLayout['targetBounds'],
  right: FieldLayout['targetBounds'],
): boolean {
  if (left === null || right === null) return left !== right;
  return (
    left.x !== right.x ||
    left.y !== right.y ||
    left.width !== right.width ||
    left.height !== right.height
  );
}

/** Whether the field is cut into different clusters than it was. */
function groupsChanged(
  before: readonly FieldLayout['groups'][number][],
  after: readonly FieldLayout['groups'][number][],
): boolean {
  if (before.length !== after.length) return true;
  return before.some(
    (group, index) =>
      group.key !== after[index].key || group.label !== after[index].label,
  );
}

/** Whether a planned flight changes geometry or visual ownership. */
function flightsMove(flights: readonly PlacementFlight[]): boolean {
  return flights.some(
    flight =>
      flight.fromX !== flight.targetX ||
      flight.fromY !== flight.targetY ||
      flight.fromBloomX !== flight.targetBloomX ||
      flight.fromBloomY !== flight.targetBloomY ||
      flight.fromAlpha !== flight.targetAlpha,
  );
}

function camerasDiffer(left: Camera, right: Camera): boolean {
  return left.x !== right.x || left.y !== right.y || left.scale !== right.scale;
}

/** The same camera, to within float noise. */
function sameCamera(a: Camera, b: Camera): boolean {
  const near = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  return near(a.x, b.x) && near(a.y, b.y) && near(a.scale, b.scale);
}

/** Whether any of a layout's marks would be on screen from `camera`. */
function anyPlacementInView(
  layout: FieldLayout,
  camera: Camera,
  viewport: Viewport,
): boolean {
  const gather = gatherFraction(camera.scale, layout.fitScale);
  return layout.placements.some(placement => {
    const point = worldToScreen(
      placementPoint(placement, gather),
      camera,
      viewport,
    );
    return (
      point.x >= 0 &&
      point.x <= viewport.width &&
      point.y >= 0 &&
      point.y <= viewport.height
    );
  });
}
