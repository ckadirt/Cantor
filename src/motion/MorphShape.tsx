/**
 * True silhouette morphing for reusable shapes and canonical symbols.
 *
 * Every visible mark is reduced to one compound even-odd path: outer rings,
 * counters, dots, and disconnected components. Source and target rings are
 * resampled to identical verbs, so interpolatePaths moves the actual rendered
 * silhouette. There is no proxy drawing and no final artwork crossfade.
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
import {
  buildSilhouetteTransition,
  captureSilhouette,
  collapsedSilhouette,
  resolveSilhouette,
  type SilhouetteTransition,
} from './silhouette';
import type { Shape } from './shapes';

const DEFAULT_SCALE = 0.82;

type Built = {
  key: string;
  transition: SilhouetteTransition;
  /** Born with the new model, so a retarget never observes a stale clock. */
  clock: SharedValue<number>;
  animate: boolean;
  reducedCrossfade?: {
    from: SilhouetteTransition['from'];
    to: SilhouetteTransition['to'];
  };
};

function ShapeCanvas({
  built,
  progress,
  width,
  height,
  color,
}: {
  built: Built;
  progress?: SharedValue<number>;
  width: number;
  height: number;
  color: string;
}) {
  const t = progress ?? built.clock;
  const path = useDerivedValue(() =>
    interpolatePaths(
      smootherstep(0, 1, t.value),
      [0, 1],
      [built.transition.from, built.transition.to],
      undefined,
      built.transition.out,
    ),
  );
  const fromOpacity = useDerivedValue(() => 1 - smootherstep(0, 0.65, t.value));
  const toOpacity = useDerivedValue(() => smootherstep(0.35, 1, t.value));
  return (
    <Canvas style={{ width, height }}>
      {built.reducedCrossfade ? (
        <>
          <Path
            path={built.reducedCrossfade.from}
            style="fill"
            fillType="evenOdd"
            color={color}
            opacity={fromOpacity}
          />
          <Path
            path={built.reducedCrossfade.to}
            style="fill"
            fillType="evenOdd"
            color={color}
            opacity={toOpacity}
          />
        </>
      ) : (
        <Path path={path} style="fill" fillType="evenOdd" color={color} />
      )}
    </Canvas>
  );
}

export type ShapeAppearance = 'none' | 'write';

export type MorphShapeProps = {
  shape: Shape;
  width: number;
  height: number;
  color: string;
  duration?: number;
  /** Fraction of the available canvas axes occupied by the mark. */
  scale?: number;
  /** Optical width / height override; defaults to the authored ratio. */
  aspectRatio?: number;
  /**
   * Symbol weight in authoring units. For canonical filled glyphs this offsets
   * the real outline inward/outward; for line-authored shapes it is ribbon width.
   */
  strokeWidth?: number;
  /** Destination centre. Changes morph the same geometry into its new place. */
  centerX?: number;
  centerY?: number;
  /** First-mount growth from the real target silhouette's own contour centres. */
  appearance?: ShapeAppearance;
  /** External 0..1 clock; when present, the component never drives timing. */
  progress?: SharedValue<number>;
};

export const MorphShape = React.memo(MorphShapeImpl);

function MorphShapeImpl({
  shape,
  width,
  height,
  color,
  duration = 700,
  scale = DEFAULT_SCALE,
  aspectRatio,
  strokeWidth,
  centerX,
  centerY,
  appearance = 'none',
  progress,
}: MorphShapeProps) {
  const reduced = useReducedMotion();
  const [built, setBuilt] = useState<Built | null>(null);
  const key =
    `${shape.name}|${width}x${height}|${scale}|` +
    `${aspectRatio ?? 'auto'}|${strokeWidth ?? 'auto'}|${centerX ?? 'cx'}|${
      centerY ?? 'cy'
    }`;

  if (width > 0 && height > 0 && built?.key !== key) {
    const target = resolveSilhouette(shape, width, height, scale, {
      aspectRatio,
      strokeWidth,
      centerX,
      centerY,
    });
    const retarget = !!built;
    const writing = !retarget && appearance === 'write';
    const captureT = progress ? progress.value : built?.clock.value ?? 1;
    const source = built
      ? captureSilhouette(built.transition, smootherstep(0, 1, captureT))
      : writing
      ? collapsedSilhouette(target)
      : target;
    const transition = buildSilhouetteTransition(source, target);
    const animate = retarget || (!reduced && writing);

    setBuilt({
      key,
      transition,
      clock: bornClock(animate && !progress ? 0 : 1),
      animate,
      reducedCrossfade:
        reduced && retarget
          ? { from: transition.from, to: transition.to }
          : undefined,
    });
  }

  useEffect(() => {
    if (!built?.animate || progress) {
      return;
    }
    const clock = built.clock;
    clock.value = withTiming(1, { duration, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [built, duration, progress]);

  if (!built) {
    return null;
  }
  return (
    <ShapeCanvas
      built={built}
      progress={progress}
      width={width}
      height={height}
      color={color}
    />
  );
}
