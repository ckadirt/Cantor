import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LENSES } from '../../lenses';
import { space, touch, type, usePalette } from '../../theme/tokens';

type Props = {
  activeKey: string;
  onChange: (key: string) => void;
};

/**
 * One control, at L2, that changes how every song is drawn.
 *
 * There is deliberately not a picker per level: a lens is how the library is
 * being read, not a property of a distance, so changing it here re-skins the
 * marks at L0 and the rows at L1 as well. Its contents come from the registry,
 * so a new lens appears here without touching this file.
 */
function LensPickerImpl({ activeKey, onChange }: Props) {
  const pal = usePalette();
  return (
    <View style={styles.row}>
      {LENSES.map(lens => {
        const active = lens.key === activeKey;
        return (
          <Pressable
            accessibilityLabel={`Draw songs as ${lens.label}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={lens.key}
            onPress={() => onChange(lens.key)}
            hitSlop={space.sm}
            style={styles.chip}>
            {/*
              A word, not a box. At L2 the song is the picture and the chrome is
              a line of small capitals — the same vocabulary the dials use, and
              the reason this picker stopped being two bordered buttons sitting
              under the ring.
            */}
            <Text
              style={[type.eyebrow, { color: active ? pal.ink : pal.faint }]}
              numberOfLines={1}>
              {lens.label.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  chip: { justifyContent: 'center', minHeight: touch.min },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const LensPicker = React.memo(LensPickerImpl);
