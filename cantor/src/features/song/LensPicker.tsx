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
export function LensPicker({ activeKey, onChange }: Props) {
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
            style={[
              styles.chip,
              { borderColor: active ? pal.ink : pal.line },
              active ? styles.active : null,
            ]}>
            <Text
              style={[type.mono, { color: active ? pal.ink : pal.muted }]}
              numberOfLines={1}>
              {lens.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  active: { borderWidth: 2 },
});
