import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';

/** KNOBS — how a revealed block arrives. */
export const REVEAL_KNOBS = {
  MS: 240,
  /** How far the row rises into its seat, in the engine's entrance spirit. */
  RISE_PX: 6,
} as const;

/**
 * A row or a block that rises into space already kept for it.
 *
 * The foot of the field is anchored to the bottom of the screen and stacks
 * upward, so a row that mounts at full height shoves the axis above it up in
 * one frame — which is the jump this replaces. The seat is therefore
 * permanent: the dial above sits at the same height on every axis, and only
 * the row's own ink arrives and leaves.
 *
 * `height` is for a row *inside* a stack, where the seat has to be reserved
 * even when the row is empty. A whole control that comes and goes with the
 * level passes no height and keeps its natural one: it is always mounted, so
 * the space is reserved by definition, and only its ink answers to `open`.
 * That is what a dial arriving looks like — the same rise the resolution row
 * has always used, rather than a control appearing out of nothing.
 *
 * It does not animate its height to get there. Reanimated drives the view
 * directly on the UI thread, so a layout prop that would reflow the parent
 * never reaches React Native's layout pass and snaps instead — measured on
 * device. Opacity and transform do not reflow anything, so they behave.
 *
 * The children stay mounted throughout: unmounting them when the fade ends
 * would be a completion callback mutating the tree.
 */
export function Reveal({
  children,
  duration = REVEAL_KNOBS.MS,
  height,
  open,
}: {
  children: React.ReactNode;
  /**
   * Left at the resolution row's own length for a row that answers to the
   * axis, and given the header's when the thing being revealed is part of the
   * header becoming another header — a control that settles before the words
   * around it is the same break as one that settles after them.
   */
  duration?: number;
  height?: number;
  open: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const amount = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const to = open ? 1 : 0;
    amount.value = reducedMotion
      ? to
      : withTiming(to, { duration, easing: easeSmoother });
  }, [amount, duration, open, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: amount.value,
    transform: [{ translateY: (1 - amount.value) * REVEAL_KNOBS.RISE_PX }],
  }));
  return (
    <Animated.View
      // `accessibilityElementsHidden` as well as the pointer guard: a control
      // that has faded out is gone as far as a finger is concerned, and it has
      // to be gone for a screen reader too or the dial for a level you are not
      // on is still in the reading order.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
      pointerEvents={open ? 'box-none' : 'none'}
      style={[styles.reveal, height === undefined ? null : { height }, style]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  reveal: { overflow: 'hidden' },
});
