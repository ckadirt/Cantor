/**
 * A drawn mark that morphs to whatever `shape` it is given — the engine's
 * shape component. Change the prop and the geometry flows from wherever it is
 * right now (captureTransition), so BACK mid-morph or rapid retargets never
 * snap. All per-frame work is interpolatePaths + ramps on the UI thread; the
 * JS thread only builds slots once per target change.
 *
 * Pass `progress` to drive the clock yourself (MotionLab's scrubber); without
 * it the component owns a withTiming clock.
 */
import React, { useEffect, useState } from 'react';
import { Canvas, interpolatePaths, Path } from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { bornClock } from './clock';
import { smootherstep } from './geometry';
import { resolveShape, type Shape } from './shapes';
import {
  buildTransition,
  captureTransition,
  crossfadeTransition,
  settledTransition,
  type Slot,
  type Transition,
} from './transition';

/** Mark size as a fraction of the canvas's short side. */
const DEFAULT_SCALE = 0.82;

function SlotPath({
  s,
  t,
  color,
}: {
  s: Slot;
  t: SharedValue<number>;
  color: string;
}) {
  const path = useDerivedValue(() =>
    interpolatePaths(
      smootherstep(s.winA, s.winB, t.value),
      [0, 1],
      [s.from, s.to],
      undefined,
      s.out,
    ),
  );
  const alpha = useDerivedValue(
    () => s.fromA + (s.toA - s.fromA) * smootherstep(s.alphaA, s.alphaB, t.value),
  );
  const width = useDerivedValue(
    () => s.fromW + (s.toW - s.fromW) * smootherstep(s.winA, s.winB, t.value),
  );
  if (s.mode === 'fill') {
    return <Path path={path} style="fill" color={color} opacity={alpha} />;
  }
  return (
    <Path
      path={path}
      style="stroke"
      strokeWidth={width}
      strokeCap="round"
      strokeJoin="round"
      color={color}
      opacity={alpha}
    />
  );
}

type Built = {
  key: string;
  shapeName: string;
  transition: Transition;
  /** Born at 0 when animating, 1 when settled — never reset across builds. */
  clock: SharedValue<number>;
  animate: boolean;
};

type Props = {
  shape: Shape;
  width: number;
  height: number;
  color: string;
  duration?: number;
  /** Fraction of the short side the mark occupies. */
  scale?: number;
  /** External clock (0..1) — the component stops driving its own. */
  progress?: SharedValue<number>;
};

export function MorphShape({
  shape,
  width,
  height,
  color,
  duration = 700,
  scale = DEFAULT_SCALE,
  progress,
}: Props) {
  const reduced = useReducedMotion();
  const [built, setBuilt] = useState<Built | null>(null);

  const key = `${shape.name}|${width}x${height}|${scale}`;
  if (width > 0 && height > 0 && built?.key !== key) {
    const to = resolveShape(shape, width, height, scale);
    // Same canvas, new shape → animate from the live geometry. Anything else
    // (mount, resize) just sits at the target.
    const retarget = built && built.shapeName !== shape.name;
    const captureT = progress ? progress.value : built?.clock.value ?? 1;
    const transition = retarget
      ? (reduced ? crossfadeTransition : buildTransition)(
          captureTransition(built.transition, captureT),
          to,
        )
      : settledTransition(to);
    // Each build owns a clock born at its start value — the new tree can
    // never paint against a stale clock from the previous transition.
    setBuilt({
      key,
      shapeName: shape.name,
      transition,
      clock: bornClock(retarget && !progress ? 0 : 1),
      animate: !!retarget,
    });
  }

  useEffect(() => {
    if (!built?.animate || progress) {
      return;
    }
    const clock = built.clock;
    clock.value = withTiming(1, { duration, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [built, progress, duration]);

  if (!built) {
    return null;
  }
  const t = progress ?? built.clock;
  return (
    <Canvas style={{ width, height }}>
      {built.transition.slots.map((s, i) => (
        <SlotPath key={`${built.key}#${i}`} s={s} t={t} color={color} />
      ))}
    </Canvas>
  );
}
