import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { haptic } from '../../haptics';
import { FOLIO_ACT_STYLE, FOLIO_NOTE_STYLE } from './Folio';
import { touch, usePalette } from '../../theme/tokens';

/**
 * KNOBS — a destructive act, held rather than confirmed
 * (`docs/interfacealpha/folio.html#weight`).
 */
export const STRIKE_KNOBS = {
  /** How long the rule takes to cross the word: the hold that acts. */
  HOLD_MS: 900,
  /** How long it takes to go back when the finger lets go early. */
  LET_MS: 250,
  /** How far the rule overhangs the word at each end. */
  OVERHANG_PX: 4,
  /** Where the rule crosses the word, as a share of its line from the top. */
  THROUGH: 0.55,
} as const;

/**
 * A destructive act, struck through by holding it.
 *
 * Press and hold: a rule draws through the word over `HOLD_MS`, on a linear
 * clock, so the hand can see how far it has to go. Letting go early retracts
 * it and nothing happens. Completing it acts. The consequence is written under
 * the word before it is ever touched (`note`, starting `HOLD ·`), so there is
 * no page afterwards asking whether you are sure.
 *
 * The word is muted until it is held — it is an act, and ink is for the act
 * you are committing to — and faint once done, when it says what happened.
 *
 * A screen reader cannot hold, so a long-press action performs it at once;
 * the label says it is a held act.
 */
export function Strike({
  done,
  label,
  note,
  onStrike,
  disabled = false,
}: {
  /** What the word says once it has acted (`Deleted everywhere`). */
  done: string;
  label: string;
  /** The consequence, in the coda note's mono: `HOLD · 2.6 MB · NO UNDO`. */
  note: string;
  onStrike: () => void;
  disabled?: boolean;
}) {
  const pal = usePalette();
  const [width, setWidth] = useState(0);
  const [holding, setHolding] = useState(false);
  const [struck, setStruck] = useState(false);
  const drawn = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const strike = useCallback(() => {
    clear();
    setHolding(false);
    setStruck(true);
    haptic('confirm');
    onStrike();
  }, [clear, onStrike]);

  const onPressIn = useCallback(() => {
    if (disabled || struck) return;
    setHolding(true);
    cancelAnimation(drawn);
    // Read before the run starts: once it has, `value` may already answer
    // with where it is going rather than where it is.
    const left = STRIKE_KNOBS.HOLD_MS * (1 - drawn.value);
    drawn.value = withTiming(1, { duration: left, easing: Easing.linear });
    // The act is a timer, not the animation's completion: it acts, it does
    // not hand a glyph from one owner to another.
    clear();
    timer.current = setTimeout(strike, left);
  }, [clear, disabled, drawn, strike, struck]);

  const onPressOut = useCallback(() => {
    if (struck) return;
    clear();
    setHolding(false);
    drawn.value = withTiming(0, {
      duration: STRIKE_KNOBS.LET_MS,
      easing: easeSmoother,
    });
  }, [clear, drawn, struck]);

  const rule = useAnimatedStyle(() => ({
    width: (width + STRIKE_KNOBS.OVERHANG_PX * 2) * drawn.value,
  }));
  const ink = struck ? pal.faint : holding ? pal.ink : pal.muted;
  return (
    <View>
      <Pressable
        accessibilityActions={[{ name: 'longpress', label: label }]}
        accessibilityHint="Hold to do it. There is no second question."
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled: disabled || struck }}
        disabled={disabled || struck}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'longpress') strike();
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={styles.target}
      >
        <View style={styles.word}>
          <Text
            onLayout={(event: LayoutChangeEvent) =>
              setWidth(event.nativeEvent.layout.width)
            }
            style={[FOLIO_ACT_STYLE, { color: ink }]}
          >
            {struck ? done : label}
          </Text>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.rule,
              { backgroundColor: struck ? pal.faint : pal.ink },
              rule,
            ]}
          />
        </View>
      </Pressable>
      <Text
        style={[FOLIO_NOTE_STYLE, { color: pal.faint }, struck && styles.gone]}
      >
        {note}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  target: { justifyContent: 'center', minHeight: touch.min },
  word: { alignSelf: 'flex-start' },
  rule: {
    height: StyleSheet.hairlineWidth * 2,
    left: -STRIKE_KNOBS.OVERHANG_PX,
    position: 'absolute',
    top: FOLIO_ACT_STYLE.lineHeight * STRIKE_KNOBS.THROUGH,
  },
  gone: { opacity: 0 },
});
