import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space, touch, type } from '../theme/tokens';

/** Screen container: slate ground, edge-to-edge safe insets, page padding. */
export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md },
        style,
      ]}>
      {children}
    </View>
  );
}

/** Mono smallcaps label, e.g. "IDENTITY" or "SET · 003". */
export function Eyebrow({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

export function Title({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Body({ children, dim, style }: { children: React.ReactNode; dim?: boolean; style?: TextStyle }) {
  return <Text style={[styles.body, dim && { color: color.dust }, style]}>{children}</Text>;
}

export function Hairline({ style }: { style?: ViewStyle }) {
  return <View style={[styles.hairline, style]} />;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ label, onPress, kind = 'primary', disabled, style }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'ghost' && styles.buttonGhost,
        kind === 'danger' && styles.buttonDanger,
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
        style,
      ]}>
      <Text
        style={[
          styles.buttonLabel,
          kind === 'primary' && { color: color.bg },
          kind === 'ghost' && { color: color.chalk },
          kind === 'danger' && { color: color.danger },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.bg,
    paddingHorizontal: space.lg,
  },
  eyebrow: {
    ...type.eyebrow,
    color: color.brass,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },
  title: {
    ...type.title,
    color: color.chalk,
    marginBottom: space.sm,
  },
  body: {
    ...type.body,
    color: color.chalk,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.line,
    marginVertical: space.md,
  },
  button: {
    minHeight: touch.min,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonPrimary: {
    backgroundColor: color.brass,
  },
  buttonGhost: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  buttonDanger: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.danger,
  },
  buttonLabel: {
    ...type.body,
    fontWeight: '600',
  },
});
