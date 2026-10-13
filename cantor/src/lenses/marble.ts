/**
 * Marbling: a song's identity drawn as suminagashi — drops of ink and clear
 * water on a bath, combed — and its sound as the ink every bar adds.
 *
 * Two layers, like every lens (`cantor/AGENTS.md`, "Every lens is two
 * layers"). The *identity* is a pure function of the recipe: four to seven
 * drops near the centre, ink and clear water by turns, one or two tine
 * strokes, sometimes a drop off-centre. The *sound* is a drop on every bar at
 * the playhead's place round the dial, a comb at every section start and a
 * bullseye on a drop (`marbleTimeline.ts`). Nothing is erased: older ink is
 * pushed aside, so the song so far *is* the pattern.
 *
 * Jaffer's marbling equations, all exact and area-preserving, which is why the
 * identity survives being pushed aside — and all homeomorphisms of the plane,
 * which is what makes the drawing cheap: no two ring outlines ever cross, and
 * a ring added later never contains an older one's outline. So a point's
 * colour is the colour of the newest ring round it, every ring's parent is
 * fixed the moment it falls, and the whole surface is one even-odd path of
 * the rings whose colour differs from their parent's (`toggle`).
 *
 * The reference implementation is `docs/interfacealpha/lenses-four.html`,
 * section IV (`MARBLE`); where this file and the page disagree about a number,
 * the page is right unless `docs/interfacealpha/marbling-log.md` says why not.
 *
 * Geometry only: no Skia here, so it can be tested without a canvas.
 * Coordinates are the bath's own units: the identity's drops have radii of a
 * quarter to a half.
 */

/* eslint-disable no-bitwise -- a seed is a bit field, and a ring is pairs of
   numbers; the same exemption `face.ts` and `seal.ts` take. */

import { faceSeed, hash, mulberry32, type FaceRecipe } from './face';

/** KNOBS — the identity, the page's own numbers (`identityOps`). */
export const MARBLE_KNOBS = {
  /** Four to seven drops, near the centre. */
  DROPS_MIN: 4,
  DROPS_SPAN: 4,
  /** How far from the centre a drop may fall, either way, on each axis. */
  DROP_JITTER: 0.3,
  DROP_R_MIN: 0.25,
  DROP_R_MAX: 0.45,
  /** How often the recipe combs twice rather than once. */
  TWO_TINES: 0.45,
  /** A tine's line, from the centre, either way. */
  TINE_OFFSET: 0.6,
  TINE_Z_MIN: 0.25,
  TINE_Z_MAX: 0.6,
  TINE_LAMBDA_MIN: 0.1,
  TINE_LAMBDA_MAX: 0.25,
  /** How often a drop falls off-centre, how far out, and how big. */
  OFF_CENTRE: 0.5,
  OFF_CENTRE_AT: 0.45,
  OFF_R_MIN: 0.15,
  OFF_R_MAX: 0.25,
  /**
   * Points round an identity ring at the mark. Every song builds its
   * marbling whichever lens is showing, and the points are the cost; at 19 px
   * across a 32-gon is within 0.05 px of a circle.
   */
  MARK_POINTS: 32,
  /**
   * The same at the player, which builds its own bath for the one song the
   * camera is in. The page used 120; 96 is within 0.1 px of a circle at the
   * player's size. Mark and player differ by under a pixel where they meet,
   * at the row's size.
   */
  PLAYER_POINTS: 96,
  /**
   * The imported marker: a clear drop at the centre, last, as a fraction of
   * the identity's reach — the circle's spindle in marbling's own form, which
   * the bars then push aside like everything else.
   */
  SPINDLE_RATIO: 0.2,
} as const;

/** A drop of ink (or of clear water) of radius `r` falling at (`x`, `y`). */
export type MarbleDrop = Readonly<{
  kind: 'drop';
  x: number;
  y: number;
  r: number;
  ink: boolean;
  /** Points round its ring. */
  points: number;
}>;

/**
 * A tine drawn through the bath along the unit direction (`mx`, `my`), on the
 * line `p · n = off` with n = (−my, mx): every point moves along m by
 * `z · exp(−|p · n − off| / lambda)`.
 */
export type MarbleTine = Readonly<{
  kind: 'tine';
  mx: number;
  my: number;
  off: number;
  z: number;
  lambda: number;
}>;

export type MarbleOp = MarbleDrop | MarbleTine;

/**
 * One ring: a drop's outline, as it has been pushed about since, as
 * interleaved x, y. `toggle` is whether its colour differs from the colour
 * round it when it fell, which is all the even-odd fill needs.
 */
export type MarbleRing = {
  pts: Float64Array;
  ink: boolean;
  toggle: boolean;
};

/** The bath: every ring, oldest first, which is painting order. */
export type MarbleSurface = { rings: MarbleRing[] };

/*
 * The equations, point by point. The drawing applies the forward maps to the
 * rings; the live shader (`marbleLens.ts`) runs the inverses per pixel, which
 * is why both are here and tested against each other.
 */

/** Where a drop of radius `r` at (`cx`, `cy`) pushes `p`: radially out. */
export function dropForward(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  out: [number, number],
): void {
  'worklet';
  const dx = px - cx;
  const dy = py - cy;
  const d2 = dx * dx + dy * dy || 1e-18;
  const k = Math.sqrt(1 + (r * r) / d2);
  out[0] = cx + dx * k;
  out[1] = cy + dy * k;
}

/**
 * Where `p` was before the drop, or false if it is inside the drop itself,
 * which then owns its colour.
 */
export function dropInverse(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  out: [number, number],
): boolean {
  'worklet';
  const dx = px - cx;
  const dy = py - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 <= r * r) return false;
  const k = Math.sqrt(1 - (r * r) / d2);
  out[0] = cx + dx * k;
  out[1] = cy + dy * k;
  return true;
}

/** Where a tine drawn `fraction` of its way moves `p`. */
export function tineForward(
  px: number,
  py: number,
  tine: MarbleTine,
  fraction: number,
  out: [number, number],
): void {
  'worklet';
  const d = Math.abs(-px * tine.my + py * tine.mx - tine.off);
  const k = tine.z * fraction * Math.exp(-d / tine.lambda);
  out[0] = px + tine.mx * k;
  out[1] = py + tine.my * k;
}

/** Exact: moving along m does not change p · n, so the shift is known. */
export function tineInverse(
  px: number,
  py: number,
  tine: MarbleTine,
  fraction: number,
  out: [number, number],
): void {
  'worklet';
  const d = Math.abs(-px * tine.my + py * tine.mx - tine.off);
  const k = tine.z * fraction * Math.exp(-d / tine.lambda);
  out[0] = px - tine.mx * k;
  out[1] = py - tine.my * k;
}

/** Whether (`x`, `y`) is inside a ring's polygon (crossings). */
export function insideRing(
  pts: Float64Array | readonly number[],
  x: number,
  y: number,
): boolean {
  'worklet';
  let inside = false;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The colour at (`x`, `y`): the newest ring round it, or paper. */
export function inkAt(surface: MarbleSurface, x: number, y: number): boolean {
  const rings = surface.rings;
  for (let index = rings.length - 1; index >= 0; index -= 1) {
    if (insideRing(rings[index].pts, x, y)) return rings[index].ink;
  }
  return false;
}

/**
 * Apply one op, `fraction` of the way landed, to the bath — the page's
 * `apply`. A drop lands with its radius as √fraction, so its area, and the
 * bath's, grows linearly in `fraction`.
 */
export function applyMarbleOp(
  surface: MarbleSurface,
  op: MarbleOp,
  fraction: number,
): void {
  'worklet';
  const rings = surface.rings;
  if (op.kind === 'drop') {
    const r = op.r * Math.sqrt(Math.max(0, Math.min(1, fraction)));
    const r2 = r * r;
    if (r2 <= 0) return;
    // Its colour's ground: the newest ring round where it falls, which keeps
    // it round the whole drop, since the drop pushes every outline out of it.
    let ground = false;
    for (let index = rings.length - 1; index >= 0; index -= 1) {
      if (insideRing(rings[index].pts, op.x, op.y)) {
        ground = rings[index].ink;
        break;
      }
    }
    for (const ring of rings) {
      const pts = ring.pts;
      for (let i = 0; i < pts.length; i += 2) {
        const dx = pts[i] - op.x;
        const dy = pts[i + 1] - op.y;
        const k = Math.sqrt(1 + r2 / (dx * dx + dy * dy || 1e-18));
        pts[i] = op.x + dx * k;
        pts[i + 1] = op.y + dy * k;
      }
    }
    const pts = new Float64Array(op.points * 2);
    for (let i = 0; i < op.points; i += 1) {
      const a = (i / op.points) * Math.PI * 2;
      pts[2 * i] = op.x + Math.cos(a) * r;
      pts[2 * i + 1] = op.y + Math.sin(a) * r;
    }
    rings.push({ pts, ink: op.ink, toggle: op.ink !== ground });
    return;
  }
  const z = op.z * fraction;
  if (z === 0) return;
  for (const ring of rings) {
    const pts = ring.pts;
    for (let i = 0; i < pts.length; i += 2) {
      const d = Math.abs(-pts[i] * op.my + pts[i + 1] * op.mx - op.off);
      const k = z * Math.exp(-d / op.lambda);
      pts[i] += op.mx * k;
      pts[i + 1] += op.my * k;
    }
  }
}

/** A deep copy, for keeping a keyframe or landing ops on a scratch bath. */
export function copySurface(surface: MarbleSurface): MarbleSurface {
  return {
    rings: surface.rings.map(ring => ({
      pts: ring.pts.slice(),
      ink: ring.ink,
      toggle: ring.toggle,
    })),
  };
}

/** How far the furthest point of the bath is from the centre. */
export function surfaceReach(surface: MarbleSurface): number {
  let reach = 0;
  for (const ring of surface.rings) {
    const pts = ring.pts;
    for (let i = 0; i < pts.length; i += 2) {
      const d = pts[i] * pts[i] + pts[i + 1] * pts[i + 1];
      if (d > reach) reach = d;
    }
  }
  return Math.sqrt(reach) || 1;
}

/** A ring's area (shoelace), for the area-preservation tests. */
export function ringArea(pts: Float64Array): number {
  let twice = 0;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    twice += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  }
  return Math.abs(twice) / 2;
}

/** The recipe's own random stream: the page's `rngOf(recipe, 'marble')`. */
export function marbleRandom(recipe: FaceRecipe): () => number {
  // Duration folded in, as the seal does (`sealSeed`): the page's stream
  // ignores it, which made two takes of one seed the same marbling.
  const seconds = Math.round(Math.max(0, recipe.durationMs) / 1000);
  return mulberry32(
    (faceSeed(recipe) ^ hash('marble') ^ Math.imul(seconds + 1, 0x9e3779b1)) >>>
      0,
  );
}

const lerp = (a: number, b: number, s: number) => a + (b - a) * s;

/** The page's `identityOps`, drawn from `random`. */
export function marbleIdentityOpsFrom(
  random: () => number,
  points: number = MARBLE_KNOBS.MARK_POINTS,
): MarbleOp[] {
  const K = MARBLE_KNOBS;
  const ops: MarbleOp[] = [];
  const drops = K.DROPS_MIN + Math.floor(random() * K.DROPS_SPAN);
  for (let i = 0; i < drops; i += 1) {
    const x = (random() - 0.5) * K.DROP_JITTER;
    const y = (random() - 0.5) * K.DROP_JITTER;
    const r = lerp(K.DROP_R_MIN, K.DROP_R_MAX, random());
    ops.push({ kind: 'drop', x, y, r, ink: i % 2 === 0, points });
  }
  const tines = random() < K.TWO_TINES ? 2 : 1;
  for (let i = 0; i < tines; i += 1) {
    const dir = random() * Math.PI * 2;
    const off = (random() - 0.5) * K.TINE_OFFSET;
    const z = lerp(K.TINE_Z_MIN, K.TINE_Z_MAX, random());
    const lambda = lerp(K.TINE_LAMBDA_MIN, K.TINE_LAMBDA_MAX, random());
    ops.push({ kind: 'tine', mx: Math.cos(dir), my: Math.sin(dir), off, z, lambda });
  }
  if (random() < K.OFF_CENTRE) {
    const a = random() * Math.PI * 2;
    const r = lerp(K.OFF_R_MIN, K.OFF_R_MAX, random());
    ops.push({
      kind: 'drop',
      x: Math.cos(a) * K.OFF_CENTRE_AT,
      y: Math.sin(a) * K.OFF_CENTRE_AT,
      r,
      ink: drops % 2 === 0,
      points,
    });
  }
  return ops;
}

/**
 * A song's identity: its ops, the bath they leave, and the two sizes the
 * drawing scales by — the furthest point (what a mark is fitted to) and the
 * area-equivalent radius (what the player zooms out by as ink accumulates;
 * area is preserved, so it is `√Σr²` of every drop, with no scan).
 */
export type MarbleIdentity = Readonly<{
  ops: readonly MarbleOp[];
  surface: MarbleSurface;
  reach: number;
  ext: number;
}>;

const IDENTITY_CACHE_LIMIT = 512;
const identityCache = new Map<string, MarbleIdentity>();

/** The identity for a recipe. Same recipe, same marbling, on every device. */
export function marbleIdentity(
  recipe: FaceRecipe,
  points: number = MARBLE_KNOBS.MARK_POINTS,
): MarbleIdentity {
  const key = `${recipe.seed ?? ''}\u001f${recipe.id}\u001f${recipe.model}\u001f${
    recipe.durationMs
  }\u001f${recipe.imported === true ? 'i' : ''}\u001f${points}`;
  const cached = identityCache.get(key);
  if (cached !== undefined) return cached;
  const ops = marbleIdentityOpsFrom(marbleRandom(recipe), points);
  const surface: MarbleSurface = { rings: [] };
  for (const op of ops) applyMarbleOp(surface, op, 1);
  if (recipe.imported === true) {
    const spindle: MarbleDrop = {
      kind: 'drop',
      x: 0,
      y: 0,
      r: MARBLE_KNOBS.SPINDLE_RATIO * surfaceReach(surface),
      ink: false,
      points,
    };
    ops.push(spindle);
    applyMarbleOp(surface, spindle, 1);
  }
  let area = 0;
  for (const op of ops) if (op.kind === 'drop') area += op.r * op.r;
  const identity: MarbleIdentity = {
    ops,
    surface,
    reach: surfaceReach(surface),
    ext: Math.sqrt(area),
  };
  if (identityCache.size >= IDENTITY_CACHE_LIMIT) {
    const oldest = identityCache.keys().next().value;
    if (oldest !== undefined) identityCache.delete(oldest);
  }
  identityCache.set(key, identity);
  return identity;
}
