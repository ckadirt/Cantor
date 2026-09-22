/**
 * What a control looks like when it is not simply sitting there.
 *
 * Three states, three gestures, and each one answers a different question:
 *
 * | State | Question it answers | Gesture |
 * | --- | --- | --- |
 * | out of reach | *may I touch this?* | ink settles to `faint`, and back |
 * | working | *is this one doing something?* | a rule under it leaves straight |
 * | changed | *what does it say now?* | the words morph (`motion/MorphText`) |
 *
 * They are deliberately not interchangeable, and they never apply to the same
 * object at the same time. The control you just pressed is **not** disabled —
 * it is busy — so it keeps its ink and grows a rule; everything it locks out
 * goes faint and grows nothing. A control that went grey *and* waved would be
 * saying "you can't" and "I'm working" in one breath, which is how a saving
 * state ends up reading as a refusal.
 *
 * Nothing here knows what a song is. These are the panel vocabulary, next to
 * `Caret` and `Reveal`.
 */
import React, { useEffect } from 'react';
import {
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Canvas, Path, Skia, type SkSize } from '@shopify/react-native-skia';
import { easeSmoother } from '../../motion';
import { usePalette } from '../../theme/tokens';

/** KNOBS — how a control leaves reach, and how it says it is working. */
export const STATE_KNOBS = {
  /**
   * How long ink takes to settle out of reach, and to come back.
   *
   * Short, because this is not the event — it is the consequence of one. The
   * thing worth watching is whatever the control you pressed is doing; a
   * neighbour taking half a second to admit it is unavailable would pull the
   * eye to the wrong object. Long enough not to be a swap, and no longer.
   */
  REACH_MS: 200,

  /* ---- The rule that says "working" ---- */

  /** Its weight, and the seat it needs to have room to move in. */
  RULE_W_PX: StyleSheet.hairlineWidth,
  RULE_BOX_PX: 6,
  /**
   * How far it leaves straight.
   *
   * Past about 3 px it stops being a mark under a word and becomes a novelty;
   * under about 1 the travel cannot be read at hairline weight.
   */
  AMP_PX: 1.3,
  /**
   * One wavelength, and the knob that decides whether any of this reads as
   * craft or as a defect.
   *
   * It was 8 px first, which is about eleven cycles under a two-word label,
   * and on the phone that is not a wave: it is the squiggle every text field
   * in the world draws under a misspelling, so a thing being *saved* read as a
   * thing being *rejected* — the exact opposite of the sentence. At 18 the same
   * label carries four or five slow undulations, the travel is legible between
   * frames, and it reads as a line that is alive rather than one that is
   * complaining. Amplitude barely mattered by comparison.
   */
  PERIOD_PX: 18,
  /** How long one wavelength takes to travel its own length, left to right. */
  TRAVEL_MS: 900,
  /**
   * How long the wave takes to rise out of the line, and to relax back in.
   *
   * There is no threshold in front of this and there does not need to be one.
   * The motion engine's rule is that a new target takes over from wherever the
   * old one got to, so work that finishes in 60 ms means the amplitude never
   * left 0.2 and the eye sees a ripple; work that takes two seconds means it
   * arrived and travelled. The gesture scales itself to the wait.
   */
  RISE_MS: 180,
  /** How long the rule itself takes to draw on, when it owns that clock. */
  DRAW_MS: 220,
  /** Points along it. Enough that a wavelength is not a triangle. */
  SAMPLES: 48,
} as const;

/**
 * A control's ink, as a state rather than a value.
 *
 * Returns the same colour twice because ink is drawn two ways in this app and
 * both have to agree: `tint` for a `Animated.Text`, `colour` for anything on a
 * canvas — `MorphText`'s `color`, a Skia `Path`. Both read one shared value,
 * so a morphing label and the plain label beside it can never be caught in
 * different greys.
 */
export function useReach(
  disabled: boolean,
  options: { from?: string; to?: string } = {},
): {
  tint: { color: string };
  colour: DerivedValue<string>;
} {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  const from = options.from ?? pal.ink;
  const to = options.to ?? pal.faint;
  const away = useSharedValue(disabled ? 1 : 0);
  useEffect(() => {
    const next = disabled ? 1 : 0;
    away.value = reducedMotion
      ? next
      : withTiming(next, {
          duration: STATE_KNOBS.REACH_MS,
          easing: easeSmoother,
        });
  }, [away, disabled, reducedMotion]);
  const colour = useDerivedValue(() =>
    interpolateColor(away.value, [0, 1], [from, to]),
  );
  // Cast: an animated style *is* the style it animates, and typing it as such
  // is what lets a caller drop it into the same array as a static one.
  const tint = useAnimatedStyle(() => ({
    color: colour.value,
  })) as unknown as { color: string };
  return { tint, colour };
}

/**
 * The rule that says a control is working: a line that waves while it waits.
 *
 * Two inputs, deliberately separate. `amount` is how much of the rule exists,
 * which for a membership mark is *whether the song holds it* and has nothing
 * to do with waiting; `working` is whether that rule leaves straight. A caller
 * that has no use for the first — a button, whose rule exists only while it is
 * busy — omits it and the rule draws itself on and erases with the work.
 *
 * The path is rebuilt per frame rather than interpolated between two prepared
 * ones, which is the one place this departs from `motion`'s house style. It
 * buys the travel: a translating wave is not a point-wise morph between two
 * fixed outlines, and forty-eight points of arithmetic on the UI thread is
 * cheaper than the machinery that would avoid it. Verb identity is not at risk
 * because there is only ever one path here, never a pair.
 */
export function WorkingRule({
  amount,
  colour,
  style,
  working,
}: {
  /** How much of the rule exists, 0..1. Follows `working` when omitted. */
  amount?: SharedValue<number>;
  colour: string;
  style?: StyleProp<ViewStyle>;
  working: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const size = useSharedValue<SkSize>({ width: 0, height: 0 });
  // Starts empty even when mounted mid-work: a caller mounts this *because*
  // work began, and a rule that appears whole has skipped its own arrival.
  const own = useSharedValue(0);
  const wave = useSharedValue(0);
  const phase = useSharedValue(0);
  const drawn = amount ?? own;

  useEffect(() => {
    if (amount !== undefined) return;
    const next = working ? 1 : 0;
    own.value = reducedMotion
      ? next
      : withTiming(next, {
          duration: STATE_KNOBS.DRAW_MS,
          easing: easeSmoother,
        });
  }, [amount, own, reducedMotion, working]);

  useEffect(() => {
    // Reduced motion gets the rule and not the second sentence: a line that
    // never stops moving is exactly what the preference asks us not to draw.
    const next = working && !reducedMotion ? 1 : 0;
    wave.value = withTiming(next, {
      duration: STATE_KNOBS.RISE_MS,
      easing: easeSmoother,
    });
    if (next === 0) {
      // Let it flatten from wherever the travel reached; a cancelled phase
      // holds its value, so the relax is the amplitude leaving and nothing more.
      cancelAnimation(phase);
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, {
        duration: STATE_KNOBS.TRAVEL_MS,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [phase, reducedMotion, wave, working]);

  const path = useDerivedValue(() => {
    const width = size.value.width * drawn.value;
    const middle = size.value.height / 2;
    const builder = Skia.PathBuilder.Make();
    if (width <= 0) return builder.build();
    const amp = wave.value * STATE_KNOBS.AMP_PX;
    const turn = 2 * Math.PI;
    const shift = phase.value * turn;
    const steps = STATE_KNOBS.SAMPLES;
    for (let i = 0; i <= steps; i++) {
      const x = (width * i) / steps;
      const y =
        middle +
        amp * Math.sin(turn * (x / STATE_KNOBS.PERIOD_PX) - shift);
      if (i === 0) builder.moveTo(x, y);
      else builder.lineTo(x, y);
    }
    return builder.build();
  });

  return (
    <Canvas onSize={size} style={style}>
      <Path
        color={colour}
        path={path}
        strokeWidth={STATE_KNOBS.RULE_W_PX}
        style="stroke"
      />
    </Canvas>
  );
}

/**
 * Whether a rule has anything to draw, held open until it provably does not.
 *
 * The rule is a Skia canvas, so it is mounted only while there is ink in it —
 * a list of thirty names is otherwise thirty surfaces. The delay is what keeps
 * that from being a Flicker Law violation: unmounting on the commit that
 * clears the ink would cut an erase off mid-stroke, so the seat stays for as
 * long as the longest thing in it can still be running.
 *
 * A timeout rather than an animation callback, on purpose. Rule 4 forbids a
 * *completion callback* mutating the tree because a callback fires at the
 * moment ownership would change hands. Nothing changes hands here — by the
 * time this fires the canvas is empty and nothing replaces it.
 */
export function useRuleInk(inked: boolean): boolean {
  const [drawing, setDrawing] = React.useState(inked);
  useEffect(() => {
    if (inked) {
      setDrawing(true);
      return;
    }
    const timer = setTimeout(
      () => setDrawing(false),
      STATE_KNOBS.DRAW_MS + STATE_KNOBS.RISE_MS,
    );
    return () => clearTimeout(timer);
  }, [inked]);
  return drawing;
}
