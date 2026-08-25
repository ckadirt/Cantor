import { sameTrack, type PlayerSnapshot } from './types';

// knobs
const DRIFT_TOLERANCE_SECONDS = 0.35; // how far the visual clock may wander before it is pulled back

/**
 * What the visual position clock should do next.
 *
 * `keep` is the common case and the whole point: while a track plays normally,
 * position snapshots arrive several times a second and the clock should be left
 * alone to run. Restarting an animation on every snapshot would be a stutter,
 * and polling native position at frame rate is what this design exists to avoid.
 */
export type ClockPlan =
  | { kind: 'keep' }
  | { kind: 'hold'; atSeconds: number }
  | { kind: 'run'; fromSeconds: number; toSeconds: number; durationMs: number };

/**
 * Decide how to reconcile the running clock with a freshly published snapshot.
 *
 * Kept pure and separate from the hook so the resync rule — the part that is
 * easy to get subtly wrong — is testable without a UI thread.
 *
 * @param previous the last snapshot this clock reconciled against, or null
 * @param next the snapshot just published by the port
 * @param clockSeconds where the visual clock has currently drifted to
 * @param continuous false under reduced motion, where the clock steps instead
 */
export function planVisualClock(
  previous: PlayerSnapshot | null,
  next: PlayerSnapshot,
  clockSeconds: number,
  continuous = true,
): ClockPlan {
  const discrete =
    previous === null ||
    previous.state !== next.state ||
    previous.durationSeconds !== next.durationSeconds ||
    !sameTrack(previous.track, next.track);

  const playing = next.state === 'playing';
  const remainingMs = Math.max(
    0,
    (next.durationSeconds - next.positionSeconds) * 1000,
  );

  // A track that is not playing has a fixed position; the clock only needs to
  // agree with it.
  if (!playing || !continuous || remainingMs === 0) {
    if (!discrete && Math.abs(clockSeconds - next.positionSeconds) <= DRIFT_TOLERANCE_SECONDS) {
      return { kind: 'keep' };
    }
    return { kind: 'hold', atSeconds: next.positionSeconds };
  }

  // Playing: run to the end of the track in real time, and only re-anchor when
  // something discrete happened or the clock has genuinely drifted.
  if (
    !discrete &&
    Math.abs(clockSeconds - next.positionSeconds) <= DRIFT_TOLERANCE_SECONDS
  ) {
    return { kind: 'keep' };
  }

  return {
    kind: 'run',
    fromSeconds: next.positionSeconds,
    toSeconds: next.durationSeconds,
    durationMs: remainingMs,
  };
}

export const VISUAL_CLOCK_DRIFT_TOLERANCE_SECONDS = DRIFT_TOLERANCE_SECONDS;
