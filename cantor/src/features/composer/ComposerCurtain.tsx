import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { space, type, usePalette } from '../../theme/tokens';

/** KNOBS — the blind: how it hangs, how far it must come, how fast it settles. */
export const CURTAIN_KNOBS = {
  /**
   * How much field stays visible above the composer when it is fully down.
   *
   * The composer arrives *over* the field rather than replacing it, so you can
   * still see where the song will land.
   */
  PEEK_PX: 132,
  /** The last stretch after release, and the whole way back on a close. */
  SETTLE_MS: 320,
  /** How far up a drag on the open sheet must go before it lets go. */
  DISMISS_PX: 80,
  /** The hint under the leading edge fades out as the threshold is passed. */
  HINT_FADE_PX: 30,
} as const;

type Props = {
  /**
   * Screen pixels of pull, written by the field's edge gesture on the UI
   * thread. Positive is this sheet coming down.
   */
  pull: SharedValue<number>;
  /** Where the pull has to reach before releasing opens rather than cancels. */
  openAtPx: number;
  /** Whether the sheet has been let go of, past that threshold. */
  open: boolean;
  viewportHeight: number;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * The composer, unrolled downward over the field.
 *
 * A blind, not a modal, and unrolled rather than slid: the sheet has one seat,
 * just under the strip of field that stays visible, and what changes is how
 * much of it has come down. That is why the caption arrives first and the
 * `Make it` line last — the content enters in reading order, the way a blind
 * shows its top before its hem.
 *
 * How far it has come is the finger's own position, frame for frame, because
 * the pull is a shared value the UI thread reads directly. Releasing past the
 * threshold runs the rest of the way on the house curve; releasing short of it
 * rolls back up. Nothing here waits for a React commit to know where it is — a
 * commit only decides whether it ends up open or closed.
 */
function ComposerCurtainImpl({
  pull,
  openAtPx,
  open,
  viewportHeight,
  onClose,
  children,
}: Props) {
  const pal = usePalette();
  const height = Math.max(0, viewportHeight - CURTAIN_KNOBS.PEEK_PX);
  /**
   * Whether the blind is in the tree at all.
   *
   * A sheet drawn to zero height is still a view sitting over the field: it
   * swallowed every tap below its seat — the shelf's `DOWNLOAD ALL`, the order
   * dial, the whole header — while looking completely absent. Clipping is not
   * absence. This unmounts it instead, and the reaction costs one hop per
   * crossing rather than one per frame.
   */
  const [live, setLive] = useState(false);
  useAnimatedReaction(
    () => pull.value > 0.5,
    (drawn, previous) => {
      if (drawn !== previous) runOnJS(setLive)(drawn);
    },
    [],
  );

  // React owns only the destination. The finger owns everything before it, and
  // the animation starts from wherever the finger stopped.
  useEffect(() => {
    pull.value = withTiming(open ? height : 0, {
      duration: CURTAIN_KNOBS.SETTLE_MS,
      easing: easeSmoother,
    });
  }, [height, open, pull]);

  // Height, not transform: a blind that slid as a rigid body would enter hem
  // first, showing `Make it` before the caption. The inner sheet carries an
  // explicit height so the words inside never re-flow as the opening changes —
  // only how much of them is uncovered does.
  const surface = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value, 0), height);
    return {
      height: drawn,
      // Fully up is not merely invisible, it is absent: a sheet at zero must
      // not sit over the field it is not covering.
      opacity: drawn <= 0 ? 0 : 1,
    };
  }, [height]);

  // The hint rides just under the hem, so it is always at the edge the finger
  // is holding rather than at a fixed place on the screen.
  const hint = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value, 0), height);
    const over = drawn - openAtPx;
    return {
      transform: [{ translateY: drawn }],
      opacity:
        drawn <= 0
          ? 0
          : 1 - Math.min(Math.max(over / CURTAIN_KNOBS.HINT_FADE_PX, 0), 1),
    };
  }, [height, openAtPx]);

  // Drag the open sheet back up by its head: the same gesture in reverse, and
  // the reason the head is a band rather than a handle drawn on the screen.
  const dismiss = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .onUpdate(event => {
          'worklet';
          if (event.translationY >= 0) return;
          pull.value = height + event.translationY;
        })
        .onEnd(event => {
          'worklet';
          if (-event.translationY >= CURTAIN_KNOBS.DISMISS_PX) {
            runOnJS(onClose)();
            return;
          }
          pull.value = withTiming(height, {
            duration: CURTAIN_KNOBS.SETTLE_MS,
            easing: easeSmoother,
          });
        }),
    [height, onClose, open, pull],
  );

  if (!live && !open) return null;

  return (
    <>
      <Animated.View
        pointerEvents={open ? 'box-none' : 'none'}
        style={[styles.root, surface]}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: pal.bg, borderTopColor: pal.ink, height },
          ]}>
          <GestureDetector gesture={dismiss}>
            <View style={styles.head} />
          </GestureDetector>
          {children}
        </View>
      </Animated.View>
      {open ? null : (
        <Animated.Text
          pointerEvents="none"
          style={[type.eyebrow, styles.hint, { color: pal.faint }, hint]}>
          KEEP PULLING · RELEASE TO CANCEL
        </Animated.Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // One seat, under the strip of field that stays visible. `overflow: hidden`
  // is what makes the animated height a reveal rather than a squeeze.
  root: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: CURTAIN_KNOBS.PEEK_PX,
  },
  sheet: { borderTopWidth: 1, paddingHorizontal: space.lg },
  /** The head is the grip: a band across the top that answers to a drag. */
  head: { height: space.lg },
  hint: {
    left: space.lg,
    position: 'absolute',
    paddingTop: space.sm,
    top: CURTAIN_KNOBS.PEEK_PX,
  },
});

/** Memoised for the same reason the sheet is: the field re-renders per frame. */
export const ComposerCurtain = React.memo(ComposerCurtainImpl);
