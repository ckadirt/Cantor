import { sameTrack, type PlayerSnapshot } from './types';

// knobs
const SNAP_SECONDS = 0.25; // an error past this jumps; under it the clock slews (under a beat at 240 BPM)
const DEADBAND_SECONDS = 0.004; // errors under this are the measurement's own jitter, left alone
const SLEW_RATE = 0.05; // the most the clock's speed may differ from the song's while it catches up
const SLEW_MIN_MS = 400; // the shortest correction, so a small one is never a twitch

/**
 * The visual clock on the UI thread: where the song is heard, as a line.
 *
 * `position` is the song's second at `at`, a UI-thread monotonic time in
 * milliseconds (a frame callback's `timestamp` and the worklet runtime's
 * `performance.now()` share it). From `at` the clock runs at `rate` until
 * `until`, then at the song's own speed, and never past `end`. Before `at` it
 * holds `position`: a clock started ahead of time waits for the sound to arrive
 * rather than running backwards to meet it.
 *
 * A plain object so a worklet can hold it in one shared value, and so every
 * frame is a pure function of it and the frame's time.
 */
export type ClockAnchor = Readonly<{
  position: number;
  at: number;
  rate: number;
  until: number;
  running: boolean;
  end: number;
}>;

export const HELD_AT_ZERO: ClockAnchor = {
  position: 0,
  at: 0,
  rate: 1,
  until: 0,
  running: false,
  end: 0,
};

/** The clock's reading at UI time `now`. */
export function clockAt(anchor: ClockAnchor, now: number): number {
  'worklet';
  if (!anchor.running || now <= anchor.at) return Math.min(anchor.position, anchor.end);
  const slewEnd = Math.max(anchor.at, anchor.until);
  const slewMs = Math.min(now, slewEnd) - anchor.at;
  const plainMs = Math.max(0, now - slewEnd);
  return Math.min(anchor.end, anchor.position + (slewMs * anchor.rate + plainMs) / 1000);
}

/** A clock standing still at `position`. */
export function holdClock(position: number, end: number): ClockAnchor {
  'worklet';
  return { position, at: 0, rate: 1, until: 0, running: false, end };
}

/**
 * A clock that runs from `rendered`, the position the audio thread has just
 * handed to the output, once `latencySeconds` have passed — when that sound
 * reaches the air. Until then it holds, so a start or a seek never steps back.
 */
export function runClock(
  rendered: number,
  now: number,
  latencySeconds: number,
  end: number,
): ClockAnchor {
  'worklet';
  return {
    position: rendered,
    at: now + latencySeconds * 1000,
    rate: 1,
    until: 0,
    running: true,
    end,
  };
}

/**
 * Bring a running clock into line with `heard`, the song's second in the air
 * at UI time `now`.
 *
 * A small error is never a jump: every envelope on screen is a function of
 * this clock, so a jump is a pop of all of them at once. Instead the clock runs
 * a few percent fast or slow until it agrees, which no eye reads as anything.
 * An error past `SNAP_SECONDS` is not drift but a discontinuity the port did
 * not announce, and jumping is then the honest answer.
 */
export function slewClock(anchor: ClockAnchor, now: number, heard: number): ClockAnchor {
  'worklet';
  if (!anchor.running) return anchor;
  const current = clockAt(anchor, now);
  const error = heard - current;
  if (Math.abs(error) > SNAP_SECONDS) {
    return { position: heard, at: now, rate: 1, until: 0, running: true, end: anchor.end };
  }
  // A clock still waiting for its sound to arrive has nothing to correct yet.
  if (now < anchor.at || Math.abs(error) < DEADBAND_SECONDS) return anchor;
  const ms = Math.max(SLEW_MIN_MS, (Math.abs(error) / SLEW_RATE) * 1000);
  return {
    position: current,
    at: now,
    rate: 1 + error / (ms / 1000),
    until: now + ms,
    running: true,
    end: anchor.end,
  };
}

/**
 * What the visual clock should do with a freshly published snapshot.
 *
 * `run` and `hold` are discrete: the clock is set, not corrected — a track
 * change, a state change, a seek. `slew` is the steady case while a song plays:
 * the port has published a position, and the running clock is nudged toward
 * it. Under reduced motion (`continuous` false) the clock steps: it holds at
 * every published position instead of running between them.
 */
export type ClockPlan =
  | { kind: 'keep' }
  | { kind: 'hold'; atSeconds: number }
  | { kind: 'run'; fromSeconds: number }
  | { kind: 'slew' };

export function planVisualClock(
  previous: PlayerSnapshot | null,
  next: PlayerSnapshot,
  continuous = true,
): ClockPlan {
  const discrete =
    previous === null ||
    previous.state !== next.state ||
    previous.durationSeconds !== next.durationSeconds ||
    !sameTrack(previous.track, next.track);
  const playing =
    next.state === 'playing' && next.positionSeconds < next.durationSeconds;

  if (!playing || !continuous) {
    if (!discrete && previous !== null && previous.positionSeconds === next.positionSeconds) {
      return { kind: 'keep' };
    }
    return { kind: 'hold', atSeconds: next.positionSeconds };
  }
  if (discrete) return { kind: 'run', fromSeconds: next.positionSeconds };
  return { kind: 'slew' };
}

export const VISUAL_CLOCK_KNOBS = {
  SNAP_SECONDS,
  DEADBAND_SECONDS,
  SLEW_RATE,
  SLEW_MIN_MS,
} as const;
