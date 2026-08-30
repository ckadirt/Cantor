import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { type Camera, type FieldLayout, type Level } from '../../field';
import { layoutBars } from '../../onboarding/cantorBars';
import { usePalette } from '../../theme/tokens';

/** KNOBS — compact persistent home mark in screen pixels. */
const ORIGIN_KNOBS = {
  SIZE_PX: 72,
  HIT_SIZE_PX: 96,
  DEPTH: 3,
} as const;

type Props = {
  layout: FieldLayout;
  camera: Camera;
  level: Level;
  onPress: () => void;
};

/** The app mark doubles as the persistent escape hatch back to FIT. */
function OriginMarkImpl({ layout, camera, level, onPress }: Props) {
  const pal = usePalette();
  const bars = useMemo(
    () =>
      layoutBars(
        ORIGIN_KNOBS.SIZE_PX,
        ORIGIN_KNOBS.HIT_SIZE_PX / 2,
        ORIGIN_KNOBS.HIT_SIZE_PX / 2,
      ),
    [],
  );
  const selectedInterval = intervalForCamera(layout, camera, level);
  const divisions = 3 ** Math.min(ORIGIN_KNOBS.DEPTH, levelDepth(level));
  return (
    <Pressable
      accessibilityLabel="Return to the fitted field"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onPress}
      style={styles.root}
    >
      {bars.map((bar, index) => {
        const barInterval = Math.min(
          divisions - 1,
          Math.floor((bar.cx / ORIGIN_KNOBS.HIT_SIZE_PX) * divisions),
        );
        return (
          <View
            key={index}
            pointerEvents="none"
            style={[
              styles.bar,
              {
                backgroundColor:
                  level === 'field' || barInterval === selectedInterval
                    ? pal.ink
                    : pal.line,
                height: bar.rect.h,
                left: bar.rect.x,
                top: bar.rect.y,
                width: bar.rect.w,
              },
            ]}
          />
        );
      })}
    </Pressable>
  );
}

function intervalForCamera(
  layout: FieldLayout,
  camera: Camera,
  level: Level,
): number {
  const divisions = 3 ** Math.min(ORIGIN_KNOBS.DEPTH, levelDepth(level));
  const span = Math.max(1, layout.groups.length * 300);
  const unit = Math.min(
    0.9999,
    Math.max(0, (camera.x - layout.fieldCenter.x + span / 2) / span),
  );
  return Math.floor(unit * divisions);
}

function levelDepth(level: Level): number {
  return ['field', 'shelf', 'song', 'grain'].indexOf(level);
}

const styles = StyleSheet.create({
  root: {
    bottom: 16,
    height: ORIGIN_KNOBS.HIT_SIZE_PX,
    position: 'absolute',
    right: 8,
    width: ORIGIN_KNOBS.HIT_SIZE_PX,
  },
  bar: { position: 'absolute' },
});

/**
 * The camera reaches this mark only through which third of the field it is
 * inside — one integer that changes when you cross a boundary, not every frame.
 * Comparing that instead of the raw camera keeps a pan from re-laying out all
 * 29 bars, which is the difference between a smooth pan and a dropped frame.
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
    intervalForCamera(previous.layout, previous.camera, previous.level) ===
    intervalForCamera(next.layout, next.camera, next.level)
  );
});
