/**
 * The onboarding flow. Panel -1 is the animated Cantor intro; after it the
 * content panels share one persistent frame, and the intro's trick carries
 * through the whole flow: the sigil morphs shape-to-shape, the eyebrow and
 * title use whole-object Manim transforms, and bodies exchange on the same
 * clock. Their first appearance uses Manim's Write gesture. Nothing just cuts.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  withDelay,
  type SharedValue,
} from 'react-native-reanimated';
import { IntroPanel } from './IntroPanel';
import {
  MorphShape,
  MorphTextSequence,
  TransformText,
  type MorphTextSequenceItem,
} from '../motion';
import { whatPanel } from './panels/WhatPanel';
import { backendsPanel } from './panels/BackendsPanel';
import { identityPanel } from './panels/IdentityPanel';
import { backupPanel } from './panels/BackupPanel';
import { thresholdPanel } from './panels/ThresholdPanel';
import type {
  PanelDef,
  PanelTransitionRequest,
  PhraseHandoffLayout,
} from './panels/types';
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
const BODY_EXIT_MS = 260; // old body fades (content swaps at the bottom)…
const BODY_ENTER_MS = 380; // …then the new one rises in
const BODY_SHIFT = 14; // px the incoming body rises

// The phrase layer paints before it moves, then stays alive through the body
// swap so the twelve words never disappear between panels.
const PHRASE_FLIGHT_PREPARE_MS = 120;
const PHRASE_FLIGHT_MS = 760;
const PHRASE_WORD_SIZE = 13;

// Fixed frame zones so nothing shifts while letters fly between panels.
const SIGIL_H = 168;
const SIGIL_ASPECT_RATIO = 1; // uniform scale preserves the source SVG exactly
const SIGIL_INK_INSET = 2; // authored units removed uniformly from SVG boundaries
const EYEBROW_H = 20;
const TITLE_H = 78;

type Props = {
  onDone: () => void;
};

type PhraseHandoff = {
  source: PhraseHandoffLayout;
  target?: PhraseHandoffLayout;
};

const PHRASE_FLIGHT_TEXT_STYLE = {
  fontFamily: type.mono.fontFamily,
  fontSize: PHRASE_WORD_SIZE,
};

function PhraseHandoffOverlay({
  handoff,
  progress,
  animatedStyle,
  color,
}: {
  handoff: PhraseHandoff;
  progress: SharedValue<number>;
  animatedStyle: ReturnType<typeof useAnimatedStyle>;
  color: string;
}) {
  const items = useMemo<readonly MorphTextSequenceItem[]>(() => {
    const targets = new Map(
      (handoff.target ?? handoff.source).words.map(word => [word.key, word]),
    );
    return handoff.source.words.map(source => {
      const target = targets.get(source.key) ?? source;
      return {
        key: source.key,
        initialText: source.text,
        text: source.text,
        initialX: source.x,
        initialY: source.y,
        initialWidth: source.width,
        x: target.x,
        y: target.y,
        width: target.width,
        start: 0,
        end: 1,
      };
    });
  }, [handoff]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, animatedStyle]}>
      <MorphTextSequence
        items={items}
        charStyle={PHRASE_FLIGHT_TEXT_STYLE}
        color={color}
        progress={progress}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** Full-screen overlay rendered above MainScreen until the flow completes. */
export function Onboarding({ onDone }: Props) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const [step, setStep] = useState(-1); // -1 = intro panel
  const [phraseHandoff, setPhraseHandoff] = useState<PhraseHandoff | null>(null);
  const rootRef = useRef<View>(null);
  const rootOriginRef = useRef({ x: 0, y: 0 });
  const phraseFlight = useSharedValue(0);
  const phraseOverlayA = useSharedValue(0);

  // The body swaps by hand, not with entering/exiting layout animations —
  // those flash the incoming view for a frame on the new architecture. One
  // persistent view fades out, swaps content while invisible, rises back in.
  const [shownStep, setShownStep] = useState(0);
  const bodyA = useSharedValue(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const swapBody = useCallback(() => setShownStep(Math.max(0, stepRef.current)), []);

  useEffect(() => {
    if (step < 0) {
      return;
    }
    if (step === shownStep) {
      // content is in place (mount, or just swapped while invisible)
      bodyA.value = withTiming(1, {
        duration: BODY_ENTER_MS,
        easing: Easing.out(Easing.cubic),
      });
    } else {
      cancelAnimation(bodyA);
      bodyA.value = withTiming(0, { duration: BODY_EXIT_MS, easing: Easing.linear }, fin => {
        if (fin) {
          runOnJS(swapBody)();
        }
      });
    }
  }, [step, shownStep, bodyA, swapBody]);

  const bodyStyle = useAnimatedStyle(() => ({
    opacity: bodyA.value,
    transform: [{ translateY: BODY_SHIFT * (1 - bodyA.value) }],
  }));

  // The header rises softly the first time the frame appears after the intro
  // — manual, not an entering animation (those flash a frame on Fabric).
  const headerA = useSharedValue(0);
  useEffect(() => {
    if (step >= 0) {
      headerA.value = withTiming(1, {
        duration: 480,
        easing: Easing.out(Easing.cubic),
      });
    }
  }, [step, headerA]);
  const headerStyle = useAnimatedStyle(() => ({ opacity: headerA.value }));

  const phraseOverlayStyle = useAnimatedStyle(() => ({
    opacity: phraseOverlayA.value,
  }));

  const clearPhraseHandoff = useCallback(() => setPhraseHandoff(null), []);

  useEffect(() => {
    if (!phraseHandoff?.target) {
      return;
    }
    phraseFlight.value = 0;
    phraseFlight.value = withDelay(
      PHRASE_FLIGHT_PREPARE_MS,
      withTiming(1, {
        duration: PHRASE_FLIGHT_MS,
        easing: Easing.inOut(Easing.cubic),
      }),
    );
    return () => cancelAnimation(phraseFlight);
  }, [phraseFlight, phraseHandoff?.target]);

  const go = (next: number) => {
    if (step === 3 && next !== 3 && phraseHandoff) {
      cancelAnimation(phraseFlight);
      phraseOverlayA.value = withTiming(
        0,
        { duration: BODY_EXIT_MS, easing: Easing.linear },
        finished => {
          if (finished) {
            runOnJS(clearPhraseHandoff)();
          }
        },
      );
    }
    setStep(Math.max(-1, next));
  };

  const beginPhraseHandoff = (transition: PanelTransitionRequest) => {
    if (reduced || !rootRef.current) {
      go(step + 1);
      return;
    }
    rootRef.current.measureInWindow((rootX, rootY) => {
      rootOriginRef.current = { x: rootX, y: rootY };
      const source = {
        words: transition.source.words.map(word => ({
          ...word,
          x: word.x - rootX,
          y: word.y - rootY,
        })),
      };
      phraseFlight.value = 0;
      phraseOverlayA.value = 1;
      setPhraseHandoff({ source });
      setStep(step + 1);
    });
  };

  const handleBodyNext = (transition?: PanelTransitionRequest) => {
    if (shownStep !== step) {
      return;
    }
    if (step === 2 && transition?.kind === 'identity-to-backup') {
      beginPhraseHandoff(transition);
      return;
    }
    go(step + 1);
  };

  const handlePhraseTarget = (target: PhraseHandoffLayout) => {
    if (!phraseHandoff || phraseHandoff.target) {
      return;
    }
    const { x: rootX, y: rootY } = rootOriginRef.current;
    setPhraseHandoff(current =>
      current && !current.target
        ? {
            ...current,
            target: {
              words: target.words.map(word => ({
                ...word,
                x: word.x - rootX,
                y: word.y - rootY,
              })),
            },
          }
        : current,
    );
  };

  if (step < 0) {
    return <IntroPanel onNext={() => go(0)} />;
  }

  const def = PANELS[step];
  const Body = PANELS[shownStep].Body;

  return (
    <View ref={rootRef} style={[styles.root, { backgroundColor: pal.bg }]}>
      <Animated.View style={[styles.header, headerStyle]}>
        <Pressable onPress={() => go(step - 1)} hitSlop={12} style={styles.back}>
          <Text style={[type.eyebrow, { color: pal.faint }]}>‹ BACK</Text>
        </Pressable>
        <Text style={[type.eyebrow, { color: pal.muted }]}>
          {step + 1} / {PANELS.length}
        </Text>
        <View style={styles.back} />
      </Animated.View>

      <View style={styles.sigilZone}>
        <MorphShape
          shape={def.sigil}
          duration={TRANSITION_MS}
          width={width - space.lg * 2}
          height={SIGIL_H}
          color={pal.ink}
          aspectRatio={SIGIL_ASPECT_RATIO}
          inkInset={SIGIL_INK_INSET}
          appearance="write"
        />
      </View>

      <TransformText
        text={def.eyebrow.toUpperCase()}
        charStyle={type.eyebrow}
        color={pal.muted}
        duration={TRANSITION_MS}
        appearance="write"
        style={styles.eyebrow}
      />
      <TransformText
        text={def.title}
        charStyle={type.title}
        color={pal.ink}
        duration={TRANSITION_MS}
        appearance="write"
        style={styles.title}
      />

      {/* The animated view persists; only its content swaps (while invisible).
          A fading-out body's buttons are inert — shownStep lags step. */}
      <Animated.View style={[styles.body, bodyStyle]}>
        <Body
          key={PANELS[shownStep].key}
          onNext={handleBodyNext}
          onDone={() => shownStep === step && onDone()}
          phraseHandoffActive={shownStep === 3 && phraseHandoff !== null}
          onPhraseTarget={shownStep === 3 ? handlePhraseTarget : undefined}
        />
      </Animated.View>

      {phraseHandoff && (
        <PhraseHandoffOverlay
          handoff={phraseHandoff}
          progress={phraseFlight}
          animatedStyle={phraseOverlayStyle}
          color={pal.ink}
        />
      )}
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
