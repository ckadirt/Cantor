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
import {
  GRAIN_KNOBS,
  LAYOUT_KNOBS,
  containToSeat,
  hitTestPlacement,
  hitTestRowAction,
  interpolateCamera,
  interpolatePositiveScale,
  isMarksOnlyDistance,
  isShelfDistance,
  levelCameraTarget,
  levelOf,
  nearestSeat,
  placementFlightAt,
  planPlacementFlights,
  seatAfterRelease,
  seatCameraBounds,
  shelfSeats,
  smootherstep,
  zoomAroundFocalPoint,
  type Camera,
  type FieldLayout,
  type Group,
  type Level,
  type Placement,
  type PlacementFlight,
  type Point,
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
  EDGE_PULL_ZONE_PX: 110,
  EDGE_PULL_MAX_PX: 140,
  EDGE_PULL_OPEN_PX: 90,
  EDGE_PULL_HORIZONTAL_TOLERANCE_PX: 50,
  /** How long a pull released short of the threshold takes to roll back up. */
  EDGE_PULL_RETRACT_MS: 260,
  /** How long the camera takes to fall back into a seat it was pulled out of. */
  SEAT_SETTLE_MS: 340,
  MIN_SCALE_RATIO: 0.5,
  // L3 is reachable now. The ceiling is the scale that shows the closest look
  // the grain view offers, derived from the grain knobs so the two cannot drift
  // apart: zooming further would resolve nothing new.
  MAX_SCALE_RATIO:
    GRAIN_KNOBS.ENTRY_RATIO *
    (GRAIN_KNOBS.ENTRY_SECONDS / GRAIN_KNOBS.MIN_SECONDS),
} as const;

type PullDirection = 'compose' | 'engines';

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
  /** The active canvas can play an L0 re-cut without React frame commits. */
  nativeRelayout?: boolean;
};

type CameraState = {
  camera: Camera;
  focus: Placement | null;
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
  cameraShared: SharedValue<Camera>;
  focusKeyShared: SharedValue<string | null>;
  fitScaleShared: SharedValue<number>;
  /** How far an edge pull has come, in screen pixels; see the shared value. */
  pullShared: SharedValue<number>;
  descend: (placement: Placement) => void;
  ascend: () => boolean;
  home: () => void;
  cancelGesture: () => void;
};

type PanStart = {
  x: number;
  y: number;
  camera: Camera;
  pull: PullDirection | null;
  pullAmount: number;
  /**
   * The seat the finger went down in, or -1 when it went down anywhere else.
   *
   * Held for the length of the gesture rather than looked up again on release:
   * the damped camera can drift nearer a neighbour than to the seat it is
   * being held in, and re-deciding at the end would let a pull the person
   * abandoned still count as leaving.
   */
  seat: number;
};

type PinchStart = {
  focal: Point;
  camera: Camera;
};

const EMPTY_CAMERA: Camera = { x: 0, y: 0, scale: 0.9 };

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
  nativeDriven: boolean;
}>;

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
  nativeRelayout = false,
}: Options): CameraState {
  const reducedMotion = useReducedMotion();
  const [camera, setCameraState] = useState<Camera>(EMPTY_CAMERA);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [recutClock, setRecutClock] = useState<RecutClock>({
    generation: 0,
    linear: 1,
  });
  const cameraRef = useRef(camera);
  const layoutRef = useRef(layout);
  const focusKeyRef = useRef(focusKey);
  const relayoutFrame = useRef<number | null>(null);
  const recutModel = useRef<FieldRecutModel | null>(null);
  const lastVisualPlacements = useRef<readonly Placement[]>([]);
  const lastRenderFitScale = useRef<number | null>(null);
  // Gesture state lives on the UI thread, because that is where the gesture
  // now runs. Each write replaces the whole record: mutating a field of an
  // object held by a shared value does not propagate.
  const panStart = useSharedValue<PanStart | null>(null);
  const pinchStart = useSharedValue<PinchStart | null>(null);
  const pinching = useSharedValue(false);
  /** Whether a native L0 re-cut is still writing the live capture refs. */
  const nativeFlight = useRef<number | null>(null);
  // Native shared values are stable. Keep that property in the Jest mock too,
  // which deliberately returns a fresh object for every render.
  const cameraSharedCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const focusKeySharedCandidate = useSharedValue<string | null>(null);
  const fitScaleSharedCandidate = useSharedValue(EMPTY_CAMERA.scale);
  const layoutFitSharedCandidate = useSharedValue(0);
  const mirrorBusyCandidate = useSharedValue(false);
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
  const flightFromCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const flightToCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const flightProgressCandidate = useSharedValue(1);
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
  const cameraShared = useRef(cameraSharedCandidate).current;
  const focusKeyShared = useRef(focusKeySharedCandidate).current;
  const fitScaleShared = useRef(fitScaleSharedCandidate).current;
  /** The live layout's terminal FIT, which is what the pinch clamps against. */
  const layoutFitShared = useRef(layoutFitSharedCandidate).current;
  const mirrorBusy = useRef(mirrorBusyCandidate).current;
  const pullShared = useRef(pullSharedCandidate).current;
  const shelfSeatsShared = useRef(shelfSeatsSharedCandidate).current;
  const flightFrom = useRef(flightFromCandidate).current;
  const flightTo = useRef(flightToCandidate).current;
  const flightProgress = useRef(flightProgressCandidate).current;

  layoutRef.current = layout;
  const seats = useMemo(
    () => (layout === null ? [] : shelfSeats(layout)),
    [layout],
  );
  useEffect(() => {
    shelfSeatsShared.value = seats;
  }, [seats, shelfSeatsShared]);

  const commitCamera = useCallback(
    (next: Camera) => {
      cameraRef.current = next;
      cameraShared.value = next;
      setCameraState(next);
    },
    [cameraShared],
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
      setCameraState(next);
    },
    [mirrorBusy],
  );
  useEffect(() => {
    mirrorBusy.value = false;
  }, [camera, mirrorBusy]);
  useEffect(() => {
    layoutFitShared.value = layout?.fitScale ?? 0;
  }, [layout, layoutFitShared]);
  const commitFocus = useCallback(
    (next: string | null) => {
      focusKeyRef.current = next;
      focusKeyShared.value = next;
      setFocusKey(next);
    },
    [focusKeyShared],
  );
  const cancelCameraFlight = useCallback(() => {
    cancelAnimation(flightProgress);
  }, [flightProgress]);
  const cancelRelayout = useCallback(() => {
    if (relayoutFrame.current !== null) {
      cancelAnimationFrame(relayoutFrame.current);
      relayoutFrame.current = null;
    }
  }, []);
  const cancelGesture = useCallback(() => {
    cancelCameraFlight();
    pinching.value = false;
    pinchStart.value = null;
    panStart.value = null;
  }, [cancelCameraFlight, panStart, pinchStart, pinching]);

  const clampScale = useCallback(
    (scale: number, field: FieldLayout): number => {
      return Math.min(
        Math.max(scale, field.fitScale * FIELD_CAMERA_KNOBS.MIN_SCALE_RATIO),
        field.fitScale * FIELD_CAMERA_KNOBS.MAX_SCALE_RATIO,
      );
    },
    [],
  );

  const flyTo = useCallback(
    (
      target: Camera,
      durationMs: number = FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS,
    ) => {
      cancelCameraFlight();
      if (reducedMotion) {
        commitCamera(target);
        return;
      }
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
        finished => {
          'worklet';
          // Arrival does not depend on the reaction below having run. The
          // reaction is what makes the flight *smooth*; this is what makes it
          // *land*, so a flight can never leave the camera short of the target
          // it was given.
          if (finished !== true) return;
          const landed = flightTo.value;
          cameraShared.value = landed;
          mirrorBusy.value = true;
          runOnJS(mirrorCamera)(landed);
        },
      );
    },
    [
      cameraShared,
      cancelCameraFlight,
      commitCamera,
      flightFrom,
      flightProgress,
      flightTo,
      mirrorBusy,
      mirrorCamera,
      reducedMotion,
    ],
  );

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
   * logarithmic on scale, so a zoom reads as even.
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
        mirrorBusy.value = true;
        runOnJS(mirrorCamera)(landed);
        return;
      }
      const from = flightFrom.value;
      const to = flightTo.value;
      if (!(from.scale > 0) || !(to.scale > 0)) return;
      const t = progress;
      const eased = t * t * t * (t * (t * 6 - 15) + 10);
      const next = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        scale: Math.exp(
          Math.log(from.scale) +
            (Math.log(to.scale) - Math.log(from.scale)) * eased,
        ),
      };
      cameraShared.value = next;
      if (mirrorBusy.value) return;
      mirrorBusy.value = true;
      runOnJS(mirrorCamera)(next);
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
    const fromFitScale =
      lastRenderFitScale.current ?? previous?.toFitScale ?? layout.fitScale;
    const fromCamera = firstLayout
      ? levelCameraTarget('field', layout) ?? EMPTY_CAMERA
      : cameraRef.current;
    const toCamera = firstLayout
      ? fromCamera
      : {
          ...fromCamera,
          scale: clampScale(
            (fromCamera.scale / fromFitScale) * layout.fitScale,
            layout,
          ),
        };
    const sources = firstLayout
      ? layout.placements
      : lastVisualPlacements.current;
    const flights = planPlacementFlights(
      sources,
      layout.placements,
      generation,
    );
    const fromGroups = previous?.layout.groups ?? [];
    const animate =
      !firstLayout &&
      !reducedMotion &&
      (flightsMove(flights) ||
        groupsChanged(fromGroups, layout.groups) ||
        camerasDiffer(fromCamera, toCamera) ||
        fromFitScale !== layout.fitScale);
    // The same predicate the canvas chooses its renderer with, and it has to
    // be: a re-cut marked native stops publishing to React, so if the canvas
    // disagreed and drew the picture, it would record from state that is no
    // longer moving.
    const nativeDriven =
      nativeRelayout &&
      isMarksOnlyDistance(fromCamera.scale, fromFitScale) &&
      isMarksOnlyDistance(toCamera.scale, layout.fitScale);
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
      nativeDriven,
    };
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
    activeRecut.nativeDriven &&
    activeRecut.animate &&
    (recutBorn || nativeFlight.current === activeRecut.generation);
  if (!nativeFlightLive) {
    lastVisualPlacements.current = visualPlacements;
    lastRenderFitScale.current = renderFitScale;
  }

  useEffect(() => {
    const model = recutModel.current;
    if (model === null) return;
    const generation = model.generation;
    cancelRelayout();
    if (!model.animate) {
      nativeFlight.current = null;
      commitCamera(model.toCamera);
      fitScaleShared.value = model.toFitScale;
      setRecutClock({ generation, linear: 1 });
      return;
    }
    const startedAt = Date.now();
    fitScaleShared.value = model.fromFitScale;
    if (model.nativeDriven) nativeFlight.current = generation;
    setRecutClock({ generation, linear: 0 });
    const tick = () => {
      if (recutModel.current?.generation !== generation) return;
      const progress = Math.min(
        1,
        (Date.now() - startedAt) / FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      );
      const eased = smootherstep(progress);
      const nextFitScale = interpolatePositiveScale(
        model.fromFitScale,
        model.toFitScale,
        eased,
      );
      const nextCamera = interpolateCamera(
        model.fromCamera,
        model.toCamera,
        progress,
      );
      fitScaleShared.value = nextFitScale;
      if (model.nativeDriven) {
        lastVisualPlacements.current = model.flights.map(flight =>
          placementFlightAt(flight, eased),
        );
        lastRenderFitScale.current = nextFitScale;
        cameraRef.current = nextCamera;
        cameraShared.value = nextCamera;
      } else {
        setRecutClock({ generation, linear: progress });
        commitCamera(nextCamera);
      }
      if (progress < 1) {
        relayoutFrame.current = requestAnimationFrame(tick);
      } else {
        relayoutFrame.current = null;
        if (model.nativeDriven) {
          nativeFlight.current = null;
          setRecutClock({ generation, linear: 1 });
          commitCamera(model.toCamera);
        }
      }
    };
    relayoutFrame.current = requestAnimationFrame(tick);
  }, [
    activeRecut?.generation,
    cameraShared,
    cancelRelayout,
    commitCamera,
    fitScaleShared,
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
  const focusRef = useRef<Placement | null>(null);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
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
    if (level !== 'shelf') return focus?.groupKey ?? null;
    const index = nearestSeat(seats, renderedCamera);
    return index < 0 ? null : seats[index].key;
  }, [focus, level, renderedCamera, seats]);

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
      commitFocus(placement.key);
      const current = levelOf(
        cameraRef.current.scale,
        lastRenderFitScale.current ?? field.fitScale,
      );
      // L3 stays clamped until M7, so a song is the end of the descent.
      const next =
        current === 'field'
          ? 'shelf'
          : current === 'shelf'
          ? 'song'
          : current === 'song'
          ? 'grain'
          : null;
      if (next === null) return;
      const target = levelCameraTarget(next, field, placement);
      if (target) flyTo(target);
    },
    [commitFocus, flyTo],
  );
  const ascend = useCallback((): boolean => {
    const field = layoutRef.current;
    if (field === null) return false;
    const current = levelOf(
      cameraRef.current.scale,
      lastRenderFitScale.current ?? field.fitScale,
    );
    if (current === 'field') return false;

    // Leaving a song returns to its shelf, which needs the placement we came
    // in through; without one there is no group to return to, so go home.
    if (current !== 'shelf') {
      const placement = focusRef.current;
      const shelf = placement
        ? levelCameraTarget('shelf', field, placement)
        : null;
      if (shelf) {
        flyTo(shelf);
        return true;
      }
    }
    commitFocus(null);
    const target = levelCameraTarget('field', field);
    if (target) flyTo(target);
    return true;
  }, [commitFocus, flyTo]);
  const home = useCallback(() => {
    const field = layoutRef.current;
    if (field === null) return;
    commitFocus(null);
    const target = levelCameraTarget('field', field);
    if (target) flyTo(target);
  }, [commitFocus, flyTo]);
  /** What a tap or a hold landed on, at whatever distance the camera is. */
  const placementAt = useCallback(
    (point: Point): Placement | null => {
      const field = layoutRef.current;
      const size = viewport;
      if (field === null || size === null) return null;
      const hitFitScale = lastRenderFitScale.current ?? field.fitScale;
      return hitTestPlacement(
        renderedPlacements,
        cameraRef.current,
        size,
        point,
        levelOf(cameraRef.current.scale, hitFitScale),
        hitFitScale,
      );
    },
    [renderedPlacements, viewport],
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
      const hitFitScale = lastRenderFitScale.current ?? field.fitScale;
      const hitLevel = levelOf(cameraRef.current.scale, hitFitScale);
      // The action column is answered before the row it sits in, so `GET` on a
      // song you are not opening does not also open it.
      const actionRow = hitTestRowAction(
        renderedPlacements,
        cameraRef.current,
        size,
        point,
        hitLevel,
        hitFitScale,
      );
      if (actionRow !== null && onRowAction?.(actionRow) === true) return;
      const hit = hitTestPlacement(
        renderedPlacements,
        cameraRef.current,
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
    [descend, onClaimTap, onRowAction, renderedPlacements, viewport],
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
      const current = cameraRef.current;
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
    [flyTo, seats, viewport],
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
   * camera it can keep up with, which is what the level chrome, hit testing
   * and the picture path at L1 and closer are drawn from.
   */
  const gesture = useMemo(() => {
    const knobs = FIELD_CAMERA_KNOBS;
    const publish = (next: Camera) => {
      'worklet';
      cameraShared.value = next;
      if (mirrorBusy.value) return;
      mirrorBusy.value = true;
      runOnJS(mirrorCamera)(next);
    };
    /** A gesture always ends with React holding the camera it ended on. */
    const settle = () => {
      'worklet';
      mirrorBusy.value = true;
      runOnJS(mirrorCamera)(cameraShared.value);
    };
    const pinch = Gesture.Pinch()
      .onStart(event => {
        'worklet';
        runOnJS(cancelCameraFlight)();
        pinching.value = true;
        pinchStart.value = {
          focal: { x: event.focalX, y: event.focalY },
          camera: cameraShared.value,
        };
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
            fitScale * knobs.MIN_SCALE_RATIO,
          ),
          fitScale * knobs.MAX_SCALE_RATIO,
        );
        publish(
          zoomAroundFocalPoint(
            start.camera,
            start.focal,
            clamped / start.camera.scale,
            size,
          ),
        );
      })
      .onEnd(() => {
        'worklet';
        pinching.value = false;
        pinchStart.value = null;
        settle();
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(knobs.PAN_SLOP_PX)
      .onBegin(event => {
        'worklet';
        runOnJS(cancelCameraFlight)();
        const startCamera = cameraShared.value;
        panStart.value = {
          x: event.x,
          y: event.y,
          camera: startCamera,
          pull: null,
          pullAmount: 0,
          seat: isShelfDistance(startCamera.scale, layoutFitShared.value)
            ? nearestSeat(shelfSeatsShared.value, startCamera)
            : -1,
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
        if (
          start.y < knobs.EDGE_PULL_ZONE_PX &&
          vertical > 0 &&
          horizontal < knobs.EDGE_PULL_HORIZONTAL_TOLERANCE_PX
        ) {
          panStart.value = {
            ...start,
            pull: 'compose',
            pullAmount: Math.min(vertical, knobs.EDGE_PULL_MAX_PX),
          };
          // The raw distance, not the clamped one: the decision saturates at
          // EDGE_PULL_MAX_PX but the blind keeps following the finger.
          pullShared.value = vertical;
          return;
        }
        if (
          start.y > size.height - knobs.EDGE_PULL_ZONE_PX &&
          vertical < 0 &&
          horizontal < knobs.EDGE_PULL_HORIZONTAL_TOLERANCE_PX
        ) {
          panStart.value = {
            ...start,
            pull: 'engines',
            pullAmount: Math.min(-vertical, knobs.EDGE_PULL_MAX_PX),
          };
          pullShared.value = vertical;
          return;
        }
        if (start.pull !== null) return;
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
        if (
          start?.pull != null &&
          start.pullAmount >= knobs.EDGE_PULL_OPEN_PX
        ) {
          // Hold where the finger left it. The screen opens the sheet, and the
          // opening animation carries on from exactly here rather than from a
          // position the finger never visited.
          runOnJS(completePull)(start.pull);
          return;
        }
        if (start?.pull != null) {
          // Released short: it rolls back up, like letting go of a blind.
          pullShared.value = withTiming(0, {
            duration: knobs.EDGE_PULL_RETRACT_MS,
            easing: easeSmoother,
          });
          settle();
          return;
        }
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
          // React first, so the flight starts from the camera the finger left
          // rather than from whichever frame the mirror last managed to take.
          settle();
          runOnJS(settleIntoSeat)(
            seatAfterRelease(
              liveSeats,
              released,
              start.seat,
              LAYOUT_KNOBS.SHELF_GAP_WORLD,
            ),
          );
          return;
        }
        settle();
      });
    const tap = Gesture.Tap()
      .maxDistance(knobs.TAP_SLOP_PX)
      .onEnd((event, success) => {
        'worklet';
        if (success && !pinching.value) {
          runOnJS(tapAt)({ x: event.x, y: event.y });
        }
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
    return Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(hold, tap));
  }, [
    cameraShared,
    cancelCameraFlight,
    completePull,
    layoutFitShared,
    mirrorBusy,
    mirrorCamera,
    panStart,
    pinchStart,
    pinching,
    pullShared,
    holdAt,
    settleIntoSeat,
    shelfSeatsShared,
    tapAt,
    viewport,
  ]);

  return {
    camera: renderedCamera,
    focus,
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
    gesture,
    cameraShared,
    focusKeyShared,
    fitScaleShared,
    pullShared,
    descend,
    ascend,
    home,
    cancelGesture,
  };
}

/** Ignore data refreshes that rebuild an identical layout object. */
function layoutsDiffer(left: FieldLayout, right: FieldLayout): boolean {
  if (left === right) return false;
  if (
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
