import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Level } from '../../field';
import { space, type, usePalette } from '../../theme/tokens';

type Props = {
  level: Level;
  offline: boolean;
  storageError: string | null;
  onOpenEngines: () => void;
};

const HINTS: Record<Level, string> = {
  field: 'TAP A MARK TO OPEN A WEEK · PINCH TO ZOOM',
  shelf: 'TAP A ROW TO FOCUS · BACK TO THE FIELD',
  song: 'PLAYER ARRIVES IN M3',
  grain: 'GRAIN ARRIVES IN M7',
};

/** Keep text clear of the 96px persistent origin control. */
const OVERLAY_KNOBS = { ORIGIN_CLEARANCE_PX: 120 } as const;

export function FieldOverlay({
  level,
  offline,
  storageError,
  onOpenEngines,
}: Props) {
  const pal = usePalette();
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View style={styles.top} pointerEvents="box-none">
        <Pressable
          accessibilityLabel="Open engines"
          accessibilityRole="button"
          onPress={onOpenEngines}
          style={[
            styles.engineChip,
            { borderColor: pal.line, backgroundColor: pal.bg },
          ]}
        >
          <Text style={[type.eyebrow, { color: pal.ink }]}>ENGINES</Text>
          {offline ? (
            <Text style={[type.eyebrow, { color: pal.muted }]}>OFFLINE</Text>
          ) : null}
        </Pressable>
        <Text style={[type.eyebrow, styles.level, { color: pal.muted }]}>
          L{['field', 'shelf', 'song', 'grain'].indexOf(level)} ·{' '}
          {level.toUpperCase()}
        </Text>
      </View>
      <View style={styles.bottom} pointerEvents="none">
        {storageError ? (
          <Text
            accessibilityRole="alert"
            style={[type.small, { color: pal.ink }]}
          >
            {storageError}
          </Text>
        ) : null}
        <Text style={[type.eyebrow, styles.hint, { color: pal.faint }]}>
          {HINTS[level]}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  engineChip: {
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  level: { paddingRight: space.xs },
  bottom: {
    bottom: OVERLAY_KNOBS.ORIGIN_CLEARANCE_PX,
    left: space.md,
    position: 'absolute',
    right: space.md,
    gap: space.sm,
  },
  hint: { textAlign: 'center' },
});
