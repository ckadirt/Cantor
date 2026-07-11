/**
 * Shared furniture for the content panels. The frame (header, sigil, eyebrow,
 * title) lives in Onboarding and morphs between steps; here is only what a
 * panel body needs: the scroll/footer scaffold and the square controls. Same
 * austere language throughout — ink on paper, square corners, hairlines.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** A bordered, square button. `filled` inverts it (used for the final step). */
export function Button({
  label,
  onPress,
  filled,
  disabled,
}: {
  label: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
}) {
  const pal = usePalette();
  const edge = disabled ? pal.faint : pal.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderColor: edge },
        filled && !disabled && { backgroundColor: pal.ink },
      ]}>
      <Text
        style={[
          type.mono,
          { color: filled && !disabled ? pal.bg : edge },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A square checkbox with a mono tick. Ink fill when checked. */
export function Checkbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onToggle}
      style={styles.check}>
      <View
        style={[
          styles.box,
          { borderColor: checked ? pal.ink : pal.faint },
          checked && { backgroundColor: pal.ink },
        ]}>
        {checked && <Text style={[styles.tick, { color: pal.bg }]}>✓</Text>}
      </View>
      <Text style={[type.body, { color: pal.ink, flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The body scaffold every panel shares: scrolling content over a footer of
 * actions. `center` floats the content mid-zone (the threshold quote).
 */
export function PanelBody({
  children,
  footer,
  center,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  center?: boolean;
}) {
  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.content, center && styles.centered]}
        showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
      <View style={styles.footer}>{footer}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingBottom: space.lg,
  },
  centered: { justifyContent: 'center' },
  footer: {
    paddingBottom: space.xl,
    paddingTop: space.md,
    gap: space.sm,
  },
  button: {
    borderWidth: 1,
    minHeight: touch.min,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  check: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  box: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  tick: { fontFamily: type.mono.fontFamily, fontSize: 12, lineHeight: 14 },
});
