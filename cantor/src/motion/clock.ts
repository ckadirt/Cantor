/**
 * Transition-scoped clocks. Each built transition gets its own shared value,
 * *born* at its starting point — the UI thread can never paint a new tree
 * against a stale clock from the previous transition, which is exactly the
 * one-frame "finished state flashes before the morph" race that a reused
 * clock + render-phase reset suffered from.
 */
import { makeMutable, type SharedValue } from 'react-native-reanimated';

export function bornClock(v: number): SharedValue<number> {
  const m = makeMutable(v) as SharedValue<number> | number;
  // reanimated's jest mock returns the primitive; wrap so reads stay safe
  return typeof m === 'number' ? ({ value: m } as SharedValue<number>) : m;
}
