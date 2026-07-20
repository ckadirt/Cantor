import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type, usePalette } from '../theme/tokens';

export function MainScreen() {
  const pal = usePalette();
  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <Text style={[styles.placeholder, { color: pal.faint }]}>
        main — nothing here yet
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: {
    ...type.mono,
  },
});
