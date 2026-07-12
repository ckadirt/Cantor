/**
 * The onboarding flow. Panel -1 is the animated Cantor intro; after it the
 * content panels share one persistent frame, and the intro's trick carries
 * through the whole flow: the sigil morphs shape-to-shape, the eyebrow and
 * title morph letter-by-letter (shared characters fly to their new homes),
 * and bodies exchange on the same clock. Nothing just cuts.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, FadeInDown, FadeOut } from 'react-native-reanimated';
import { IntroPanel } from './IntroPanel';
import { MorphShape, MorphText } from '../motion';
import { whatPanel } from './panels/WhatPanel';
import { backendsPanel } from './panels/BackendsPanel';
import { identityPanel } from './panels/IdentityPanel';
import { backupPanel } from './panels/BackupPanel';
import { thresholdPanel } from './panels/ThresholdPanel';
import type { PanelDef } from './panels/types';
import { space, type, usePalette } from '../theme/tokens';

// Flow order: orient → engines → identity → backup → threshold.
const PANELS: PanelDef[] = [
  whatPanel,
  backendsPanel,
  identityPanel,
  backupPanel,
  thresholdPanel,
];

// One clock for the whole step change; sigil and letters ride it directly,
// the body exchange is scheduled to sit inside it. Tune freely.
const TRANSITION_MS = 700;
const BODY_EXIT_MS = 260; // old body fades…
const BODY_ENTER_DELAY_MS = 260; // …then the new one
const BODY_ENTER_MS = 380;
const BODY_SHIFT = 14; // px the incoming body rises

// Fixed frame zones so nothing shifts while letters fly between panels.
const SIGIL_H = 168;
const EYEBROW_H = 20;
const TITLE_H = 78;

const bodyEnter = FadeInDown.duration(BODY_ENTER_MS)
  .delay(BODY_ENTER_DELAY_MS)
  .easing(Easing.out(Easing.cubic))
  .withInitialValues({ opacity: 0, transform: [{ translateY: BODY_SHIFT }] });
const bodyExit = FadeOut.duration(BODY_EXIT_MS);

type Props = {
  onDone: () => void;
};

/** Full-screen overlay rendered above MainScreen until the flow completes. */
export function Onboarding({ onDone }: Props) {
  const pal = usePalette();
  const { width } = useWindowDimensions();
  const [step, setStep] = useState(-1); // -1 = intro panel

  const go = (next: number) => {
    setStep(Math.max(-1, next));
  };

  if (step < 0) {
    return <IntroPanel onNext={() => go(0)} />;
  }

  const def = PANELS[step];
  const Body = def.Body;

  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={() => go(step - 1)} hitSlop={12} style={styles.back}>
          <Text style={[type.eyebrow, { color: pal.faint }]}>‹ BACK</Text>
        </Pressable>
        <Text style={[type.eyebrow, { color: pal.muted }]}>
          {step + 1} / {PANELS.length}
        </Text>
        <View style={styles.back} />
      </View>

      <View style={styles.sigilZone}>
        <MorphShape
          shape={def.sigil}
          duration={TRANSITION_MS}
          width={width - space.lg * 2}
          height={SIGIL_H}
          color={pal.ink}
        />
      </View>

      <MorphText
        text={def.eyebrow.toUpperCase()}
        charStyle={type.eyebrow}
        color={pal.muted}
        duration={TRANSITION_MS}
        style={styles.eyebrow}
      />
      <MorphText
        text={def.title}
        charStyle={type.title}
        color={pal.ink}
        duration={TRANSITION_MS}
        style={styles.title}
      />

      <Animated.View
        key={def.key}
        entering={bodyEnter}
        exiting={bodyExit}
        style={styles.body}>
        <Body onNext={() => go(step + 1)} onDone={onDone} />
      </Animated.View>
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
    paddingHorizontal: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  back: { minWidth: 56 },
  sigilZone: {
    height: SIGIL_H,
    marginTop: space.md,
    marginBottom: space.lg,
  },
  eyebrow: {
    height: EYEBROW_H,
    marginBottom: space.md,
  },
  title: {
    height: TITLE_H,
    marginBottom: space.md,
  },
  body: { flex: 1 },
});
