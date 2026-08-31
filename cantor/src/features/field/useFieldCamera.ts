import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GRAIN_KNOBS,
  hitTestPlacement,
  interpolateCamera,
  interpolatePositiveScale,
  levelCameraTarget,
  levelOf,
  placementFlightAt,
  planPlacementFlights,
  smootherstep,
  zoomAroundFocalPoint,
  type Camera,
  type FieldLayout,
  type Group,
  type Level,
  type Placement,
  type PlacementFlight,
  type Point,
  type Viewport,
} from '../../field';

/** KNOBS — durations in ms, positions in screen pixels, scales relative to FIT. */
export const FIELD_CAMERA_KNOBS = {
  CAMERA_FLIGHT_MS: 700,
  RELAYOUT_MS: 850,
  TAP_SLOP_PX: 8,
  PAN_SLOP_PX: 4,
  EDGE_PULL_ZONE_PX: 110,
  EDGE_PULL_MAX_PX: 140,
  EDGE_PULL_OPEN_PX: 90,
  EDGE_PULL_HORIZONTAL_TOLERANCE_PX: 50,
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
};

type CameraState = {
  camera: Camera;
  focus: Placement | null;
  level: Level;
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
  gesture: ReturnType<typeof Gesture.Simultaneous>;
  cameraShared: SharedValue<Camera>;
  focusKeyShared: SharedValue<string | null>;
  layoutProgressShared: SharedValue<number>;
  fitScaleShared: SharedValue<number>;
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
};

type PinchStart = {
  focal: Point;
  camera: Camera;
};

const EMPTY_CAMERA: Camera = { x: 0, y: 0, scale: 0.9 };

type RecutModel = Readonly<{
  generation: number;
  layout: FieldLayout;
  flights: readonly PlacementFlight[];
  fromFitScale: number;
  toFitScale: number;
  fromCamera: Camera;
  toCamera: Camera;
  fromGroups: readonly Group[];
  animate: boolean;
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
  const flightFrame = useRef<number | null>(null);
  const relayoutFrame = useRef<number | null>(null);
  const recutModel = useRef<RecutModel | null>(null);
  const lastVisualPlacements = useRef<readonly Placement[]>([]);
  const lastRenderFitScale = useRef<number | null>(null);
  const panStart = useRef<PanStart | null>(null);
  const pinchStart = useRef<PinchStart | null>(null);
  const pinching = useRef(false);
  // Native shared values are stable. Keep that property in the Jest mock too,
  // which deliberately returns a fresh object for every render.
  const cameraSharedCandidate = useSharedValue<Camera>(EMPTY_CAMERA);
  const focusKeySharedCandidate = useSharedValue<string | null>(null);
  const layoutProgressSharedCandidate = useSharedValue(1);
  const fitScaleSharedCandidate = useSharedValue(EMPTY_CAMERA.scale);
  const cameraShared = useRef(cameraSharedCandidate).current;
  const focusKeyShared = useRef(focusKeySharedCandidate).current;
  const layoutProgressShared = useRef(layoutProgressSharedCandidate).current;
  const fitScaleShared = useRef(fitScaleSharedCandidate).current;

  layoutRef.current = layout;

  const commitCamera = useCallback(
    (next: Camera) => {
      cameraRef.current = next;
      cameraShared.value = next;
      setCameraState(next);
    },
    [cameraShared],
  );
  const commitFocus = useCallback(
    (next: string | null) => {
      focusKeyRef.current = next;
      focusKeyShared.value = next;
      setFocusKey(next);
    },
    [focusKeyShared],
  );
  const cancelCameraFlight = useCallback(() => {
    if (flightFrame.current !== null) {
      cancelAnimationFrame(flightFrame.current);
      flightFrame.current = null;
    }
  }, []);
  const cancelRelayout = useCallback(() => {
    if (relayoutFrame.current !== null) {
      cancelAnimationFrame(relayoutFrame.current);
      relayoutFrame.current = null;
    }
  }, []);
  const cancelGesture = useCallback(() => {
    cancelCameraFlight();
    pinching.current = false;
    pinchStart.current = null;
    panStart.current = null;
  }, [cancelCameraFlight]);

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
    (target: Camera) => {
      cancelCameraFlight();
      const from = cameraRef.current;
      if (reducedMotion) {
        commitCamera(target);
        return;
      }
      const startedAt = Date.now();
      const tick = () => {
        const progress = Math.min(
          1,
          (Date.now() - startedAt) / FIELD_CAMERA_KNOBS.CAMERA_FLIGHT_MS,
        );
        commitCamera(interpolateCamera(from, target, progress));
        if (progress < 1) {
          flightFrame.current = requestAnimationFrame(tick);
        } else {
          flightFrame.current = null;
        }
      };
      flightFrame.current = requestAnimationFrame(tick);
    },
    [cancelCameraFlight, commitCamera, reducedMotion],
  );

  /*
   * Diff and capture during render, following the motion engine's trigger
   * ritual. The prop change itself creates a born generation at progress zero;
   * no commit can therefore expose the new target under the old 1.0 clock.
   */
  if (layout !== null && recutModel.current?.layout !== layout) {
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
  // A later prop change captures exactly what this render hands to the canvas.
  lastVisualPlacements.current = visualPlacements;
  lastRenderFitScale.current = renderFitScale;

  useEffect(() => {
    const model = recutModel.current;
    if (model === null) return;
    const generation = model.generation;
    cancelRelayout();
    if (!model.animate) {
      commitCamera(model.toCamera);
      fitScaleShared.value = model.toFitScale;
      layoutProgressShared.value = 1;
      setRecutClock({ generation, linear: 1 });
      return;
    }
    const startedAt = Date.now();
    fitScaleShared.value = model.fromFitScale;
    layoutProgressShared.value = 0;
    setRecutClock({ generation, linear: 0 });
    const tick = () => {
      if (recutModel.current?.generation !== generation) return;
      const progress = Math.min(
        1,
        (Date.now() - startedAt) / FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      );
      const eased = smootherstep(progress);
      layoutProgressShared.value = eased;
      fitScaleShared.value = interpolatePositiveScale(
        model.fromFitScale,
        model.toFitScale,
        eased,
      );
      setRecutClock({ generation, linear: progress });
      commitCamera(
        interpolateCamera(model.fromCamera, model.toCamera, progress),
      );
      if (progress < 1) {
        relayoutFrame.current = requestAnimationFrame(tick);
      } else {
        relayoutFrame.current = null;
      }
    };
    relayoutFrame.current = requestAnimationFrame(tick);
  }, [
    activeRecut?.generation,
    cancelRelayout,
    commitCamera,
    fitScaleShared,
    layoutProgressShared,
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
  const tapAt = useCallback(
    (point: Point) => {
      const field = layoutRef.current;
      const size = viewport;
      if (field === null || size === null) return;
      const hitFitScale = lastRenderFitScale.current ?? field.fitScale;
      const hit = hitTestPlacement(
        renderedPlacements,
        cameraRef.current,
        size,
        point,
        levelOf(cameraRef.current.scale, hitFitScale),
        hitFitScale,
      );
      if (hit) descend(hit);
    },
    [descend, renderedPlacements, viewport],
  );

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(event => {
        cancelCameraFlight();
        pinching.current = true;
        pinchStart.current = {
          focal: { x: event.focalX, y: event.focalY },
          camera: cameraRef.current,
        };
      })
      .onUpdate(event => {
        const field = layoutRef.current;
        const size = viewport;
        const start = pinchStart.current;
        if (field === null || size === null || start === null) return;
        const multiplier =
          clampScale(start.camera.scale * event.scale, field) /
          start.camera.scale;
        commitCamera(
          zoomAroundFocalPoint(start.camera, start.focal, multiplier, size),
        );
      })
      .onEnd(() => {
        pinching.current = false;
        pinchStart.current = null;
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .maxPointers(1)
      .minDistance(FIELD_CAMERA_KNOBS.PAN_SLOP_PX)
      .onBegin(event => {
        cancelCameraFlight();
        panStart.current = {
          x: event.x,
          y: event.y,
          camera: cameraRef.current,
          pull: null,
          pullAmount: 0,
        };
      })
      .onUpdate(event => {
        const field = layoutRef.current;
        const size = viewport;
        const start = panStart.current;
        if (
          field === null ||
          size === null ||
          start === null ||
          pinching.current
        )
          return;
        const horizontal = Math.abs(event.translationX);
        const vertical = event.translationY;
        if (
          start.y < FIELD_CAMERA_KNOBS.EDGE_PULL_ZONE_PX &&
          vertical > 0 &&
          horizontal < FIELD_CAMERA_KNOBS.EDGE_PULL_HORIZONTAL_TOLERANCE_PX
        ) {
          start.pull = 'compose';
          start.pullAmount = Math.min(
            vertical,
            FIELD_CAMERA_KNOBS.EDGE_PULL_MAX_PX,
          );
          return;
        }
        if (
          start.y > size.height - FIELD_CAMERA_KNOBS.EDGE_PULL_ZONE_PX &&
          vertical < 0 &&
          horizontal < FIELD_CAMERA_KNOBS.EDGE_PULL_HORIZONTAL_TOLERANCE_PX
        ) {
          start.pull = 'engines';
          start.pullAmount = Math.min(
            -vertical,
            FIELD_CAMERA_KNOBS.EDGE_PULL_MAX_PX,
          );
          return;
        }
        if (start.pull !== null) return;
        commitCamera({
          ...start.camera,
          x: start.camera.x - event.translationX / start.camera.scale,
          y: start.camera.y - event.translationY / start.camera.scale,
        });
      })
      .onEnd(() => {
        const start = panStart.current;
        panStart.current = null;
        if (
          start?.pull === 'compose' &&
          start.pullAmount >= FIELD_CAMERA_KNOBS.EDGE_PULL_OPEN_PX
        ) {
          cancelGesture();
          onOpenComposer();
        }
        if (
          start?.pull === 'engines' &&
          start.pullAmount >= FIELD_CAMERA_KNOBS.EDGE_PULL_OPEN_PX
        ) {
          cancelGesture();
          onOpenEngines();
        }
      });
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDistance(FIELD_CAMERA_KNOBS.TAP_SLOP_PX)
      .onEnd((event, success) => {
        if (success && !pinching.current) tapAt({ x: event.x, y: event.y });
      });
    return Gesture.Simultaneous(pinch, pan, tap);
  }, [
    cancelCameraFlight,
    cancelGesture,
    clampScale,
    commitCamera,
    onOpenComposer,
    onOpenEngines,
    tapAt,
    viewport,
  ]);

  return {
    camera: renderedCamera,
    focus,
    level,
    renderedPlacements,
    visualPlacements,
    layoutProgress,
    relayoutLinear,
    renderFitScale,
    labelFromGroups: activeRecut?.fromGroups ?? [],
    transitionGeneration: activeRecut?.generation ?? 0,
    gesture,
    cameraShared,
    focusKeyShared,
    layoutProgressShared,
    fitScaleShared,
    descend,
    ascend,
    home,
    cancelGesture,
  };
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
