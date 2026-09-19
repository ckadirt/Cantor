import React from 'react';
import { Pressable, type PressableProps, StyleSheet } from 'react-native';
import { usePalette, touch } from '../../theme/tokens';

/** Shared feedback and full-sized touch targets for panel controls. */
export function PanelPressable({ style, ...props }: PressableProps) {
  const pal = usePalette();
  return (
    <Pressable
      {...props}
      android_ripple={{ color: pal.line }}
      style={state => [
        styles.target,
        typeof style === 'function' ? style(state) : style,
        state.pressed && styles.pressed,
      ]}
    />
  );
}
const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  target: { minHeight: touch.min, justifyContent: 'center' },
});
