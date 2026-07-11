/**
 * TransformMatchingShapes for text: when the string changes, characters shared
 * by the old and new line fly to their new homes; the rest fade out and in.
 * The steady state is a word-wrapped flow of per-character Texts, so every
 * character's position is always known and any change can animate from the
 * live layout. Same motion grammar as the rest of the app: one linear clock,
 * smoothstep windows, nothing bouncy.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { smoothstep } from './morph';

// Windows on the 0..1 transition clock: exits clear first, matched letters
// travel through the middle, entrances land last — one gesture, not three.
const EXIT_END = 0.4;
const MOVE_START = 0.1;
const MOVE_END = 0.9;
const ENTER_START = 0.6;

/** Gap between words, as a fraction of the font size. */
const WORD_GAP = 0.3;

type CharBox = { ch: string; x: number; y: number };
type Flight = { ch: string; from?: CharBox; to?: CharBox };

/**
 * Pair each new character with the unused old occurrence of the same character
 * whose relative position in the line is nearest — manim's matching, in 1-D.
 */
function matchFlights(prev: CharBox[], next: CharBox[]): Flight[] {
  const used = new Array<boolean>(prev.length).fill(false);
  const flights: Flight[] = [];
  const pn = Math.max(1, prev.length - 1);
  const nn = Math.max(1, next.length - 1);
  next.forEach((nb, j) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < prev.length; i++) {
      if (used[i] || prev[i].ch !== nb.ch) {
        continue;
      }
      const d = Math.abs(i / pn - j / nn);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      flights.push({ ch: nb.ch, from: prev[best], to: nb });
    } else {
      flights.push({ ch: nb.ch, to: nb });
    }
  });
  prev.forEach((pb, i) => {
    if (!used[i]) {
      flights.push({ ch: pb.ch, from: pb });
    }
  });
  return flights;
}

function FloatChar({
  f,
  tt,
  charStyle,
  color,
}: {
  f: Flight;
  tt: SharedValue<number>;
  charStyle: TextStyle;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    if (f.from && f.to) {
      const m = smoothstep(MOVE_START, MOVE_END, tt.value);
      return {
        opacity: 1,
        transform: [
          { translateX: f.from.x + (f.to.x - f.from.x) * m },
          { translateY: f.from.y + (f.to.y - f.from.y) * m },
        ],
      };
    }
    if (f.from) {
      return {
        opacity: 1 - smoothstep(0, EXIT_END, tt.value),
        transform: [{ translateX: f.from.x }, { translateY: f.from.y }],
      };
    }
    const to = f.to!;
    return {
      opacity: smoothstep(ENTER_START, 1, tt.value),
      transform: [{ translateX: to.x }, { translateY: to.y }],
    };
  });
  return (
    <Animated.Text style={[charStyle, styles.float, { color }, style]}>
      {f.ch}
    </Animated.Text>
  );
}

type Props = {
  text: string;
  charStyle: TextStyle;
  color: string;
  /** Should match the frame's transition clock. */
  duration?: number;
  /** Outer container — reserve a fixed height here so the page never shifts. */
  style?: StyleProp<ViewStyle>;
};

export function MorphText({ text, charStyle, color, duration = 700, style }: Props) {
  const [shown, setShown] = useState(text);
  const [phase, setPhase] = useState<'idle' | 'measuring' | 'flying'>('idle');
  const [flights, setFlights] = useState<Flight[]>([]);
  const tt = useSharedValue(1);

  const wordChars = (shown.length > 0 ? shown.split(' ') : []).map(w => [...w]);
  const gap = Math.round((charStyle.fontSize ?? 14) * WORD_GAP);

  // Live layout of the flow layer, rebuilt after every text change.
  const wordPos = useRef<({ x: number; y: number } | undefined)[]>([]);
  const charPos = useRef<({ x: number; y: number } | undefined)[][]>([]);
  const prevBoxes = useRef<CharBox[]>([]); // completed layout of the last text
  const settled = useRef(false); // current flow fully measured
  const pending = useRef(false); // a morph is waiting on measurement

  const land = useCallback(() => {
    setPhase('idle');
    setFlights([]);
  }, []);

  const launch = useCallback(
    (fl: Flight[]) => {
      setFlights(fl);
      setPhase('flying');
      tt.value = 0;
      tt.value = withTiming(1, { duration, easing: Easing.linear }, fin => {
        if (fin) {
          runOnJS(land)();
        }
      });
    },
    [duration, land, tt],
  );

  const finishMeasure = useCallback(
    (boxes: CharBox[]) => {
      settled.current = true;
      if (pending.current) {
        pending.current = false;
        const fl = matchFlights(prevBoxes.current, boxes);
        prevBoxes.current = boxes;
        launch(fl);
      } else {
        prevBoxes.current = boxes;
      }
    },
    [launch],
  );

  useEffect(() => {
    if (text === shown) {
      return;
    }
    cancelAnimation(tt);
    tt.value = 1;
    wordPos.current = [];
    charPos.current = [];
    settled.current = false;
    setShown(text);
    if (text === '') {
      // Nothing to measure — every old letter simply exits.
      pending.current = false;
      launch(matchFlights(prevBoxes.current, []));
      prevBoxes.current = [];
    } else {
      pending.current = true;
      setFlights([]);
      setPhase('measuring');
    }
  }, [text, shown, tt, launch]);

  const tryComplete = () => {
    if (settled.current) {
      return;
    }
    for (let wi = 0; wi < wordChars.length; wi++) {
      const row = charPos.current[wi];
      if (!wordPos.current[wi] || !row) {
        return;
      }
      for (let ci = 0; ci < wordChars[wi].length; ci++) {
        if (!row[ci]) {
          return;
        }
      }
    }
    const boxes: CharBox[] = [];
    wordChars.forEach((chars, wi) => {
      const wp = wordPos.current[wi]!;
      chars.forEach((ch, ci) => {
        const cp = charPos.current[wi]![ci]!;
        boxes.push({ ch, x: wp.x + cp.x, y: wp.y + cp.y });
      });
    });
    finishMeasure(boxes);
  };

  const onWord = (wi: number) => (e: LayoutChangeEvent) => {
    const { x, y } = e.nativeEvent.layout;
    wordPos.current[wi] = { x, y };
    tryComplete();
  };
  const onChar = (wi: number, ci: number) => (e: LayoutChangeEvent) => {
    const { x, y } = e.nativeEvent.layout;
    (charPos.current[wi] ??= [])[ci] = { x, y };
    tryComplete();
  };

  return (
    <View style={style}>
      <View
        style={[styles.flow, { columnGap: gap }, phase !== 'idle' && styles.hidden]}>
        {wordChars.map((chars, wi) => (
          <View key={`${shown}#${wi}`} style={styles.word} onLayout={onWord(wi)}>
            {chars.map((ch, ci) => (
              <Text key={ci} style={[charStyle, { color }]} onLayout={onChar(wi, ci)}>
                {ch}
              </Text>
            ))}
          </View>
        ))}
      </View>

      {/* The old line holds still for the frame or two of measurement. */}
      {phase === 'measuring' &&
        prevBoxes.current.map((b, i) => (
          <Text
            key={i}
            style={[
              charStyle,
              styles.float,
              { color, transform: [{ translateX: b.x }, { translateY: b.y }] },
            ]}>
            {b.ch}
          </Text>
        ))}

      {phase === 'flying' &&
        flights.map((f, i) => (
          <FloatChar key={i} f={f} tt={tt} charStyle={charStyle} color={color} />
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flow: { flexDirection: 'row', flexWrap: 'wrap' },
  word: { flexDirection: 'row' },
  hidden: { opacity: 0 },
  float: { position: 'absolute', left: 0, top: 0 },
});
