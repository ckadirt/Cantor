import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  hitTestPlacement,
  interpolateCamera,
  levelCameraTarget,
  levelOf,
  smootherstep,
  zoomAroundFocalPoint,
  type Camera,
  type FieldLayout,
  type Level,
  type Placement,
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
  // Just under the song/grain boundary: L2 is reachable, L3 stays clamped
  // until M7 builds the grain view.
  MAX_SCALE_RATIO: 169.9,
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
  layoutProgress: number;
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
  const [layoutProgress, setLayoutProgress] = useState(1);
  const cameraRef = useRef(camera);
  const layoutRef = useRef(layout);
  const focusKeyRef = useRef(focusKey);
  const flightFrame = useRef<number | null>(null);
  const relayoutFrame = useRef<number | null>(null);
  const previousFitScale = useRef<number | null>(null);
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

  useEffect(() => {
    if (layout === null) return;
    fitScaleShared.value = layout.fitScale;
    const previousFit = previousFitScale.current;
    previousFitScale.current = layout.fitScale;
    if (previousFit === null) {
      const target = levelCameraTarget('field', layout);
      if (target) commitCamera(target);
      layoutProgressShared.value = 1;
      setLayoutProgress(1);
      return;
    }

    const scaleRatio = cameraRef.current.scale / previousFit;
    commitCamera({
      ...cameraRef.current,
      scale: clampScale(scaleRatio * layout.fitScale, layout),
    });
    cancelRelayout();
    if (reducedMotion) {
      layoutProgressShared.value = 1;
      setLayoutProgress(1);
      return;
    }
    const startedAt = Date.now();
    layoutProgressShared.value = 0;
    setLayoutProgress(0);
    const tick = () => {
      const progress = Math.min(
        1,
        (Date.now() - startedAt) / FIELD_CAMERA_KNOBS.RELAYOUT_MS,
      );
      const eased = smootherstep(progress);
      layoutProgressShared.value = eased;
      setLayoutProgress(eased);
      if (progress < 1) {
        relayoutFrame.current = requestAnimationFrame(tick);
      } else {
        relayoutFrame.current = null;
      }
    };
    relayoutFrame.current = requestAnimationFrame(tick);
  }, [
    cancelRelayout,
    clampScale,
    commitCamera,
    fitScaleShared,
    layout,
    layoutProgressShared,
    reducedMotion,
  ]);

  useEffect(
    () => () => {
      cancelCameraFlight();
      cancelRelayout();
    },
    [cancelCameraFlight, cancelRelayout],
  );

  const renderedPlacements = useMemo(
    () =>
      layout === null
        ? []
        : layout.placements.map(placement =>
            placementAtProgress(placement, layoutProgress),
          ),
    [layout, layoutProgress],
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
    layout === null ? 'field' : levelOf(camera.scale, layout.fitScale);

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
      const current = levelOf(cameraRef.current.scale, field.fitScale);
      // L3 stays clamped until M7, so a song is the end of the descent.
      const next = current === 'field' ? 'shelf' : current === 'shelf' ? 'song' : null;
      if (next === null) return;
      const target = levelCameraTarget(next, field, placement);
      if (target) flyTo(target);
    },
    [commitFocus, flyTo],
  );
  const ascend = useCallback((): boolean => {
    const field = layoutRef.current;
    if (field === null) return false;
    const current = levelOf(cameraRef.current.scale, field.fitScale);
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
      const hit = hitTestPlacement(
        renderedPlacements,
        cameraRef.current,
        size,
        point,
        levelOf(cameraRef.current.scale, field.fitScale),
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
    camera,
    focus,
    level,
    renderedPlacements,
    layoutProgress,
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

function placementAtProgress(
  placement: Placement,
  progress: number,
): Placement {
  return {
    ...placement,
    x: placement.fromX + (placement.targetX - placement.fromX) * progress,
    y: placement.fromY + (placement.targetY - placement.fromY) * progress,
  };
}
