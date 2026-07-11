import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { radius, space, type, usePalette } from '../theme/tokens';

const STEPS = [1, 2, 3, 4, 5];

type Props = {
  onDone: () => void;
};

/** Full-screen overlay rendered above MainScreen until the flow completes. */
export function Onboarding({ onDone }: Props) {
  const pal = usePalette();
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <Text style={[styles.progress, { color: pal.muted }]}>
        {step + 1} / {STEPS.length}
      </Text>
      <View style={styles.center}>
        <Animated.View key={step} entering={FadeIn.duration(220)}>
          <Text style={[styles.number, { color: pal.ink }]}>{STEPS[step]}</Text>
        </Animated.View>
      </View>
      <Pressable
        style={[
          styles.button,
          { borderColor: pal.ink },
          last && { backgroundColor: pal.ink },
        ]}
        onPress={() => (last ? onDone() : setStep(step + 1))}>
        <Text style={[styles.buttonLabel, { color: last ? pal.bg : pal.ink }]}>
          {last ? 'Done' : 'Next'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
  },
  progress: {
    ...type.eyebrow,
    marginTop: space.xl,
    textAlign: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  number: {
    fontFamily: type.wordmark.fontFamily,
    fontSize: 120,
  },
  button: {
    borderWidth: 1,
    borderRadius: radius.none,
    paddingVertical: space.md,
    alignItems: 'center',
    marginBottom: space.lg,
  },
  buttonLabel: {
    ...type.mono,
  },
});
