import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ARRANGEMENTS, type Level } from '../../field';
import { space, type, usePalette } from '../../theme/tokens';

type Props = {
  level: Level;
  offline: boolean;
  storageError: string | null;
  onOpenEngines: () => void;
  /** How the field is grouped, and the control that changes it. */
  arrangementKey: string;
  onChangeArrangement: (key: string) => void;
};

const HINTS: Record<Level, string> = {
  field: 'TAP A MARK TO OPEN A WEEK · PINCH TO ZOOM',
  shelf: 'TAP A ROW TO OPEN A SONG · BACK TO THE FIELD',
  song: 'DRAG THE LINE TO SCRUB · BACK TO THE SHELF',
  grain: 'PINCH TO SCRUB · BACK TO THE SONG',
};

/** Keep text clear of the 96px persistent origin control. */
const OVERLAY_KNOBS = { ORIGIN_CLEARANCE_PX: 120 } as const;

function FieldOverlayImpl({
  level,
  offline,
  storageError,
  onOpenEngines,
  arrangementKey,
  onChangeArrangement,
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
        {/*
          The arrangement is a property of the field, not of a song, so its
          control lives at every distance rather than inside L2.
        */}
        <View style={styles.arrangements} pointerEvents="box-none">
          {ARRANGEMENTS.map(arrangement => {
            const active = arrangement.key === arrangementKey;
            return (
              <Pressable
                accessibilityLabel={`Arrange by ${arrangement.label}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={arrangement.key}
                onPress={() => onChangeArrangement(arrangement.key)}
                style={styles.arrangement}>
                <Text
                  style={[
                    type.eyebrow,
                    { color: active ? pal.ink : pal.faint },
                  ]}>
                  {arrangement.label.toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
        </View>
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
  arrangements: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  arrangement: { paddingVertical: 6, paddingHorizontal: 2 },
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

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const FieldOverlay = React.memo(FieldOverlayImpl);
