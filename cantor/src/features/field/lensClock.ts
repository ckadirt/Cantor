import { useEffect, useRef } from 'react';
import {
  Easing,
  runOnUI,
  useAnimatedReaction,
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
      if (moved.run) {
        t.value = moved.t;
        t.value = withTiming(1, {
          duration: SEAL_PLAYER_KNOBS.LENS_MORPH_MS,
          easing: Easing.linear,
        });
      }
    })();
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
      t.value = 0;
      t.value = withTiming(1, {
        duration: SEAL_PLAYER_KNOBS.LENS_MORPH_MS,
        easing: Easing.linear,
      });
    },
  );

  return clock;
}
