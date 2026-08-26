/**
 * L3: the camera scale *is* the scrubber.
 *
 * Past the song level, zooming stops moving through the library and starts
 * moving into one song: the visible slice of audio shrinks continuously as
 * scale grows. That is the whole idea of the level, so the relationship between
 * scale and visible duration is arithmetic rather than a gesture handler.
 */

/** KNOBS — the visible window, in real units. */
export const GRAIN_KNOBS = {
  /** Scale ratio at which L3 begins; matches `LEVEL_BOUNDARIES.song`. */
  ENTRY_RATIO: 170,
  /** Seconds visible the moment L3 is entered. */
  ENTRY_SECONDS: 12,
  /** The closest look: below this, bars stop being samples and start being noise. */
  MIN_SECONDS: 0.02,
  /** Never show more than this at L3, however far out the camera drifts. */
  MAX_SECONDS: 60,
  /** Columns per screen pixel. One is plenty; more is decoded for nothing. */
  COLUMNS_PER_PIXEL: 1,
  MIN_COLUMNS: 64,
  MAX_COLUMNS: 2048,
} as const;

export type GrainWindow = Readonly<{
  startSeconds: number;
  endSeconds: number;
  centerSeconds: number;
  visibleSeconds: number;
}>;

/**
 * How much audio is visible at a camera scale.
 *
 * Halving the visible span for every doubling of scale keeps the mapping
 * continuous and reversible, so a pinch has the same meaning wherever it starts.
 */
export function visibleSecondsAt(scale: number, fitScale: number): number {
  assertPositive(scale, 'Camera scale');
  assertPositive(fitScale, 'Fitted scale');
  const ratio = scale / fitScale;
  const beyond = Math.max(ratio, GRAIN_KNOBS.ENTRY_RATIO) / GRAIN_KNOBS.ENTRY_RATIO;
  return clamp(
    GRAIN_KNOBS.ENTRY_SECONDS / beyond,
    GRAIN_KNOBS.MIN_SECONDS,
    GRAIN_KNOBS.MAX_SECONDS,
  );
}

/** The inverse: the scale that shows exactly this much audio. */
export function scaleForVisibleSeconds(
  seconds: number,
  fitScale: number,
): number {
  assertPositive(fitScale, 'Fitted scale');
  const wanted = clamp(seconds, GRAIN_KNOBS.MIN_SECONDS, GRAIN_KNOBS.MAX_SECONDS);
  return (
    fitScale *
    GRAIN_KNOBS.ENTRY_RATIO *
    (GRAIN_KNOBS.ENTRY_SECONDS / wanted)
  );
}

/**
 * The window centred on `centerSeconds`, clamped inside the track.
 *
 * At the boundaries the window slides rather than shrinks: the centre moves off
 * the midpoint so the visible span stays the span the scale asked for, which is
 * what keeps zooming continuous at the very start and end of a song.
 */
export function grainWindow(
  centerSeconds: number,
  visibleSeconds: number,
  durationSeconds: number,
): GrainWindow {
  const duration = Math.max(0, durationSeconds);
  const visible = clamp(visibleSeconds, GRAIN_KNOBS.MIN_SECONDS, Math.max(GRAIN_KNOBS.MIN_SECONDS, duration || GRAIN_KNOBS.MAX_SECONDS));
  const half = visible / 2;
  let start = clamp(centerSeconds - half, 0, Math.max(0, duration - visible));
  if (duration <= visible) start = 0;
  const end = Math.min(duration === 0 ? visible : duration, start + visible);
  return {
    startSeconds: start,
    endSeconds: end,
    centerSeconds: clamp(centerSeconds, 0, duration),
    visibleSeconds: end - start,
  };
}

/**
 * Zoom around a timestamp, keeping it under the fingers.
 *
 * Returns the new centre. Without this a pinch drifts: the audio under the
 * fingers slides away as the span changes, which reads as the song moving
 * rather than the view.
 */
export function centerForFocalZoom(
  focalSeconds: number,
  focalFraction: number,
  nextVisibleSeconds: number,
): number {
  const fraction = clamp(focalFraction, 0, 1);
  return focalSeconds + (0.5 - fraction) * nextVisibleSeconds;
}

/** Seconds at a horizontal position across the window, 0..1 from its left edge. */
export function timeAtFraction(window: GrainWindow, fraction: number): number {
  return (
    window.startSeconds +
    clamp(fraction, 0, 1) * (window.endSeconds - window.startSeconds)
  );
}

/**
 * Columns to ask the decoder for.
 *
 * Bounded on both sides: one column per pixel is all a screen can show, and a
 * floor keeps a very close look from asking for so few that the shape collapses.
 */
export function columnsFor(viewportWidthPx: number): number {
  const wanted = Math.round(viewportWidthPx * GRAIN_KNOBS.COLUMNS_PER_PIXEL);
  return Math.round(
    clamp(wanted, GRAIN_KNOBS.MIN_COLUMNS, GRAIN_KNOBS.MAX_COLUMNS),
  );
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive number.`);
  }
}
