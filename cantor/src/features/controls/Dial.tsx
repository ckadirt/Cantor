import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { space } from '../../theme/tokens';

/** KNOBS — the tick, and how it travels. */
export const DIAL_KNOBS = {
  /**
   * The gap under the words the tick sits in.
   *
   * A tick, not a triangle or a pill: the edge tabs already say "this is the
   * one" with a short hairline, so the dial says it the same way and the
   * chrome keeps one vocabulary. It slides rather than jumping because the
   * dial is a dial — the selection moves along it.
   */
  TICK_GAP_PX: 5,
  MOVE_MS: 260,
} as const;

/** One position on a dial. */
export type DialItem = Readonly<{
  key: string;
  label: string;
  accessibilityLabel: string;
}>;

/**
 * A row of choices with a tick that slides to whichever is chosen.
 *
 * Colour alone already says which word is selected; the tick is what makes the
 * *change* visible. It travels to the new word's own width, so the mark reads
 * as one object moving along the dial rather than as several marks taking
 * turns being lit — which is the difference between a control and a row of
 * buttons.
 *
 * This is the app's only way of asking someone to pick one of a few things.
 * The field's axis, its order and its date resolution are dials; so are the
 * composer's engine, model and length. A second idiom — a row of bordered
 * boxes, which is what the composer had — is a second answer to one question,
 * and it reads as a form dropped into a drawing.
 *
 * Each word reports its own box through `onLayout`; nothing here measures text.
 */
export function Dial({
  activeColour,
  activeKey,
  items,
  itemStyle,
  onSelect,
  restColour,
  scroll = false,
  textStyle,
  tickColour,
}: {
  activeColour: string;
  activeKey: string;
  items: readonly DialItem[];
  /** For a dial in a sheet, where a row is a full-sized touch target. */
  itemStyle?: StyleProp<ViewStyle>;
  onSelect: (key: string) => void;
  restColour: string;
  /**
   * Whether the row may run off the end and be pushed along.
   *
   * For a dial whose length is the *node's* to decide — the lengths an engine
   * accepts, the choices a model declares — because the alternative is a row
   * that wraps, and a wrapped row puts the tick on the wrong line.
   */
  scroll?: boolean;
  textStyle: object;
  tickColour: string;
}) {
  const reducedMotion = useReducedMotion();
  const [boxes, setBoxes] = useState<
    Record<string, { x: number; width: number }>
  >({});
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  // The first box to arrive has nowhere to travel from, so it is placed.
  const placed = useRef(false);

  const measure = useCallback((key: string, event: LayoutChangeEvent) => {
    const { x, width: w } = event.nativeEvent.layout;
    setBoxes(previous => {
      const known = previous[key];
      if (known !== undefined && known.x === x && known.width === w) {
        return previous;
      }
      return { ...previous, [key]: { x, width: w } };
    });
  }, []);

  const target = boxes[activeKey];
  useEffect(() => {
    if (target === undefined) return;
    if (!placed.current || reducedMotion) {
      placed.current = true;
      left.value = target.x;
      width.value = target.width;
      return;
    }
    const timing = { duration: DIAL_KNOBS.MOVE_MS, easing: easeSmoother };
    left.value = withTiming(target.x, timing);
    width.value = withTiming(target.width, timing);
  }, [left, reducedMotion, target, width]);

  const tick = useAnimatedStyle(() => ({
    opacity: width.value > 0 ? 1 : 0,
    transform: [{ translateX: left.value }],
    width: width.value,
  }));

  // The tick is measured against the same box the words are laid out in, so it
  // lives inside the row's own parent — under a scroller it travels with them.
  const dial = (
    <View style={styles.dial} pointerEvents="box-none">
      <View style={styles.dialRow} pointerEvents="box-none">
        {items.map(item => (
          <Pressable
            accessibilityLabel={item.accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ selected: item.key === activeKey }}
            hitSlop={space.sm}
            key={item.key}
            onLayout={event => measure(item.key, event)}
            onPress={() => onSelect(item.key)}
            style={[styles.dialItem, itemStyle]}
          >
            <Text
              style={[
                textStyle,
                { color: item.key === activeKey ? activeColour : restColour },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Animated.View
        pointerEvents="none"
        style={[styles.tick, tick, { backgroundColor: tickColour }]}
      />
    </View>
  );

  if (!scroll) return dial;
  return (
    <ScrollView
      horizontal
      // The sheet it sits in scrolls too, and a tap on a word must reach the
      // word rather than being taken as the beginning of a scroll.
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {dial}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // The dial owns the space under its words so the tick has somewhere to sit.
  dial: { paddingBottom: DIAL_KNOBS.TICK_GAP_PX },
  dialRow: { flexDirection: 'row', gap: space.md },
  dialItem: { paddingVertical: space.xs },
  tick: {
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
  },
});
