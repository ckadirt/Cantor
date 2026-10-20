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

/** KNOBS — how loud a frame reads, so the measure shows it hears an untuned sound. */
export const LEVEL_KNOBS = {
  /** RMS in decibels read as nothing, and as full. */
  FLOOR_DB: -50,
  CEILING_DB: -12,
} as const;

/**
 * How loud a frame is, 0..1 on a decibel scale: a hum that never settles on a
 * pitch still shows as sound arriving, so a quiet or wavering voice is not
 * mistaken for a microphone that is not listening.
 */
export function frameLevel(samples: Float32Array): number {
  const length = samples.length;
  if (length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < length; i += 1) energy += samples[i] * samples[i];
  const rms = Math.sqrt(energy / length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const { FLOOR_DB, CEILING_DB } = LEVEL_KNOBS;
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

/** Semitones above A4 (440 Hz), the unit the line is drawn in. */
export function semitones(hz: number): number {
  return 12 * Math.log2(hz / 440);
}

/** KNOBS — reading a take's frames as a line rather than as scattered marks. */
export const STEADY_KNOBS = {
  /** Voiced neighbours each side a frame is weighed against. */
  NEIGHBOURS: 2,
  /** Further than this from its neighbours' median, a frame is a misread (most often an octave). */
  OUTLIER_SEMITONES: 5,
  /** Unvoiced gaps this short between two voiced frames are a dropout, not a breath. */
  BRIDGE_FRAMES: 2,
  /** Voiced runs shorter than this are noise, not a note. */
  MIN_RUN_FRAMES: 3,
} as const;

/**
 * A take's pitch frames made fit to draw: a frame far from its neighbours is
 * pulled to their median (YIN's octave slips), a dropout of a frame or two
 * between voiced frames is bridged, and a voiced run too short to be a note
 * is lifted off. Only the drawing reads this; the frames themselves are kept.
 */
export function steadyPitch(
  values: readonly (number | null)[],
): (number | null)[] {
  const out = values.slice();
  const voiced: number[] = [];
  values.forEach((value, index) => {
    if (value !== null) voiced.push(index);
  });

  // Octave slips: compare each voiced frame with its voiced neighbours.
  voiced.forEach((index, k) => {
    const near: number[] = [];
    for (
      let j = Math.max(0, k - STEADY_KNOBS.NEIGHBOURS);
      j <= Math.min(voiced.length - 1, k + STEADY_KNOBS.NEIGHBOURS);
      j += 1
    ) {
      near.push(values[voiced[j]] as number);
    }
    near.sort((a, b) => a - b);
    const median = near[Math.floor(near.length / 2)];
    if (
      Math.abs((values[index] as number) - median) >
      STEADY_KNOBS.OUTLIER_SEMITONES
    )
      out[index] = median;
  });

  // Dropouts: a short unvoiced gap between voiced frames is drawn through.
  for (let k = 1; k < voiced.length; k += 1) {
    const from = voiced[k - 1];
    const to = voiced[k];
    const gap = to - from - 1;
    if (gap < 1 || gap > STEADY_KNOBS.BRIDGE_FRAMES) continue;
    const a = out[from] as number;
    const b = out[to] as number;
    for (let i = from + 1; i < to; i += 1)
      out[i] = a + ((b - a) * (i - from)) / (to - from);
  }

  // Specks: a voiced run too short to be a note.
  let start = 0;
  for (let i = 0; i <= out.length; i += 1) {
    if (i < out.length && out[i] !== null) continue;
    if (i - start < STEADY_KNOBS.MIN_RUN_FRAMES)
      for (let j = start; j < i; j += 1) out[j] = null;
    start = i + 1;
  }
  return out;
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
