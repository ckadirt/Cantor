import { LENS_INTERVALS } from './cantorIntervals';

/** KNOBS — screen pixels, except gain and ratios. */
export const WAVE_GEOMETRY_KNOBS = {
  MORPH_MS: 420,
  MARK_WIDTH_PX: 22,
  MARK_HEIGHT_PX: 12,
  ROW_WIDTH_PX: 76,
  ROW_HEIGHT_PX: 22,
  SONG_WIDTH_RATIO: 0.72,
  SONG_HEIGHT_RATIO: 0.24,
  MIN_BAR_PX: 0.6,
  LEVEL_GAIN: 2.6,
} as const;

/** Interval positions remain temporal: silence and the middle thirds stay gaps. */
export function waveBar(
  index: number,
  level: number,
  width: number,
  height: number,
) {
  'worklet';
  const interval = LENS_INTERVALS[index];
  const barWidth = Math.max(
    WAVE_GEOMETRY_KNOBS.MIN_BAR_PX,
    (interval.end - interval.start) * width,
  );
  const barHeight = Math.max(
    WAVE_GEOMETRY_KNOBS.MIN_BAR_PX,
    Math.min(1, Math.max(0, level) * WAVE_GEOMETRY_KNOBS.LEVEL_GAIN) * height,
  );
  return {
    x: ((interval.start + interval.end) / 2 - 0.5) * width - barWidth / 2,
    y: -barHeight / 2,
    width: barWidth,
    height: barHeight,
  };
}
