import type { FlightOwnership } from '../../field';

/**
 * How much of a mark or a name this generation has handed over.
 *
 * The ownership windows are the transition engine's, not the camera's: a mark
 * that branches appears early in the cut and one that folds leaves late, so
 * two copies of the same song are never both solid at once.
 */
export function flightOwnerAlpha(
  ownership: FlightOwnership,
  fromAlpha: number,
  targetAlpha: number,
  progress: number,
): number {
  'worklet';
  let start = 0;
  let end = 1;
  if (ownership === 'branch') {
    start = 0.02;
    end = 0.18;
  } else if (ownership === 'fold') {
    start = 0.55;
    end = 0.82;
  } else if (ownership === 'enter') {
    start = 0.08;
    end = 0.42;
  } else if (ownership === 'exit') {
    start = 0.58;
    end = 0.9;
  }
  const raw =
    ownership === 'carry' ? progress : (progress - start) / (end - start);
  const t = Math.min(Math.max(raw, 0), 1);
  const amount = t * t * t * (t * (t * 6 - 15) + 10);
  return fromAlpha + (targetAlpha - fromAlpha) * amount;
}
