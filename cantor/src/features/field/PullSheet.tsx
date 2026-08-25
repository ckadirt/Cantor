import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { space, touch, type, usePalette } from '../../theme/tokens';

type Props = {
  visible: boolean;
  onClose: () => void;
};

/** Temporary top-pull acknowledgement; M4 replaces its body with ComposerSheet. */
export function PullSheet({ visible, onClose }: Props) {
  const pal = usePalette();
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.scrim}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: pal.bg, borderColor: pal.line },
          ]}
        >
          <Text style={[type.eyebrow, { color: pal.muted }]}>COMPOSE</Text>
          <Text style={[type.heading, { color: pal.ink }]}>
            Generation arrives in M4
          </Text>
          <Text style={[type.body, { color: pal.muted }]}>
            The pull is reserved now so it never competes with field navigation.
          </Text>
          <Pressable
            accessibilityLabel="Close composer notice"
            accessibilityRole="button"
            onPress={onClose}
            style={[styles.close, { borderColor: pal.ink }]}
          >
            <Text style={[type.mono, { color: pal.ink }]}>CLOSE</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: '#00000055',
    flex: 1,
    justifyContent: 'flex-start',
  },
  sheet: { borderWidth: 1, gap: space.md, padding: space.lg },
  close: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: touch.min,
  },
});
