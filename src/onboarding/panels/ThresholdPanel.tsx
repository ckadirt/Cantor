/**
 * Panel 5 — the threshold. Hilbert's defence of Cantor's set theory, read here
 * as the benediction into the app: you've been given your keys, now cross over.
 * No eyebrow, no title — the frame's letters morph away and the quote writes
 * itself alone under the lemniscate (Manim's Write, from the motion engine).
 * One external clock: the write waits for the body's enter fade, and the
 * attribution appears only once the last glyph has settled.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useMorphFont, WriteText } from '../../motion';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

/* -------------------------------------------------------------- motion knobs */
/** Lets the body's enter fade finish before the first stroke. */
const QUOTE_DELAY_MS = 450;
/** Manim's long-text Write runtime. */
const QUOTE_WRITE_MS = 2000;
/** The attribution's soft reveal once the quote has settled. */
const ATTRIB_FADE_MS = 260;

const QUOTE =
  '“No one shall expel us from the paradise which Cantor has created for us.”';

const QUOTE_STYLE: TextStyle = {
  fontFamily: type.title.fontFamily,
  fontSize: 24,
  lineHeight: 34,
  textAlign: 'center',
  letterSpacing: 0.3,
};

function Body({ onDone }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  // The bundled face streams in asynchronously (over Metro in dev). Arming
  // the clock before WriteText can lay out would burn the delay — and part
  // of the write — against a canvas that doesn't exist yet.
  const font = useMorphFont(QUOTE_STYLE);
  const writeClock = useSharedValue(0);
  const attribA = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      writeClock.value = 1;
      attribA.value = 1;
      return;
    }
    if (!font) {
      return;
    }
    writeClock.value = 0;
    writeClock.value = withDelay(
      QUOTE_DELAY_MS,
      withTiming(1, { duration: QUOTE_WRITE_MS, easing: Easing.linear }),
    );
    attribA.value = 0;
    attribA.value = withDelay(
      QUOTE_DELAY_MS + QUOTE_WRITE_MS,
      withTiming(1, { duration: ATTRIB_FADE_MS, easing: Easing.out(Easing.cubic) }),
    );
    return () => {
      cancelAnimation(writeClock);
      cancelAnimation(attribA);
    };
  }, [attribA, font, reduced, writeClock]);

  const attribStyle = useAnimatedStyle(() => ({ opacity: attribA.value }));

  return (
    <PanelBody center footer={<Button label="Enter" onPress={onDone} filled />}>
      <View style={styles.block}>
        {/* The invisible copy sizes the zone for any width; the Skia layer
            writes the same glyphs (same font file, both loaders) over it. */}
        <View style={styles.quoteZone}>
          <Text
            style={[QUOTE_STYLE, styles.sizer]}
            accessible={false}
            importantForAccessibility="no-hide-descendants">
            {QUOTE}
          </Text>
          <WriteText
            text={QUOTE}
            charStyle={QUOTE_STYLE}
            color={pal.ink}
            progress={writeClock}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <Animated.Text
          style={[type.eyebrow, styles.attrib, { color: pal.faint }, attribStyle]}>
          DAVID HILBERT · 1926
        </Animated.Text>
      </View>
    </PanelBody>
  );
}

export const thresholdPanel: PanelDef = {
  key: 'threshold',
  eyebrow: '',
  title: '',
  sigil: SIGILS.threshold,
  Body,
};

const styles = StyleSheet.create({
  block: { alignItems: 'center', paddingHorizontal: space.sm },
  quoteZone: { alignSelf: 'stretch' },
  sizer: { opacity: 0 },
  attrib: { marginTop: space.lg, textAlign: 'center' },
});
