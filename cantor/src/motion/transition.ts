/**
 * A Transition is a list of Slots — and a Slot is the engine's one animation
 * primitive: two verb-identical paths, a stagger window on the shared 0..1
 * clock, and ramps for alpha and stroke width. Morphs, splits, merges, fades,
 * grow-from-point, the reduced-motion crossfade — all just slots with
 * different ramps, so one renderer draws everything.
 *
 * Because a slot keeps its raw point arrays, "where is everything right now"
 * is a plain lerp — captureTransition() reads the live state so a new target
 * can take over mid-flight (tap BACK during a morph and the shape flows from
 * wherever it is; no remounts, no flashes).
 */
import { Skia, type SkPath } from '@shopify/react-native-skia';
import {
  alignSampled,
  assertInterpolatable,
  centroid,
  collapsedAt,
  lerpPts,
  polylinePath,
  smootherstep,
  type Pt,
} from './geometry';
import type { ContourGeom, ContourMode } from './shapes';

/** Per-slot start offset on the 0..1 clock; the cascade that reads as manim. */
const STAGGER = 0.08;
/**
 * However many slots there are, each keeps at least this much of the clock to
 * move in. Without the floor, 13+ slots at full STAGGER would invert their
 * windows (winB < winA) and every ramp would run backwards.
 */
const MIN_SPAN = 0.5;
/** Fading slots do it inside a sub-window so merges/splits stay thin. */
const FADE_OUT_WIN: [number, number] = [0.1, 0.6];
const FADE_IN_WIN: [number, number] = [0.4, 0.9];
/** Geometry ghosts dimmer than this are dropped on capture. */
const DEAD_ALPHA = 0.02;

export type Slot = {
  from: SkPath;
  to: SkPath;
  out: SkPath;
  fromPts: Pt[];
  toPts: Pt[];
  closed: boolean;
  mode: ContourMode;
  fromW: number;
  toW: number;
  fromA: number;
  toA: number;
  /** Geometry window on the master clock. */
  winA: number;
  winB: number;
  /** Alpha window (a sub-window when the slot fades). */
  alphaA: number;
  alphaB: number;
};

export type Transition = { slots: Slot[] };

function within(win: [number, number], a: number, b: number): [number, number] {
  const len = b - a;
  return [a + win[0] * len, a + win[1] * len];
}

function pairUp(
  from: ContourGeom[],
  to: ContourGeom[],
): { src: ContourGeom; dst: ContourGeom; fromA: number; toA: number }[] {
  const k = Math.max(from.length, to.length);
  const pairs = [];
  for (let i = 0; i < k; i++) {
    let src = from[Math.min(i, from.length - 1)];
    let dst = to[Math.min(i, to.length - 1)];
    if (!src) {
      // nothing of this mode leaves — grow the newcomer from its own centre
      src = { ...dst, pts: collapsedAt(dst.pts, centroid(dst.pts)), alpha: 0 };
    }
    if (!dst) {
      // nothing of this mode arrives — shrink the leaver into its own centre
      dst = { ...src, pts: collapsedAt(src.pts, centroid(src.pts)), alpha: 0 };
    }
    pairs.push({
      src,
      dst,
      fromA: i < from.length ? src.alpha : 0,
      toA: i < to.length ? 1 : 0,
    });
  }
  return pairs;
}

/** Build the slots that carry `from` into `to` on one 0..1 clock. */
export function buildTransition(from: ContourGeom[], to: ContourGeom[]): Transition {
  const modes: ContourMode[] = ['fill', 'stroke'];
  const pairs = modes.flatMap(mode =>
    pairUp(
      from.filter(g => g.mode === mode),
      to.filter(g => g.mode === mode),
    ),
  );
  const total = pairs.length;
  const stagger =
    total > 1 ? Math.min(STAGGER, (1 - MIN_SPAN) / (total - 1)) : 0;
  const span = 1 - stagger * (total - 1);
  return {
    slots: pairs.map((p, i) => {
      const winA = stagger * i;
      const winB = winA + span;
      const toPts = alignSampled(
        { pts: p.src.pts, closed: p.src.closed },
        { pts: p.dst.pts, closed: p.dst.closed },
      );
      const fading = p.toA < p.fromA ? FADE_OUT_WIN : p.toA > p.fromA ? FADE_IN_WIN : null;
      const [alphaA, alphaB] = fading ? within(fading, winA, winB) : [winA, winB];
      const fromPath = polylinePath(p.src.pts);
      const toPath = polylinePath(toPts);
      assertInterpolatable(fromPath, toPath, 'buildTransition');
      return {
        from: fromPath,
        to: toPath,
        out: Skia.Path.Make(),
        fromPts: p.src.pts,
        toPts,
        closed: p.dst.closed,
        mode: p.src.mode,
        fromW: p.src.width,
        toW: p.dst.width,
        fromA: p.fromA,
        toA: p.toA,
        winA,
        winB,
        alphaA,
        alphaB,
      };
    }),
  };
}

/** A transition that is simply "sit at the target" — the settled state. */
export function settledTransition(geoms: ContourGeom[]): Transition {
  return buildTransition(geoms, geoms);
}

/**
 * Reduced-motion variant: no geometry travels; the old drawing crossfades into
 * the new one. Same slot model, different ramps.
 */
export function crossfadeTransition(from: ContourGeom[], to: ContourGeom[]): Transition {
  const still = (g: ContourGeom, fromA: number, toA: number, win: [number, number]): Slot => ({
    from: polylinePath(g.pts),
    to: polylinePath(g.pts),
    out: Skia.Path.Make(),
    fromPts: g.pts,
    toPts: g.pts,
    closed: g.closed,
    mode: g.mode,
    fromW: g.width,
    toW: g.width,
    fromA,
    toA,
    winA: 0,
    winB: 1,
    alphaA: win[0],
    alphaB: win[1],
  });
  return {
    slots: [
      ...from.map(g => still(g, g.alpha, 0, [0, 0.6])),
      ...to.map(g => still(g, 0, 1, [0.4, 1])),
    ],
  };
}

/**
 * Read a transition's live state at clock value `t` — the geometry a new
 * transition should start from. Ghosts that have faded out are dropped.
 */
export function captureTransition(tr: Transition, t: number): ContourGeom[] {
  const geoms: ContourGeom[] = [];
  for (const s of tr.slots) {
    const u = smootherstep(s.winA, s.winB, t);
    const alpha = s.fromA + (s.toA - s.fromA) * smootherstep(s.alphaA, s.alphaB, t);
    if (alpha < DEAD_ALPHA) {
      continue;
    }
    geoms.push({
      pts: lerpPts(s.fromPts, s.toPts, u),
      closed: s.closed,
      mode: s.mode,
      width: s.fromW + (s.toW - s.fromW) * u,
      alpha,
    });
  }
  return geoms;
}
