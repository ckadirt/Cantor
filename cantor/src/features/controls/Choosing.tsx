import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas, DashPathEffect, Line, vec } from '@shopify/react-native-skia';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { LEDGER_NOTE_STYLE } from './Ledger';
import { Reveal } from './Reveal';
import { font, touch, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the three choosing controls beside the dial
 * (`docs/interfacealpha/folio.html#choosing`). A choice is drawn in the shape
 * of what it chooses: names as a fact with a whisper, quantities along a line,
 * numbers you drag.
 */
export const CHOOSING_KNOBS = {
  /** One alternative in an open choice: a full touch target. */
  ALT_PX: touch.min,
  ALT_DOT_PX: 7,
  /** The ruler: its hairline, its ticks, its hand and its ring. */
  RULER_PX: 30,
  RULER_BASE_Y: 18,
  RULER_TICK_PX: 5,
  RULER_HAND_TOP: 4,
  RULER_HAND_PX: 20,
  RULER_RING_PX: 9,
  /** How long the hand takes to reach the stop it snapped to. */
  RULER_MOVE_MS: 180,
  /** How far a finger drags a scrubbed number for one step of it. */
  SCRUB_STEP_PX: 10,
  /** The small ruler under the thumb while scrubbing: ticks, and their pitch. */
  SCRUB_TICKS: 21,
  SCRUB_TICK_PITCH_PX: 5,
  SCRUB_RULER_PX: 10,
  /** A finger has to travel this far sideways before a tap becomes a scrub. */
  SCRUB_SLOP_PX: 6,
} as const;

/** One name a `Choice` can pick. */
export type ChoiceItem = Readonly<{
  key: string;
  label: string;
  accessibilityLabel: string;
  /** A short state beside it in the open stack (`READY`, `4 STAGES`). */
  state?: string;
  /** Out of reach for now: still listed, in faint, so it never goes missing. */
  quiet?: boolean;
  /** A drawing before the name (a node's station). */
  mark?: React.ReactNode;
}>;

/**
 * A name, chosen: the chosen one as a fact in ink, its alternatives as a
 * whisper under it (`OR H100 · RTX6000`). A tap opens them as a stack of
 * 48 dp rows; picking one closes it. Offline options stay in the stack, faint.
 *
 * This replaces the horizontal dials of names, which clipped at the page's
 * edge and hid the very options they were showing.
 */
export function Choice({
  activeKey,
  disabled = false,
  empty,
  items,
  onSelect,
  unchosen = 'not chosen yet',
}: {
  activeKey: string | null;
  disabled?: boolean;
  /** What to say when there is nothing to choose from at all. */
  empty: string;
  items: readonly ChoiceItem[];
  onSelect: (key: string) => void;
  /** What stands in the fact's place while nothing is chosen. */
  unchosen?: string;
}) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const chosen = items.find(item => item.key === activeKey) ?? null;
  const others = items.filter(item => item !== chosen);
  // A choice with one option is not a choice: it is stated.
  const stated = items.length <= 1;
  useEffect(() => {
    if (stated || disabled) setOpen(false);
  }, [disabled, stated]);

  if (items.length === 0)
    return (
      <View style={styles.fact}>
        <Text style={[type.body, { color: pal.muted }]}>{empty}</Text>
      </View>
    );

  const head = chosen ?? (stated ? items[0] : null);
  return (
    <View>
      <Pressable
        accessibilityLabel={
          head === null
            ? `Choose one of ${items.length}`
            : `${head.label}, ${stated ? 'the only one' : 'tap to change'}`
        }
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: stated }}
        disabled={stated || disabled}
        onPress={() => setOpen(current => !current)}
        style={styles.fact}
      >
        <View style={styles.named}>
          {head?.mark ?? null}
          <Text
            numberOfLines={1}
            style={[
              type.body,
              styles.factWord,
              {
                color:
                  head === null ? pal.faint : head.quiet ? pal.faint : pal.ink,
              },
            ]}
          >
            {head === null ? unchosen : head.label}
          </Text>
        </View>
        {stated ? null : (
          <Text
            numberOfLines={1}
            style={[
              LEDGER_NOTE_STYLE,
              { color: pal.faint },
              open && styles.hidden,
            ]}
          >
            {`${head === null ? '' : 'OR '}${others
              .map(item => item.label.toUpperCase())
              .join(' · ')}`}
          </Text>
        )}
      </Pressable>
      {open ? (
        <Reveal open>
          {others.map(item => (
            <Pressable
              key={item.key}
              accessibilityLabel={item.accessibilityLabel}
              accessibilityRole="button"
              onPress={() => {
                setOpen(false);
                onSelect(item.key);
              }}
              style={styles.alt}
            >
              {item.mark ?? (
                <View style={[styles.altDot, { borderColor: pal.faint }]} />
              )}
              <Text
                numberOfLines={1}
                style={[
                  type.body,
                  styles.altWord,
                  { color: item.quiet ? pal.faint : pal.muted },
                ]}
              >
                {item.label}
              </Text>
              {item.state === undefined ? null : (
                <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
                  {item.state.toUpperCase()}
                </Text>
              )}
            </Pressable>
          ))}
        </Reveal>
      ) : null}
    </View>
  );
}

/** One stop on a ruler. */
export type RulerStop = Readonly<{
  key: string;
  /** Written under the stop; left out for a ruler whose value is said above it. */
  label?: string;
  accessibilityLabel: string;
}>;

/**
 * A quantity, chosen along a line: a hairline with a tick per stop, a tall
 * ink hand at the chosen one, and — for a ruler whose first stop is *auto* —
 * a small ring there instead of a tick. Drag along it and it snaps; tap a stop
 * to go there. The value is written above it by the caller, in words.
 */
export function Ruler({
  activeKey,
  auto = false,
  disabled = false,
  onSelect,
  onStep,
  stops,
}: {
  activeKey: string;
  /** The first stop is *auto*: drawn as a ring, the hand hidden on it. */
  auto?: boolean;
  disabled?: boolean;
  onSelect: (key: string) => void;
  /** Each time the hand crosses to another stop under a finger (a haptic tick, F7). */
  onStep?: () => void;
  stops: readonly RulerStop[];
}) {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    stops.findIndex(stop => stop.key === activeKey),
  );
  const last = Math.max(1, stops.length - 1);
  const at = useSharedValue(index);
  useEffect(() => {
    at.value = reducedMotion
      ? index
      : withTiming(index, {
          duration: CHOOSING_KNOBS.RULER_MOVE_MS,
          easing: easeSmoother,
        });
  }, [at, index, reducedMotion]);
  const onAuto = auto && index === 0;
  // Stops stand across `width - 1`: a hairline at `width` is past the edge.
  const span = Math.max(0, width - 1);
  const handStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (at.value / last) * span }],
  }));

  const current = useRef(index);
  current.current = index;
  const pick = useCallback(
    (to: number) => {
      if (to === current.current) return;
      current.current = to;
      onStep?.();
      onSelect(stops[to].key);
    },
    [onSelect, onStep, stops],
  );
  const gesture = useMemo(() => {
    const toStop = (x: number) => {
      'worklet';
      if (width <= 0) return 0;
      return Math.round(Math.min(Math.max(x / width, 0), 1) * last);
    };
    return Gesture.Pan()
      .enabled(!disabled)
      .minDistance(0)
      .onBegin(event => {
        'worklet';
        runOnJS(pick)(toStop(event.x));
      })
      .onUpdate(event => {
        'worklet';
        runOnJS(pick)(toStop(event.x));
      });
  }, [disabled, last, pick, width]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={stops[index]?.accessibilityLabel}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          const to =
            event.nativeEvent.actionName === 'increment'
              ? Math.min(stops.length - 1, index + 1)
              : Math.max(0, index - 1);
          pick(to);
        }}
        onLayout={(event: LayoutChangeEvent) =>
          setWidth(event.nativeEvent.layout.width)
        }
        style={[
          styles.ruler,
          stops.some(stop => stop.label !== undefined) && styles.rulerLabelled,
        ]}
      >
        <View style={[styles.base, { backgroundColor: pal.line }]} />
        {width > 0
          ? stops.map((stop, stopIndex) => {
              const x = (stopIndex / last) * span;
              return stopIndex === 0 && auto ? (
                <View
                  key={stop.key}
                  style={[
                    styles.ring,
                    {
                      left: x - CHOOSING_KNOBS.RULER_RING_PX / 2,
                      borderColor: onAuto ? pal.ink : pal.faint,
                      backgroundColor: onAuto ? pal.ink : pal.bg,
                    },
                  ]}
                />
              ) : (
                <React.Fragment key={stop.key}>
                  <View
                    style={[
                      styles.tick,
                      { left: x, backgroundColor: pal.faint },
                    ]}
                  />
                  {stop.label === undefined ? null : (
                    <Text
                      style={[
                        styles.stopLabel,
                        stopIndex === last
                          ? styles.labelEnd
                          : stopIndex === 0
                          ? styles.labelStart
                          : [styles.labelMid, { left: x - 20 }],
                        { color: stopIndex === index ? pal.ink : pal.faint },
                      ]}
                    >
                      {stop.label}
                    </Text>
                  )}
                </React.Fragment>
              );
            })
          : null}
        {width > 0 ? (
          <Animated.View
            style={[
              styles.hand,
              { backgroundColor: pal.ink },
              onAuto && styles.hidden,
              handStyle,
            ]}
          />
        ) : null}
      </View>
    </GestureDetector>
  );
}

/** How many decimals a step implies: `0.05` → 2. */
function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A declared number, dragged: the number with a dotted underline; drag
 * sideways and it counts, a step every `SCRUB_STEP_PX`, with a small ruler
 * under the thumb while you do. A tap still opens the keyboard for an exact
 * value — the number *is* a text field, unboxed.
 */
export function Scrub({
  accessibilityLabel,
  disabled = false,
  maximum,
  minimum,
  onChange,
  onStep,
  step,
  value,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  maximum: number;
  minimum: number;
  onChange: (value: number) => void;
  onStep?: () => void;
  step: number;
  value: number;
}) {
  const pal = usePalette();
  const decimals = decimalsOf(step);
  const [text, setText] = useState(
    Number.isFinite(value) ? value.toFixed(decimals) : '',
  );
  const [focused, setFocused] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [wordWidth, setWordWidth] = useState(0);
  const drift = useSharedValue(0);
  useEffect(() => {
    if (!focused && Number.isFinite(value)) setText(value.toFixed(decimals));
  }, [decimals, focused, value]);

  const origin = useRef(value);
  const last = useRef(value);
  const begin = useCallback(() => {
    origin.current = Number.isFinite(value) ? value : minimum;
    last.current = origin.current;
    setScrubbing(true);
  }, [minimum, value]);
  const move = useCallback(
    (dx: number) => {
      const steps = Math.round(dx / CHOOSING_KNOBS.SCRUB_STEP_PX);
      const raw = origin.current + steps * step;
      const next = Number(
        Math.min(maximum, Math.max(minimum, raw)).toFixed(decimals),
      );
      if (next === last.current) return;
      last.current = next;
      onStep?.();
      onChange(next);
    },
    [decimals, maximum, minimum, onChange, onStep, step],
  );
  const end = useCallback(() => setScrubbing(false), []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .activeOffsetX([
          -CHOOSING_KNOBS.SCRUB_SLOP_PX,
          CHOOSING_KNOBS.SCRUB_SLOP_PX,
        ])
        .failOffsetY([-12, 12])
        .onStart(() => {
          'worklet';
          runOnJS(begin)();
        })
        .onUpdate(event => {
          'worklet';
          drift.value = event.translationX % CHOOSING_KNOBS.SCRUB_STEP_PX;
          runOnJS(move)(event.translationX);
        })
        .onFinalize(() => {
          'worklet';
          drift.value = 0;
          runOnJS(end)();
        }),
    [begin, disabled, drift, end, move],
  );
  // The field would take every touch for itself, so the gesture owns them: a
  // drag scrubs, and a tap hands the field the keyboard.
  const input = useRef<TextInput | null>(null);
  const openKeyboard = useCallback(() => input.current?.focus(), []);
  const gestures = useMemo(
    () =>
      Gesture.Exclusive(
        gesture,
        Gesture.Tap()
          .enabled(!disabled)
          .onEnd((_event, success) => {
            'worklet';
            if (success) runOnJS(openKeyboard)();
          }),
      ),
    [disabled, gesture, openKeyboard],
  );
  const miniStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -drift.value }],
  }));

  return (
    <GestureDetector gesture={gestures}>
      <View style={styles.scrub}>
        <View pointerEvents={focused ? 'auto' : 'none'}>
          <TextInput
            ref={input}
            accessibilityLabel={accessibilityLabel}
            editable={!disabled}
            inputMode="decimal"
            onBlur={() => setFocused(false)}
            onChangeText={next => {
              setText(next);
              const trimmed = next.trim();
              onChange(trimmed.length === 0 ? Number.NaN : Number(trimmed));
            }}
            onFocus={() => setFocused(true)}
            onLayout={(event: LayoutChangeEvent) =>
              setWordWidth(event.nativeEvent.layout.width)
            }
            style={[styles.scrubWord, { color: pal.ink }]}
            value={text}
          />
        </View>
        {/*
          The dotted underline, drawn rather than bordered: Android draws a
          dotted border only on a box with every side, which doubled it.
        */}
        <Canvas
          pointerEvents="none"
          style={[styles.dots, { width: wordWidth }]}
        >
          <Line
            color={scrubbing || focused ? pal.ink : pal.faint}
            p1={vec(0, 0.5)}
            p2={vec(wordWidth, 0.5)}
            strokeWidth={1}
            style="stroke"
          >
            <DashPathEffect intervals={[1, 2]} />
          </Line>
        </Canvas>
        {scrubbing ? (
          <View pointerEvents="none" style={styles.mini}>
            <Animated.View style={[styles.miniTrack, miniStyle]}>
              {Array.from({ length: CHOOSING_KNOBS.SCRUB_TICKS }, (_, tick) => (
                <View
                  key={tick}
                  style={[
                    styles.miniTick,
                    { backgroundColor: pal.faint },
                    tick % 5 === 0 ? styles.miniTickLong : styles.miniTickShort,
                  ]}
                />
              ))}
            </Animated.View>
            <View style={[styles.miniHand, { backgroundColor: pal.ink }]} />
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fact: { justifyContent: 'center', minHeight: touch.min },
  named: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  factWord: { flexShrink: 1 },
  alt: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: CHOOSING_KNOBS.ALT_PX,
  },
  altDot: {
    borderRadius: CHOOSING_KNOBS.ALT_DOT_PX / 2,
    borderWidth: 1,
    height: CHOOSING_KNOBS.ALT_DOT_PX,
    width: CHOOSING_KNOBS.ALT_DOT_PX,
  },
  altWord: { flex: 1 },
  ruler: { height: CHOOSING_KNOBS.RULER_PX, marginTop: 2 },
  rulerLabelled: { height: CHOOSING_KNOBS.RULER_PX + 12 },
  base: {
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    top: CHOOSING_KNOBS.RULER_BASE_Y,
  },
  tick: {
    height: CHOOSING_KNOBS.RULER_TICK_PX,
    position: 'absolute',
    top: CHOOSING_KNOBS.RULER_BASE_Y - CHOOSING_KNOBS.RULER_TICK_PX,
    width: StyleSheet.hairlineWidth,
  },
  ring: {
    borderRadius: CHOOSING_KNOBS.RULER_RING_PX / 2,
    borderWidth: 1,
    height: CHOOSING_KNOBS.RULER_RING_PX,
    position: 'absolute',
    top: CHOOSING_KNOBS.RULER_BASE_Y - 4,
    width: CHOOSING_KNOBS.RULER_RING_PX,
  },
  hand: {
    height: CHOOSING_KNOBS.RULER_HAND_PX,
    left: 0,
    position: 'absolute',
    top: CHOOSING_KNOBS.RULER_HAND_TOP,
    width: 1,
  },
  stopLabel: {
    fontFamily: font.mono,
    fontSize: 9,
    letterSpacing: 1,
    position: 'absolute',
    top: CHOOSING_KNOBS.RULER_BASE_Y + 6,
  },
  scrub: {
    alignSelf: 'flex-start',
    minHeight: touch.min,
    justifyContent: 'center',
  },
  dots: { height: 1 },
  scrubWord: {
    fontFamily: font.text,
    fontSize: 15,
    includeFontPadding: false,
    minWidth: 28,
    paddingBottom: 2,
    paddingHorizontal: 0,
    paddingTop: 0,
  },
  mini: {
    height: CHOOSING_KNOBS.SCRUB_RULER_PX,
    left: -40,
    overflow: 'hidden',
    position: 'absolute',
    right: -40,
    top: touch.min - 8,
  },
  miniTrack: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    height: CHOOSING_KNOBS.SCRUB_RULER_PX,
    justifyContent: 'space-between',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  miniTick: { width: StyleSheet.hairlineWidth },
  miniTickLong: { height: 8 },
  miniTickShort: { height: 5 },
  hidden: { opacity: 0 },
  labelEnd: { right: 0 },
  labelStart: { left: 0 },
  labelMid: { textAlign: 'center', width: 40 },
  miniHand: {
    height: CHOOSING_KNOBS.SCRUB_RULER_PX,
    left: '50%',
    position: 'absolute',
    width: 1,
  },
});

/** A step for a declared number that did not declare one: about forty to cross it. */
export function declaredStep(
  kind: 'integer' | 'number',
  minimum: number,
  maximum: number,
  step: number | undefined,
): number {
  if (step !== undefined && step > 0) return step;
  if (kind === 'integer') return 1;
  const raw = (maximum - minimum) / 40;
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  const nice = normal < 1.5 ? 1 : normal < 3.5 ? 2.5 : normal < 7.5 ? 5 : 10;
  return Number((nice * magnitude).toPrecision(2));
}
