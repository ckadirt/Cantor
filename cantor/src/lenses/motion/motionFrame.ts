import type { MotionSection, MotionTrack } from './motionTrack';

/**
 * The music at one moment, as the few numbers a lens draws with.
 *
 * A pure function of the track and the playhead — no state, no springs — so a
 * seek, a scrub or reduced motion lands on the right frame, and a hit may rise
 * before it sounds: the attack kernel looks ahead. A port of the reference
 * page's `features`, `beatAt`, `recent`, `tensionAt` and `structureAt`
 * (docs/interfacealpha/reactive-player.html); its numbers are checked against
 * the page's own in `__tests__/motionFrame.test.ts`.
 *
 * Lenses see only this, never the track or the clock: a lens stays what a song
 * looks like, and the renderer stays where and when.
 */
export type MotionFrame = {
  /** The playhead, seconds. */
  t: number;
  /** Overall gain: the knob times the section's intensity (~0.25..1). */
  g: number;
  /** Envelopes, 0..1: low (kick, bass), mid (snare, voice), high (hats, air), each beat, each downbeat. */
  low: number;
  mid: number;
  high: number;
  beat: number;
  down: number;
  /** Loudness over ~80 ms, 0..1. */
  loud: number;
  /** How far through the song, 0..1. */
  head: number;
  /** The beat we are in, how far through it (0 on it, 1 on the next), and its length in seconds. */
  beatIndex: number;
  beatPhase: number;
  beatPeriod: number;
  /** How sure the beat grid is, 0..1: beat-locked gestures scale by it. */
  beatSure: number;
  /**
   * Where the song is in its form, or −1 for a song too short to have one.
   * `into` is in beats from the section's start; `prevLabel` and
   * `prevLength` (beats) are the section before, −1 and 0 for the first.
   */
  section: number;
  label: number;
  into: number;
  prevLabel: number;
  prevLength: number;
  /** A drop's build (0..1, rising into it) and its release (over the bar after). */
  tension: number;
  release: number;
  /**
   * Where this moment first played, in seconds, for every earlier section
   * with this one's letter that is still as long as we are into this one.
   */
  echoes: number[];
  /** Low and mid onsets of the last 1.4 s (and the next few ms): age in seconds, strength, band. */
  ripples: Ripple[];
  /** High onsets of the last 0.5 s: their index in the track (a seed), age, strength. */
  hats: Hat[];
  /** The song's sections, the same array every frame: the seal draws them on its thread. */
  sections: readonly MotionSection[];
};

export type Ripple = { age: number; s: number; band: number };
export type Hat = { index: number; age: number; s: number };

// knobs — the page's shipping values (reactive-player-plan.md, "The shipping numbers")
export const MOTION_KNOBS = {
  GAIN: 1,
  ATTACK_S: 0.025,
  RELEASE_S: 0.26,
  /** The high band's attack and release, as a share of the others'. */
  HIGH_ATTACK: 0.6,
  HIGH_RELEASE: 0.5,
  /** A downbeat's release, as a share of a beat's. */
  DOWN_RELEASE: 1.6,
  /** How much the section's intensity scales everything. */
  SECTIONS: 0.55,
  RIPPLE_LIFE_S: 1.4,
  HAT_LIFE_S: 0.5,
  /** Below this confidence the grid is a guess; beat-locked motion is off by its floor. */
  SURE_FROM: 0.2,
  SURE_TO: 0.6,
} as const;

function clamp01(x: number): number {
  'worklet';
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function smoothstep(x: number): number {
  'worklet';
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}
export function smootherstep(x: number): number {
  'worklet';
  const c = clamp01(x);
  return c * c * c * (c * (6 * c - 15) + 10);
}

/** The first index whose value is at least `x`, in an ascending list. */
function lowerBound(list: readonly number[], x: number): number {
  'worklet';
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The page's `kernel`: smoothstep up over the attack, 1 − smootherstep down over the release, in hops. */
function kernel(d: number, attack: number, release: number): number {
  'worklet';
  return d < 0 ? (attack <= 0 ? 0 : smoothstep(1 + d / attack)) : 1 - smootherstep(d / release);
}

/**
 * The page's envelope at hop `i`: the strongest event's kernel there. Events
 * are hop-aligned times; `strengths` null means every event is 1.
 */
function envelopeAt(
  times: readonly number[],
  strengths: readonly number[] | null,
  only: readonly number[] | null,
  i: number,
  fps: number,
  attackS: number,
  releaseS: number,
): number {
  'worklet';
  const A = Math.round(attackS * fps);
  const R = Math.max(1, Math.round(releaseS * fps));
  let out = 0;
  for (let k = lowerBound(times, (i - R - 0.5) / fps); k < times.length; k++) {
    const f = Math.round(times[k] * fps);
    if (f > i + A) break;
    if (only !== null && only[k] !== 1) continue;
    const v = (strengths === null ? 1 : strengths[k]) * kernel(i - f, A, R);
    if (v > out) out = v;
  }
  return out;
}

/**
 * The page's `sample` of a baked envelope: hop-exact values, linear between
 * hops, the last hop's value from the last hop on.
 */
function envelope(
  times: readonly number[],
  strengths: readonly number[] | null,
  only: readonly number[] | null,
  t: number,
  fps: number,
  attackS: number,
  releaseS: number,
  last: number,
): number {
  'worklet';
  const x = t * fps;
  const i = Math.floor(x);
  if (i < 0) return 0;
  if (i >= last) return envelopeAt(times, strengths, only, last, fps, attackS, releaseS);
  const a = envelopeAt(times, strengths, only, i, fps, attackS, releaseS);
  const b = envelopeAt(times, strengths, only, i + 1, fps, attackS, releaseS);
  return a + (b - a) * (x - i);
}

/** A curve sampled every `step` seconds from 0, read linearly. */
function curveAt(values: readonly number[], step: number, t: number): number {
  'worklet';
  if (values.length === 0) return 0;
  const x = t / step;
  const i = Math.floor(x);
  if (i < 0) return values[0];
  if (i >= values.length - 1) return values[values.length - 1];
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

/** The time of fractional beat `x`: the page's `beatTime`. */
function beatTime(track: MotionTrack, x: number): number {
  'worklet';
  const beats = track.beats;
  const i = Math.max(0, Math.min(beats.length - 1, Math.floor(x)));
  const t0 = beats[i];
  const t1 = i + 1 < beats.length ? beats[i + 1] : t0 + 60 / track.bpm;
  return t0 + (t1 - t0) * (x - i);
}

/**
 * The frame at playhead `t`. `transient` (0..1) scales what sounds — the
 * envelopes, ripples, hats — and leaves the form alone: it is how a pause or a
 * scrub lets the kicks settle without the song forgetting where it is.
 */
export function motionFrameAt(track: MotionTrack, t: number, transient = 1): MotionFrame {
  'worklet';
  const K = MOTION_KNOBS;
  const fps = track.fps;
  const beats = track.beats;
  const intensity = curveAt(track.intensity, track.intensityStep, t);
  const g = K.GAIN * (1 - K.SECTIONS + K.SECTIONS * (0.25 + 0.75 * intensity));
  // The last analysis hop: the page's arrays end there.
  const last = Math.floor(track.duration * fps + 1e-6) - 1;
  const beatSure = smoothstep((track.confidence - K.SURE_FROM) / (K.SURE_TO - K.SURE_FROM));

  // The beat we are in.
  let beatIndex = 0;
  let beatPhase = 0;
  let beatPeriod = 60 / track.bpm;
  if (beats.length > 0 && t >= beats[0]) {
    let lo = 0;
    let hi = beats.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (beats[m] <= t) lo = m;
      else hi = m - 1;
    }
    beatIndex = lo;
    if (lo + 1 < beats.length) beatPeriod = beats[lo + 1] - beats[lo];
    beatPhase = clamp01((t - beats[lo]) / beatPeriod);
  }

  const on = track.onsets;
  const low = envelope(on[0].t, on[0].s, null, t, fps, K.ATTACK_S, K.RELEASE_S, last) * transient;
  const mid = envelope(on[1].t, on[1].s, null, t, fps, K.ATTACK_S, K.RELEASE_S, last) * transient;
  const high =
    envelope(on[2].t, on[2].s, null, t, fps, K.ATTACK_S * K.HIGH_ATTACK, K.RELEASE_S * K.HIGH_RELEASE, last) *
    transient;
  const beat = envelope(beats, null, null, t, fps, K.ATTACK_S, K.RELEASE_S, last) * transient * beatSure;
  const down =
    envelope(beats, null, track.downs, t, fps, K.ATTACK_S, K.RELEASE_S * K.DOWN_RELEASE, last) *
    transient *
    beatSure;

  // A drop's build and release.
  let tension = 0;
  let release = 0;
  for (let i = 0; i < track.drops.length; i++) {
    const d = track.drops[i];
    const u = t - d.t;
    if (u < 0 && t >= d.from) {
      tension = Math.max(tension, smootherstep((t - d.from) / Math.max(0.1, d.t - d.from)) * d.strength);
    } else if (u >= 0 && u < d.bar + 0.12) {
      tension = Math.max(tension, (1 - smootherstep(u / 0.12)) * d.strength);
      release = Math.max(
        release,
        Math.min(smoothstep(u / 0.12), 1 - smootherstep((u - 0.12) / d.bar)) * d.strength,
      );
    }
  }

  // Where the song is in its form.
  const sections = track.sections;
  let section = -1;
  let label = -1;
  let into = 0;
  let prevLabel = -1;
  let prevLength = 0;
  const echoes: number[] = [];
  if (sections.length > 0 && beats.length > 0) {
    const fb = t < beats[0] ? 0 : beatIndex + beatPhase;
    let si = 0;
    while (si + 1 < sections.length && sections[si + 1].a <= beatIndex) si++;
    const seg = sections[si];
    section = si;
    label = seg.label;
    into = fb - seg.a;
    if (si > 0) {
      prevLabel = sections[si - 1].label;
      prevLength = seg.a - sections[si - 1].a;
    }
    for (let j = 0; j < si && echoes.length < 4; j++) {
      const other = sections[j];
      if (other.label !== seg.label || into >= other.z - other.a) continue;
      echoes.push(beatTime(track, other.a + into));
    }
  }

  // Recent onsets: the circle's ripples (low, mid) and the seal's hats (high).
  const ripples: Ripple[] = [];
  const hats: Hat[] = [];
  if (transient > 0) {
    for (let band = 0; band < 2; band++) {
      const list = on[band];
      for (let k = lowerBound(list.t, t - K.RIPPLE_LIFE_S); k < list.t.length && list.t[k] <= t + K.ATTACK_S; k++) {
        ripples.push({ age: t - list.t[k], s: list.s[k] * transient, band });
      }
    }
    const list = on[2];
    for (let k = lowerBound(list.t, t - K.HAT_LIFE_S); k < list.t.length && list.t[k] <= t + K.ATTACK_S; k++) {
      hats.push({ index: k, age: t - list.t[k], s: list.s[k] * transient });
    }
  }

  return {
    t,
    g,
    low,
    mid,
    high,
    beat,
    down,
    loud: curveAt(track.loud, track.loudStep, t),
    head: track.duration > 0 ? clamp01(t / track.duration) : 0,
    beatIndex,
    beatPhase,
    beatPeriod,
    beatSure,
    section,
    label,
    into,
    prevLabel,
    prevLength,
    tension,
    release,
    echoes,
    ripples,
    hats,
    sections,
  };
}
