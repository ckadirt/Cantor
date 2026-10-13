import { useEffect, useRef, useState } from 'react';
import {
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SEAL_PLAYER_KNOBS } from '../../lenses/seal';

/**
 * The lens clock: which lens the field is changing from, which to, and how
 * far it has got.
 *
 * It was one number, `lensMix` — 0 the circle, 1 the seal — which could only
 * ever say "between these two". A change is `(from, to, t)` so any lens can
 * become any other (the lens contract, R6 in the rewrite log): `from` and `to`
 * are positions in `LENSES`, and `t` runs 0 → 1, linear, eased once by
 * whoever draws from it. At rest `from` and `to` are the same lens and `t`
 * is 1.
 *
 * Retained across re-cuts on purpose — it lives in `FieldCanvas`, outside the
 * keyed native scene, so regrouping mid-change keeps the change where it was.
 */
export type LensClock = Readonly<{
  from: SharedValue<number>;
  to: SharedValue<number>;
  t: SharedValue<number>;
  /** A lens asked for mid-change, started when this change lands; or -1. */
  next: SharedValue<number>;
}>;

export type LensClockState = Readonly<{
  from: number;
  to: number;
  t: number;
  next: number;
}>;

/**
 * Where the clock goes when `target` is asked for, and whether `t` must start
 * running again.
 *
 * Every rule starts from what is drawn, never from either end — the house rule
 * for interruptions (`cantor/AGENTS.md`):
 *
 * - **Landed:** a new change from where it stands.
 * - **Asked for where it is already going:** nothing moves, and a queued lens
 *   is forgotten — the last tap wins.
 * - **Asked for where it came from:** it reverses. `from` and `to` swap and `t`
 *   becomes `1 − t`, which draws the very same frame: every beat is eased by
 *   smootherstep, and smootherstep is symmetric (`s(1 − x) = 1 − s(x)`).
 * - **A third lens mid-change:** queued, and played when this change lands. A
 *   frame of the change in the air is not a frame of any lens, so there is
 *   nothing to start a *different* change from without a jump.
 */
export function retargetLens(
  state: LensClockState,
  target: number,
): LensClockState & { run: boolean } {
  'worklet';
  if (state.t >= 1) {
    if (target === state.to) {
      return { ...state, from: state.to, next: -1, run: false };
    }
    return { from: state.to, to: target, t: 0, next: -1, run: true };
  }
  if (target === state.to) return { ...state, next: -1, run: false };
  if (target === state.from) {
    return {
      from: state.to,
      to: state.from,
      t: 1 - state.t,
      next: -1,
      run: true,
    };
  }
  return { ...state, next: target, run: false };
}

/**
 * How much of one lens is showing, 0..1: `t` of the lens being changed to,
 * `1 − t` of the one being left, all of a lens at rest, none of any other.
 */
export function lensWeight(
  lens: number,
  from: number,
  to: number,
  t: number,
): number {
  'worklet';
  if (from === to) return lens === to ? 1 : 0;
  if (lens === to) return t;
  if (lens === from) return 1 - t;
  return 0;
}

/** KNOBS — how the lens clock runs. */
export const LENS_CLOCK_KNOBS = {
  /**
   * Frames a change waits before it moves. Asking for a lens is a React
   * commit, and the frame after it is often a long one (the field re-records
   * its faces: ~150 ms on the Xiaomi); a clock already running then lands a
   * third of the morph at once. Waiting it out, the morph starts after it.
   */
  SETTLE_FRAMES: 2,
  /**
   * The most of the morph one frame may take, however late it came: two
   * frames' worth, so a field drawn at thirty a second keeps the morph's
   * length and only a stall is held — the step's clock's rule.
   */
  FRAME_CAP_MS: 1000 / 30,
} as const;

/**
 * The clock for the lens at `index`, owned for the component's life.
 *
 * `from`, `to` and `t` are written together on the UI thread, so the canvas
 * never draws a frame with a new `to` and the old `t`. The Jest mock of
 * Reanimated lands a timing at once and runs no reactions, so under test a
 * change lands on the commit that asks for it.
 */
export function useLensClock(index: number): LensClock {
  const fromCandidate = useSharedValue(index);
  const toCandidate = useSharedValue(index);
  const tCandidate = useSharedValue(1);
  const nextCandidate = useSharedValue(-1);
  // Native shared values are stable; the Jest mock is not, so each is held by
  // ref the way `useFieldCamera` holds its own candidates.
  const from = useRef(fromCandidate).current;
  const to = useRef(toCandidate).current;
  const t = useRef(tCandidate).current;
  const next = useRef(nextCandidate).current;
  const clock = useRef<LensClock>({ from, to, t, next }).current;
  /** Frames waited since the change began; see `SETTLE_FRAMES`. */
  const settledCandidate = useSharedValue(0);
  const settled = useRef(settledCandidate).current;

  /*
   * The clock moves a frame at a time, capped, while a change is in the air:
   * it cannot jump, so a stall holds the morph rather than skipping it. Where
   * there are no frames to count (Reanimated's Jest mock, whose callback id
   * is -1) it runs on a timing, which the mock lands at once.
   */
  const tick = useFrameCallback(info => {
    'worklet';
    if (t.value >= 1) return;
    if (settled.value < LENS_CLOCK_KNOBS.SETTLE_FRAMES) {
      settled.value += 1;
      return;
    }
    const dt = Math.min(
      info.timeSincePreviousFrame ?? LENS_CLOCK_KNOBS.FRAME_CAP_MS,
      LENS_CLOCK_KNOBS.FRAME_CAP_MS,
    );
    t.value = Math.min(1, t.value + dt / SEAL_PLAYER_KNOBS.LENS_MORPH_MS);
  }, false);
  const counted = tick.callbackId >= 0;
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (counted) tick.setActive(ticking);
  }, [counted, tick, ticking]);
  useAnimatedReaction(
    () => t.value < 1,
    (on, was) => {
      if (on !== was) runOnJS(setTicking)(on);
    },
  );

  /** Run the clock from `from`; `settle` waits out the commit's frame first. */
  const run = (start: number, settle: boolean) => {
    'worklet';
    if (counted) {
      settled.value = settle ? 0 : LENS_CLOCK_KNOBS.SETTLE_FRAMES;
      t.value = start;
      return;
    }
    t.value = start;
    t.value = withTiming(1, {
      duration: SEAL_PLAYER_KNOBS.LENS_MORPH_MS,
      easing: Easing.linear,
    });
  };

  useEffect(() => {
    const target = index;
    runOnUI(() => {
      'worklet';
      const moved = retargetLens(
        { from: from.value, to: to.value, t: t.value, next: next.value },
        target,
      );
      from.value = moved.from;
      to.value = moved.to;
      next.value = moved.next;
      // A reversal goes on from the frame it is at; a new change waits out
      // the commit that asked for it.
      if (moved.run) run(moved.t, moved.t === 0);
    })();
    // `run` reads only shared values and a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, index, next, t, to]);

  // A queued lens starts the frame the change in the air lands.
  useAnimatedReaction(
    () => t.value >= 1,
    landed => {
      if (!landed || next.value < 0) return;
      const target = next.value;
      next.value = -1;
      from.value = to.value;
      to.value = target;
      // Queued: no commit to wait out, it starts the frame the last lands.
      run(0, false);
    },
  );

  return clock;
}
