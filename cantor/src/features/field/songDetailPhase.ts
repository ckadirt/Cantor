import { REPRESENTATION_WINDOWS, smootherstep } from '../../field/bands';

/** Retain the drawn measurement through departure; reset only while hidden. */
export function songDetailPhase(ratio: number): 'hidden' | 'hold' | 'reveal' {
  'worklet';
  if (ratio <= REPRESENTATION_WINDOWS.song[0]) return 'hidden';
  if (ratio >= REPRESENTATION_WINDOWS.song[1]) return 'reveal';
  return 'hold';
}

/** The entry window stays open at L3, where the measurement becomes grain. */
export function songDetailOpacity(ratio: number): number {
  'worklet';
  const [start, end] = REPRESENTATION_WINDOWS.song;
  return smootherstep((ratio - start) / (end - start));
}
