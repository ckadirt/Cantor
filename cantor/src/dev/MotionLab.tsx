/**
 * The engine's workbench — not shipped UI. Flip MOTION_LAB in App.tsx to open.
 *
 *  - tap any chip: the mark morphs to it (tap fast — that's the interruption
 *    test; geometry must flow, never snap);
 *  - SCRUB mode: drag the strip to move the clock by hand and park a morph at
 *    t = 0.3 while you judge it;
 *  - the text block cycles phrases through every text-motion variant with the
 *    real fonts; remount the lab to replay the initial Write appearance.
 */
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import {
  AUTHOR_STROKE,
  LIBRARY,
  MorphShape,
  MorphText,
  type LibraryName,
  type Shape,
  type TextMotionVariant,
} from '../motion';
import { space, type, usePalette } from '../theme/tokens';

const NAMES = Object.keys(LIBRARY) as LibraryName[];
const TEXT_VARIANTS: TextMotionVariant[] = [
  'transform',
  'matching',
  'crossfade',
];
const WEIGHTS = [
  { label: 'LIGHT', delta: -0.55 },
  { label: 'REGULAR', delta: 0 },
  { label: 'BOLD', delta: 0.85 },
] as const;

const PHRASES = [
  'What Cantor is',
  'Where songs are made',
  'Your identity is a phrase',
  'Keep the phrase safe',
  'No one shall expel us',
  '',
];

const STAGE_H = 220;
const STRIP_H = 44;

export function MotionLab() {
  const pal = usePalette();
  const { width } = useWindowDimensions();
  const [shape, setShape] = useState<LibraryName>('alephNull');
  const [scrubbing, setScrubbing] = useState(false);
  const [weightDelta, setWeightDelta] = useState(0);
  const [phrase, setPhrase] = useState(0);
  const [textVariant, setTextVariant] =
    useState<TextMotionVariant>('transform');
  const progress = useSharedValue(1);
  const [stripW, setStripW] = useState(1);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin(e => {
      progress.value = Math.min(1, Math.max(0, e.x / stripW));
    })
    .onUpdate(e => {
      progress.value = Math.min(1, Math.max(0, e.x / stripW));
    });

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  const pick = (name: LibraryName) => {
    if (scrubbing) {
      progress.value = 0; // park at the start; drag through the new morph
    }
    setShape(name);
  };

  const stageW = width - space.lg * 2;
  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <View style={styles.header}>
        <Text style={[type.eyebrow, { color: pal.muted }]}>MOTION LAB</Text>
        <Pressable onPress={() => setScrubbing(s => !s)} hitSlop={12}>
          <Text
            style={[type.eyebrow, { color: scrubbing ? pal.ink : pal.faint }]}
          >
            {scrubbing ? '● SCRUB' : '○ SCRUB'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.weightModes}>
        <Text style={[type.eyebrow, { color: pal.faint }]}>WEIGHT</Text>
        {WEIGHTS.map(weight => (
          <Pressable
            key={weight.label}
            onPress={() => setWeightDelta(weight.delta)}
            hitSlop={6}
          >
            <Text
              style={[
                type.mono,
                { color: weight.delta === weightDelta ? pal.ink : pal.faint },
              ]}
            >
              {weight.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.stage}>
        <MorphShape
          shape={LIBRARY[shape]}
          width={stageW}
          height={STAGE_H}
          color={pal.ink}
          duration={700}
          appearance="write"
          strokeWidth={Math.max(
            0.25,
            ((LIBRARY[shape] as Shape).strokeWidth ?? AUTHOR_STROKE) +
              weightDelta,
          )}
          progress={scrubbing ? progress : undefined}
        />
      </View>

      {scrubbing && (
        <GestureDetector gesture={pan}>
          <View
            style={[styles.strip, { borderColor: pal.line }]}
            onLayout={e => setStripW(Math.max(1, e.nativeEvent.layout.width))}
          >
            <Animated.View
              style={[
                styles.stripFill,
                { backgroundColor: pal.ink },
                fillStyle,
              ]}
            />
          </View>
        </GestureDetector>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.chips}>
        {NAMES.map(name => (
          <Pressable
            key={name}
            onPress={() => pick(name)}
            style={[
              styles.chip,
              { borderColor: name === shape ? pal.ink : pal.line },
            ]}
          >
            <Text
              style={[
                type.mono,
                { color: name === shape ? pal.ink : pal.muted },
              ]}
            >
              {name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.textModes}>
        {TEXT_VARIANTS.map(name => (
          <Pressable
            key={name}
            onPress={() => setTextVariant(name)}
            hitSlop={6}
          >
            <Text
              style={[
                type.mono,
                { color: name === textVariant ? pal.ink : pal.faint },
              ]}
            >
              {name.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable onPress={() => setPhrase(p => (p + 1) % PHRASES.length)}>
        <MorphText
          text={PHRASES[phrase]}
          charStyle={type.title}
          color={pal.ink}
          duration={700}
          variant={textVariant}
          appearance="write"
          style={styles.textZone}
          progress={scrubbing ? progress : undefined}
        />
        <Text style={[type.eyebrow, styles.hint, { color: pal.faint }]}>
          TAP TEXT TO CYCLE
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.lg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: space.xxl,
    paddingBottom: space.sm,
  },
  weightModes: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: space.xs,
  },
  stage: { height: STAGE_H, marginVertical: space.sm },
  strip: {
    height: STRIP_H,
    borderWidth: 1,
    marginBottom: space.md,
    justifyContent: 'center',
  },
  stripFill: { height: 2 },
  list: { flexGrow: 0, maxHeight: 190 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingBottom: space.md,
  },
  chip: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
  },
  textZone: { height: 78, marginTop: space.lg },
  hint: { marginTop: space.xs },
  textModes: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
});
