import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { type Camera, type FieldLayout, type Level } from '../../field';
import { cantorSegments } from '../../onboarding/cantorBars';
import { space, touch, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the origin mark, which is also the breadcrumb.
 *
 * It is the Cantor set drawn once, as a row: the construction the app is named
 * after, at the size the house rule allows chrome to be. The 2-D logo lives in
 * `cantorBars.ts` and belongs to onboarding, where there is room for it; a
 * persistent 72 px slab of it in the corner of every screen was the loudest
 * thing on a screen whose subject is hairline faces.
 */
const ORIGIN_KNOBS = {
  WIDTH_PX: 52,
  BAR_HEIGHT_PX: 3,
  /** Three cuts leaves eight bars, which is two per level of descent. */
  DEPTH: 3,
} as const;

const SEGMENTS = cantorSegments(ORIGIN_KNOBS.DEPTH);

type Props = {
  layout: FieldLayout;
  camera: Camera;
  level: Level;
  onPress: () => void;
};

/**
 * Home, and where you are.
 *
 * The set is drawn whole at every level; what changes is how much of it is
 * solid. At L0 you are inside all of it. Each level down halves the run you
 * are inside — the same halving the set itself is built from — so the mark
 * says "one of two", "one of four", "one of eight" without a number, and
 * tapping it is still the way back to the fitted field.
 */
function OriginMarkImpl({ layout, camera, level, onPress }: Props) {
  const pal = usePalette();
  const bars = useMemo(
    () =>
      SEGMENTS.map(([x, width]) => ({
        left: x * ORIGIN_KNOBS.WIDTH_PX,
        width: width * ORIGIN_KNOBS.WIDTH_PX,
      })),
    [],
  );
  const runLength = SEGMENTS.length / runCount(level);
  const activeRun = runForCamera(layout, camera, level);
  return (
    <Pressable
      accessibilityLabel="Return to the fitted field"
      accessibilityRole="button"
      hitSlop={touch.min / 2}
      onPress={onPress}
      style={styles.root}
    >
      {bars.map((bar, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={[
            styles.bar,
            {
              backgroundColor:
                Math.floor(index / runLength) === activeRun
                  ? pal.ink
                  : pal.line,
              left: bar.left,
              width: bar.width,
            },
          ]}
        />
      ))}
    </Pressable>
  );
}

/** How many runs the set is divided into at this depth: one per level down. */
function runCount(level: Level): number {
  return 2 ** levelDepth(level);
}

/**
 * Which run the camera is inside, from where it sits across the field.
 *
 * One integer, and it only changes when a boundary is crossed — so panning
 * does not re-lay out the bars. That is what the memo comparator below tests.
 */
function runForCamera(
  layout: FieldLayout,
  camera: Camera,
  level: Level,
): number {
  const runs = runCount(level);
  const span = Math.max(1, layout.groups.length * 300);
  const unit = Math.min(
    0.9999,
    Math.max(0, (camera.x - layout.fieldCenter.x + span / 2) / span),
  );
  return Math.floor(unit * runs);
}

function levelDepth(level: Level): number {
  return ['field', 'shelf', 'song', 'grain'].indexOf(level);
}

const styles = StyleSheet.create({
  root: {
    bottom: space.lg,
    height: ORIGIN_KNOBS.BAR_HEIGHT_PX,
    position: 'absolute',
    right: space.lg,
    width: ORIGIN_KNOBS.WIDTH_PX,
  },
  bar: { height: ORIGIN_KNOBS.BAR_HEIGHT_PX, position: 'absolute', top: 0 },
});

/**
 * The camera reaches this mark only through which run of the set it is inside —
 * one integer that changes when you cross a boundary, not every frame.
 * Comparing that instead of the raw camera keeps a pan from re-laying out the
 * bars, which is the difference between a smooth pan and a dropped frame.
 */
export const OriginMark = React.memo(OriginMarkImpl, (previous, next) => {
  if (
    previous.layout !== next.layout ||
    previous.level !== next.level ||
    previous.onPress !== next.onPress
  ) {
    return false;
  }
  return (
    runForCamera(previous.layout, previous.camera, previous.level) ===
    runForCamera(next.layout, next.camera, next.level)
  );
});
