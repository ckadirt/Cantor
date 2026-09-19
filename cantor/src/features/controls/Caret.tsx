import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';

/** KNOBS — the chevron, and the half-turn it makes. */
export const CARET_KNOBS = {
  /**
   * The side of the square whose two sides are drawn. Rotated 45°, a 13 px
   * square reads as a chevron about 18 px across — the size of a word, not the
   * size of a button.
   */
  SIZE_PX: 13,
  /**
   * How long it takes to point the other way.
   *
   * `Reveal`'s own measure: the chevron and the block it opens are one
   * gesture, and a mark that has already finished turning while the thing it
   * named is still arriving reads as two controls rather than one.
   */
  TURN_MS: 240,
  /** 45° is the chevron; the half-turn on top of it is the direction. */
  UP_DEG: 45,
  DOWN_DEG: 225,
} as const;

/**
 * A hairline chevron, pointing where the panel it belongs to will go.
 *
 * Two sides of a square, rotated: the same hairline the tick under a dial and
 * the slats on an edge tab are drawn with, so a mark that says "this folds
 * away" is made of the same stroke as everything else in the chrome. It is the
 * app's answer to a word like `TAP TO FOLD` — a control you have already read
 * before you have finished reading it, and one line of text fewer on a sheet
 * whose subject is the one line you are writing.
 *
 * It turns rather than flipping. A chevron that swaps one angle for another is
 * two marks taking turns, which is the thing this app does not do to a word,
 * a tick or a face — and the turn is the only part of a peel that carries on
 * moving while the block underneath is still finding its height.
 */
export function Caret({
  colour,
  direction,
}: {
  colour: string;
  /** Where it points. `up` folds a block away; `down` opens one. */
  direction: 'up' | 'down';
}) {
  const reducedMotion = useReducedMotion();
  const angle = useSharedValue(
    direction === 'up' ? CARET_KNOBS.UP_DEG : CARET_KNOBS.DOWN_DEG,
  );
  useEffect(() => {
    const to = direction === 'up' ? CARET_KNOBS.UP_DEG : CARET_KNOBS.DOWN_DEG;
    angle.value = reducedMotion
      ? to
      : withTiming(to, {
          duration: CARET_KNOBS.TURN_MS,
          easing: easeSmoother,
        });
  }, [angle, direction, reducedMotion]);
  const turned = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));
  return (
    <Animated.View
      style={[styles.caret, { borderColor: colour }, turned]}
    />
  );
}

const styles = StyleSheet.create({
  caret: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: CARET_KNOBS.SIZE_PX,
    width: CARET_KNOBS.SIZE_PX,
  },
});
