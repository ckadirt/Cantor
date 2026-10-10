import { Skia, FillType, type SkCanvas, type SkPaint, type SkPath } from '@shopify/react-native-skia';
import { FACE_KNOBS, faceParams, type FaceRecipe } from './face';
import type { LensPlayer } from './contract';
import { MOTION_KNOBS, smoothstep, smootherstep, type MotionFrame } from './motion/motionFrame';

/**
 * The circle singing: its player, moved by the music (reactive-player-plan.md,
 * M4; the reference page's `drawCircle(…, 'structure')`).
 *
 * The face is two harmonics, and the music plays them: the low band swells the
 * big lobes, the high band the fine detail, the mid band widens it. Each low or
 * mid hit sends a bump both ways round the contour from the hand. And it holds
 * a **pose per section** — its letter's own angle, then a slow turn counted from
 * the section's start — so a chorus that returns, returns to the same shape.
 * Before a drop it tightens and rounds; on the drop it blooms.
 *
 * The circle shows form as shape. Every gesture is scaled by how far the
 * player has arrived and how far its motion has risen, so at the hand-off to
 * the row the drawing is the identity, point for point.
 */
export type CirclePlayer = Readonly<{
  /** The circle's sound is the renderer's ring of ticks, not its own. */
  sound: null;
  lobes: number;
  detail: number;
  primary: number;
  secondary: number;
  eccentricity: number;
  /** Where the contour's samples start: `facePoints`' angle for sample 0. */
  rotation: number;
  /** An imported song's spindle, as a share of the radius; 0 for none. */
  spindle: number;
}>;

// knobs — the page's shipping values (reactive-player-plan.md, "The shipping numbers")
export const CIRCLE_MOTION_KNOBS = {
  /** Low swells the primary harmonic, high the secondary, mid the width. */
  LOW_PRIMARY: 1.3,
  HIGH_SECONDARY: 2.2,
  MID_WIDEN: 1.5,
  MID_WIDTH: 0.025,
  LOUD_SCALE: 0.025,
  /** The ripple: half strength, a quarter turn per beat, its width, its height. */
  RIPPLE_AMOUNT: 0.5,
  RIPPLE_MID: 0.7,
  RIPPLE_SIGMA: 0.22,
  RIPPLE_GAIN: 0.09,
  RIPPLE_CAP: 0.22,
  /** A section's turn: a letter is 1/(3·lobes) of a turn, plus 1/(4·lobes) per bar. */
  LETTER_TURN: 3,
  BAR_TURN: 4,
  /** How much of each beat the turn's step takes. */
  STEP_SHARE: 0.35,
  /** Tension tightens and rounds; release blooms. */
  TENSION_SCALE: 0.1,
  TENSION_SCALE_CAP: 0.2,
  TENSION_PRIMARY: 0.55,
  TENSION_SECONDARY: 0.5,
  RELEASE_SCALE: 0.1,
  RELEASE_SCALE_CAP: 0.15,
  RELEASE_PRIMARY: 1.1,
} as const;

export function circlePlayerOf(recipe: FaceRecipe, spindleRatio: number): CirclePlayer {
  const params = faceParams(recipe);
  return {
    sound: null,
    lobes: params.lobes,
    detail: params.detail,
    primary: params.primary,
    secondary: params.secondary,
    eccentricity: params.eccentricity,
    rotation: params.rotation,
    spindle: recipe.imported === true ? spindleRatio : 0,
  };
}

export function isCirclePlayer(player: LensPlayer | null): player is CirclePlayer {
  'worklet';
  return player !== null && (player as CirclePlayer).lobes !== undefined;
}

/**
 * The section's pose, in radians: the page's `structureAt().turn`.
 *
 * A letter's own angle plus a slow turn per bar counted from the section's own
 * start, stepping on each beat over its first third — or turning evenly where
 * the beat grid is a guess. Into a new section it eases over the first bar
 * from where the last one stood, the short way round.
 */
export function circlePose(frame: MotionFrame, lobes: number): number {
  'worklet';
  if (frame.section < 0) return 0;
  const K = CIRCLE_MOTION_KNOBS;
  const step = (Math.PI * 2) / (lobes * 8);
  const sure = frame.beatSure;
  const eased = (x: number) => {
    const whole = Math.floor(x);
    const stepped = whole + smootherstep((x - whole) / K.STEP_SHARE);
    return x + (stepped - x) * sure;
  };
  const turnOf = (label: number, x: number) =>
    label * ((Math.PI * 2) / (lobes * K.LETTER_TURN)) + (eased(x) / K.BAR_TURN) * step * 2;
  let turn = turnOf(frame.label, frame.into);
  if (frame.prevLabel >= 0 && frame.into < 4) {
    const a = smootherstep(frame.into / 4);
    const from = turnOf(frame.prevLabel, frame.prevLength);
    const whole = Math.round((turnOf(frame.label, 0) - from) / (Math.PI * 2)) * Math.PI * 2;
    turn = from + (turn - whole - from) * a;
  }
  return turn;
}

/** An angle to (−π, π]: a pose scaled down unwinds the short way. */
export function wrapAngle(a: number): number {
  'worklet';
  const r = a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  return r <= -Math.PI ? r + Math.PI * 2 : r;
}

/**
 * The moving contour as its samples, `x, y` pairs: what `circleMotionPath`
 * closes into a path, and what the player strokes segment by segment
 * (`strokeCircleMotion`).
 */
export function circleMotionPoints(
  player: CirclePlayer,
  frame: MotionFrame,
  amount: number,
  radius: number,
): number[] {
  'worklet';
  const K = CIRCLE_MOTION_KNOBS;
  const m = Math.min(Math.max(amount, 0), 1);
  const g = frame.g;
  let primary = player.primary * (1 + g * K.LOW_PRIMARY * frame.low);
  let secondary = player.secondary * (1 + g * K.HIGH_SECONDARY * frame.high);
  const width =
    1 + (player.eccentricity - 1) * (1 + g * K.MID_WIDEN * frame.mid) + g * K.MID_WIDTH * frame.mid;
  let scale = 1 + g * K.LOUD_SCALE * frame.loud;
  // Tighten and round as a drop approaches; bloom when it lands. A lift is
  // the same gesture, smaller (it is weighed that way in the frame).
  const tension = Math.max(frame.tension, frame.lift);
  const release = Math.max(frame.release, frame.lifted);
  scale *=
    1 -
    Math.min(K.TENSION_SCALE_CAP, g * K.TENSION_SCALE * tension) +
    Math.min(K.RELEASE_SCALE_CAP, g * K.RELEASE_SCALE * release);
  primary *= (1 - K.TENSION_PRIMARY * tension) * (1 + K.RELEASE_PRIMARY * release);
  secondary *= 1 - K.TENSION_SECONDARY * tension;
  // Everything from the identity, `m` of the way: the pose wrapped first, so a
  // long section's several whole turns unwind at most half a turn.
  primary = player.primary + (primary - player.primary) * m;
  secondary = player.secondary + (secondary - player.secondary) * m;
  const eccentricity = player.eccentricity + (width - player.eccentricity) * m;
  scale = 1 + (scale - 1) * m;
  const turn = wrapAngle(circlePose(frame, player.lobes)) * m;

  // The ripples: each hit, at the hand, travelling both ways a quarter turn a
  // beat. Each bump is a Gaussian that is nothing past three widths, so only
  // the samples under it are visited — this runs every frame on a JIT-less
  // runtime, and visiting every sample for every hit cost most of a frame.
  const samples = FACE_KNOBS.SAMPLES;
  const step = (Math.PI * 2) / samples;
  const bumps: number[] = [];
  for (let k = 0; k < samples; k++) bumps.push(0);
  const hand = frame.head * Math.PI * 2 - Math.PI / 2;
  const speed = Math.PI / 2 / frame.beatPeriod;
  const spread = 2 * K.RIPPLE_SIGMA * K.RIPPLE_SIGMA;
  const reach = Math.ceil((3 * K.RIPPLE_SIGMA) / step);
  const ripples = frame.ripples;
  for (let i = 0; i < ripples.length; i++) {
    const o = ripples[i];
    const life =
      (o.age < 0 ? smoothstep(1 + o.age / Math.max(0.001, MOTION_KNOBS.ATTACK_S)) : 1) *
      (1 - smootherstep(Math.max(0, o.age) / MOTION_KNOBS.RIPPLE_LIFE_S));
    const height = o.s * life * K.RIPPLE_AMOUNT * (o.band === 0 ? 1 : K.RIPPLE_MID);
    if (height <= 1e-4) continue;
    const travel = speed * Math.max(0, o.age);
    for (let dir = -1; dir <= 1; dir += 2) {
      const centre = hand + dir * travel;
      // The sample nearest the bump's centre, in the samples' own angles.
      const nearest = Math.round((centre - player.rotation) / step);
      for (let j = nearest - reach; j <= nearest + reach; j++) {
        const k = ((j % samples) + samples) % samples;
        let d = (j * step + player.rotation) - centre;
        d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
        bumps[k] += height * Math.exp(-(d * d) / spread);
      }
    }
  }

  const points: number[] = [];
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * Math.PI * 2 + player.rotation;
    const ph = a - turn;
    const bump = Math.min(K.RIPPLE_CAP, bumps[k] * K.RIPPLE_GAIN * g) * m;
    const r =
      scale * (1 + primary * Math.sin(player.lobes * ph) + secondary * Math.sin(player.detail * ph + 1.1)) +
      bump;
    points.push(Math.cos(a) * r * eccentricity * radius, ((Math.sin(a) * r) / eccentricity) * radius);
  }
  return points;
}

/**
 * The moving contour's line, as its segments rather than as one path.
 *
 * Ganesh draws an anti-aliased stroke of a non-convex path by rasterising a
 * mask on the CPU and uploading it, and caches the mask per path: a path that
 * is new every frame was a new upload every frame (`glTexSubImage2D`, 15 % of
 * the UI thread on the Xiaomi). A single segment is a convex stroke, drawn on
 * the GPU, as the ring's ticks are. Butt caps, so a joint is not inked twice:
 * at 96 samples the notch a butt joint leaves is a few hundredths of a pixel.
 */
export function strokeCircleMotion(
  canvas: SkCanvas,
  points: readonly number[],
  spindle: number,
  radius: number,
  paint: SkPaint,
): void {
  'worklet';
  const count = points.length / 2;
  for (let k = 0; k < count; k++) {
    const j = (k + 1) % count;
    canvas.drawLine(points[2 * k], points[2 * k + 1], points[2 * j], points[2 * j + 1], paint);
  }
  if (spindle > 0) canvas.drawCircle(0, 0, radius * spindle, paint);
}

/**
 * The moving contour at `radius`, `amount` (0..1) of the way from the
 * identity to the frame's drawing.
 *
 * Sampled at the identity's own angles (`facePoints`), so at `amount` 0 this
 * is the mark's path point for point.
 */
export function circleMotionPath(
  player: CirclePlayer,
  frame: MotionFrame,
  amount: number,
  radius: number,
): SkPath {
  'worklet';
  const points = circleMotionPoints(player, frame, amount, radius);
  const builder = Skia.PathBuilder.Make();
  for (let k = 0; k < points.length; k += 2) {
    if (k === 0) builder.moveTo(points[k], points[k + 1]);
    else builder.lineTo(points[k], points[k + 1]);
  }
  builder.close();
  if (player.spindle > 0) {
    builder.addCircle(0, 0, radius * player.spindle);
    builder.setFillType(FillType.EvenOdd);
  }
  return builder.detach();
}

/**
 * The ring of ticks' level at the playhead, from the music: the page's
 * `0.45 · clamp(0.35 loud + 0.65 max(low, 0.6 beat))` over a 0.1-turn
 * window, in place of today's coarse level over half a turn.
 */
export const RING_MOTION_KNOBS = {
  LEVEL: 0.45,
  LOUD: 0.35,
  HIT: 0.65,
  BEAT: 0.6,
  WINDOW: 0.1,
} as const;

export function ringMotionLevel(frame: MotionFrame): number {
  'worklet';
  const K = RING_MOTION_KNOBS;
  const v = K.LOUD * frame.loud + K.HIT * Math.max(frame.low, K.BEAT * frame.beat);
  return K.LEVEL * Math.min(Math.max(v, 0), 1);
}
