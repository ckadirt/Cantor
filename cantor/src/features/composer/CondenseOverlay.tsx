import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { TransformText, easeSmoother } from '../../motion';
import { font, type as textType, usePalette } from '../../theme/tokens';

/** KNOBS — the condense gesture, in real units. */
const CONDENSE_KNOBS = {
  FLIGHT_MS: 620, // caption travelling to the mark it becomes
  HANDOFF_HOLD_MS: 120, // both representations visible, after the flight lands
  RELEASE_MS: 180, // the caption fading out over the already-drawn mark
  END_SCALE: 0.42, // how far the caption shrinks on the way in
  MARK_LABEL_CHARS: 12, // what the caption condenses down to
  SHEET_EXIT_MS: 320, // the composer's own slide-out, which the caption must outlive
} as const;

export type CondenseTarget = Readonly<{ x: number; y: number }>;

type Props = {
  caption: string;
  /** Screen box the caption leaves from — the composer's own field. */
  from: Readonly<{ x: number; y: number; width: number }>;
  /**
   * Where the mark is on screen, or null while it does not exist yet.
   *
   * Null is the normal opening state: the node has not accepted the job, so the
   * placement it will occupy is not known. The caption waits rather than flying
   * somewhere it guessed.
   */
  to: CondenseTarget | null;
  onSettled: () => void;
};

/**
 * The caption condensing into the mark it becomes.
 *
 * This is the one moment where the thing a person typed and the object in the
 * field are visibly the same object, so the hand-off cannot blink. The two
 * representations **overlap**: the flight only starts once the mark has a
 * placement, and the caption is not released until after the canvas has been
 * given that placement and held it for a beat. Nothing here waits on a React
 * completion callback to decide when the canvas owns the glyphs — a commit is
 * not proof of a paint (see the Flicker Law in `cantor/AGENTS.md`).
 */
export function CondenseOverlay({ caption, from, to, onSettled }: Props) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const flight = useSharedValue(0);
  const release = useSharedValue(0);
  const settled = useRef(false);

  // A stable style object: the text engine re-derives glyph geometry whenever
  // this identity changes.
  const charStyle = useMemo<TextStyle>(
    () => ({ ...textType.body, fontFamily: font.text }),
    [],
  );

  // The composer slides out from under the caption. Flying before it has gone
  // would run the whole gesture behind the sheet that is closing over it.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setArmed(true),
      CONDENSE_KNOBS.SHEET_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  const target = armed ? to : null;
  useEffect(() => {
    if (target === null) return;
    cancelAnimation(flight);
    flight.value = withTiming(1, {
      duration: reduced ? 0 : CONDENSE_KNOBS.FLIGHT_MS,
      easing: Easing.linear,
    });
    return () => cancelAnimation(flight);
  }, [flight, reduced, target]);

  // Release only after the flight has landed and the mark has been on the
  // canvas for a beat. The caption fades *over* a mark that is already drawn,
  // so there is never a frame owned by neither.
  useAnimatedReaction(
    () => flight.value,
    (value, previous) => {
      if (value < 1 || (previous ?? 0) >= 1) return;
      // The hold is the whole point: the mark is on the canvas, and the caption
      // stays on top of it for a beat before starting to go.
      release.value = withDelay(
        reduced ? 0 : CONDENSE_KNOBS.HANDOFF_HOLD_MS,
        withTiming(
          1,
          {
            duration: reduced ? 0 : CONDENSE_KNOBS.RELEASE_MS,
            easing: Easing.linear,
          },
          finished => {
            if (finished) runOnJS(finish)();
          },
        ),
      );
    },
    [reduced],
  );

  function finish() {
    if (settled.current) return;
    settled.current = true;
    onSettled();
  }

  // Safety net: if the node never accepts the job, the caption must not sit on
  // screen forever holding a gesture that will not complete.
  useEffect(() => {
    const timer = setTimeout(
      finish,
      CONDENSE_KNOBS.FLIGHT_MS +
        CONDENSE_KNOBS.HANDOFF_HOLD_MS +
        CONDENSE_KNOBS.RELEASE_MS +
        8000,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flying = useAnimatedStyle(() => {
    const eased = easeSmoother(flight.value);
    const destination = target ?? { x: from.x, y: from.y };
    return {
      opacity: 1 - release.value,
      transform: [
        {
          translateX: interpolate(eased, [0, 1], [from.x, destination.x]),
        },
        {
          translateY: interpolate(eased, [0, 1], [from.y, destination.y]),
        },
        {
          scale: interpolate(eased, [0, 1], [1, CONDENSE_KNOBS.END_SCALE]),
        },
      ],
    };
  }, [from, target]);

  // The words themselves condense: the full caption becomes the short form the
  // mark shows, rather than simply shrinking and vanishing.
  const shown =
    target === null
      ? caption
      : caption.slice(0, CONDENSE_KNOBS.MARK_LABEL_CHARS);

  return (
    <View pointerEvents="none" style={styles.root}>
      <Animated.View style={[styles.mover, { width: from.width }, flying]}>
        <TransformText
          charStyle={charStyle}
          color={pal.ink}
          duration={CONDENSE_KNOBS.FLIGHT_MS}
          text={shown}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  mover: { position: 'absolute', top: 0, left: 0 },
});
