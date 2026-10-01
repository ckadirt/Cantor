import React, { createContext, useContext, useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * KNOBS — a blind arrives as a sentence (`docs/interfacealpha/folio.html#arrival`).
 *
 * Every window is a stretch of one clock, 0..1, which is how far the blind is
 * drawn — the curtain's own height, read on the UI thread, never React state —
 * so a blind dragged halfway shows half a sentence and a flick arrives at
 * once. A page change inside a blind runs the same sentence on its own clock.
 */
export const ARRIVAL_KNOBS = {
  /** The clef and the title, together, from 60 % drawn. */
  CLEF_FROM: 0.6,
  CLEF_TO: 0.8,
  TITLE_FROM: 0.6,
  TITLE_TO: 0.86,
  /** The eyebrow, the meta and the way back land as the title finishes. */
  LINES_FROM: 0.74,
  LINES_TO: 0.9,
  /** The spine grows from just after the clef, measure by measure, by position. */
  SPINE_FROM: 0.66,
  SPINE_TO: 0.94,
  /** Each fact lands when the spine reaches it: this long, and this far. */
  FACT_SPAN: 0.1,
  FACT_RISE_PX: 5,
  /** Last, the double bar draws out of the spine, then the act appears. */
  BAR_FROM: 0.88,
  BAR_TO: 0.98,
  ACT_FROM: 0.94,
  ACT_TO: 1,
  /** A page inside a blind: how long its sentence takes, linear. */
  PAGE_MS: 640,
} as const;

/** Where `clock` has got to inside one window, as 0..1. */
export function windowed(clock: number, from: number, to: number): number {
  'worklet';
  if (to <= from) return clock >= to ? 1 : 0;
  return Math.min(Math.max((clock - from) / (to - from), 0), 1);
}

const ArrivalContext = createContext<SharedValue<number> | null>(null);

/** The visible height of the stave a measure stands in, for its arrival. */
export const StaveHeight = createContext<SharedValue<number> | null>(null);

/** Hand the blind's clock (or a page's) to everything drawn inside it. */
export function ArrivalProvider({
  children,
  clock,
}: {
  children: React.ReactNode;
  clock: SharedValue<number>;
}) {
  return (
    <ArrivalContext.Provider value={clock}>{children}</ArrivalContext.Provider>
  );
}

/** The clock everything here arrives on; 1 (arrived) outside any blind. */
export function useArrivalClock(): SharedValue<number> {
  const clock = useContext(ArrivalContext);
  const arrived = useSharedValue(1);
  return clock ?? arrived;
}

/**
 * A page's own sentence inside a blind that is already down. Mount it keyed by
 * the page: a page that replaces another (`fresh`) starts its clock at 0 on
 * its first frame — set at creation, not by an effect, so it never shows a
 * frame arrived — and runs it to 1. The first page arrives with the blind.
 * Never ahead of the blind itself.
 */
export function PageArrival({
  children,
  fresh,
}: {
  children: React.ReactNode;
  fresh: boolean;
}) {
  const blind = useArrivalClock();
  const reducedMotion = useReducedMotion();
  const own = useSharedValue(fresh && !reducedMotion ? 0 : 1);
  useEffect(() => {
    if (!fresh || reducedMotion) return;
    own.value = withTiming(1, {
      duration: ARRIVAL_KNOBS.PAGE_MS,
      easing: Easing.linear,
    });
  }, [fresh, own, reducedMotion]);
  const clock = useDerivedValue(() => Math.min(blind.value, own.value));
  return <ArrivalProvider clock={clock}>{children}</ArrivalProvider>;
}

/**
 * A block that lands inside a window: opacity, and a small rise. Opacity and
 * transform only — a layout prop driven from the UI thread never reaches the
 * layout pass (`Reveal`).
 */
export function Arrive({
  children,
  from,
  to,
  rise = ARRIVAL_KNOBS.FACT_RISE_PX,
  style,
}: {
  children: React.ReactNode;
  from: number;
  to: number;
  rise?: number;
  style?: React.ComponentProps<typeof Animated.View>['style'];
}) {
  const clock = useArrivalClock();
  const reducedMotion = useReducedMotion();
  const landed = useAnimatedStyle(() => {
    const local = windowed(clock.value, from, to);
    return reducedMotion
      ? { opacity: local }
      : { opacity: local, transform: [{ translateY: (1 - local) * rise }] };
  }, [from, reducedMotion, rise, to]);
  return <Animated.View style={[style, landed]}>{children}</Animated.View>;
}
