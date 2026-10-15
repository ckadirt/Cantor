/**
 * The pitch of a sung or hummed frame, for drawing a tune as a line.
 *
 * YIN (de Cheveigné & Kawahara, 2002): the cumulative-mean-normalised
 * difference function, its first dip under a threshold, and a parabola through
 * that dip for sub-sample accuracy. Pure and allocation-light, because it runs
 * on every buffer the recorder hands over.
 *
 * A frame that is not voiced (a breath, silence, a consonant) is `null`: the
 * line lifts off the paper there rather than inventing a note.
 */

/** KNOBS */
export const PITCH_KNOBS = {
  /** The lowest and highest pitch a voice or a whistle is read as, in Hz. */
  MIN_HZ: 70,
  MAX_HZ: 1400,
  /** YIN's dip threshold: lower is stricter about calling a frame voiced. */
  THRESHOLD: 0.15,
  /** Below this RMS a frame is silence, whatever its shape. */
  SILENCE_RMS: 0.01,
} as const;

export type PitchFrame = Readonly<{ hz: number; clarity: number }>;

/** The pitch of one frame of mono samples at `rate`, or null if unvoiced. */
export function detectPitch(
  samples: Float32Array,
  rate: number,
): PitchFrame | null {
  const length = samples.length;
  let energy = 0;
  for (let i = 0; i < length; i += 1) energy += samples[i] * samples[i];
  if (Math.sqrt(energy / Math.max(1, length)) < PITCH_KNOBS.SILENCE_RMS)
    return null;

  const minTau = Math.max(2, Math.floor(rate / PITCH_KNOBS.MAX_HZ));
  const maxTau = Math.min(
    Math.floor(length / 2),
    Math.ceil(rate / PITCH_KNOBS.MIN_HZ),
  );
  if (maxTau <= minTau + 2) return null;
  const window = length - maxTau;

  // Difference function, then its cumulative mean normalisation.
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let i = 0; i < window; i += 1) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  let running = 0;
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += d[tau];
    cmnd[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }

  // The first dip under the threshold, walked down to its floor.
  let tau = minTau;
  for (; tau <= maxTau; tau += 1) {
    if (cmnd[tau] < PITCH_KNOBS.THRESHOLD) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau += 1;
      break;
    }
  }
  if (tau > maxTau) return null;

  // A parabola through the dip and its neighbours.
  const left = cmnd[tau - 1];
  const middle = cmnd[tau];
  const right = tau + 1 <= maxTau ? cmnd[tau + 1] : middle;
  const curve = left + right - 2 * middle;
  const shift = curve === 0 ? 0 : (left - right) / (2 * curve);
  const period = tau + Math.max(-1, Math.min(1, shift));
  const hz = rate / period;
  if (hz < PITCH_KNOBS.MIN_HZ || hz > PITCH_KNOBS.MAX_HZ) return null;
  return { hz, clarity: 1 - middle };
}

/** Semitones above A4 (440 Hz), the unit the line is drawn in. */
export function semitones(hz: number): number {
  return 12 * Math.log2(hz / 440);
}

/**
 * The middle of a take's voiced pitches, so the line can be drawn centred on
 * the tune rather than on a fixed note.
 */
export function medianSemitone(
  points: readonly (number | null)[],
): number | null {
  const voiced = points
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  if (voiced.length === 0) return null;
  return voiced[Math.floor(voiced.length / 2)];
}
