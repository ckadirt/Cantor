/**
 * A song's face: the closed contour that identifies it at every level.
 *
 * The shape is a pure function of the song's *recipe* — seed, model and
 * duration — which every `SongHeader` already carries. That is deliberate and
 * documented in `docs/interface/alpha-design.md`: shape is identity, position is
 * similarity, and the two are separate axes. Deriving the face from the recipe
 * means it needs no audio, no storage and no node work, it is identical on every
 * device, and it exists at submit time — which is what lets a generating job
 * morph into its own finished mark.
 *
 * It deliberately does **not** come from `analysis`. `analyseWindow` runs only
 * for the focused song, so every other mark carries a flat `skeletonAnalysis`
 * and an audio-derived face would make the whole field identical.
 *
 * Geometry only: no Skia here, so the shape can be tested without a canvas.
 */

/*
 * eslint-disable no-bitwise -- a hash and a PRNG are bit fields by definition,
 * the same exemption `src/motion/geometry.ts` and `src/security/inner.ts` take.
 * `motion/geometry.ts` exports an identical mulberry32, but `lenses/` sits
 * beside `motion/` rather than above it in the layering that `structure.md`
 * draws, so this keeps the face free of a sideways import.
 */
/* eslint-disable no-bitwise */

/** KNOBS — the shape language. Amplitudes stay low so the form reads delicate. */
export const FACE_KNOBS = {
  /** Points around the contour. 96 is smooth at player size and cheap at mark size. */
  SAMPLES: 96,
  /** Lobe count of the primary harmonic: the coarse character. */
  LOBES_MIN: 2,
  LOBES_SPAN: 4,
  /** Lobe count of the secondary harmonic: the fine detail. */
  DETAIL_MIN: 5,
  DETAIL_SPAN: 5,
  /** How far the primary harmonic pushes the radius, as a fraction of it. */
  PRIMARY_MIN: 0.05,
  PRIMARY_SPAN: 0.09,
  /** The same for the secondary harmonic, kept smaller so it stays a detail. */
  SECONDARY_MIN: 0.02,
  SECONDARY_SPAN: 0.045,
  /** How much duration widens or narrows the form, at most, either way. */
  ECCENTRICITY: 0.24,
  /** Seconds before the eccentricity repeats. Prime, so neighbours differ. */
  DURATION_CYCLE_S: 97,
} as const;

export type FaceRecipe = Readonly<{
  /** `SongHeader.seed` when the node sent one. */
  seed: number | undefined;
  /** The song id, used when there is no seed so a face always exists. */
  id: string;
  /** `SongHeader.model`, so two seeds that collide across models still differ. */
  model: string;
  durationMs: number;
}>;

export type FaceParams = Readonly<{
  lobes: number;
  detail: number;
  primary: number;
  secondary: number;
  rotation: number;
  /** >1 wider than tall, <1 taller than wide. */
  eccentricity: number;
}>;

/** A point on the contour, in a unit box: radius 1 before eccentricity. */
export type FacePoint = Readonly<{ x: number; y: number }>;

/**
 * The recipe reduced to one integer.
 *
 * `SongHeader.seed` is optional, so a song generated before the node reported
 * seeds — or by an engine that does not use one — still needs a stable face.
 * The id is stable for the life of the song, so it is the honest fallback.
 */
export function faceSeed(recipe: FaceRecipe): number {
  const base = recipe.seed ?? hash(recipe.id);
  return (base ^ hash(recipe.model)) >>> 0;
}

/** The shape parameters for a recipe. Same recipe, same parameters, forever. */
export function faceParams(recipe: FaceRecipe): FaceParams {
  const random = mulberry32(faceSeed(recipe));
  const lobes =
    FACE_KNOBS.LOBES_MIN + Math.floor(random() * FACE_KNOBS.LOBES_SPAN);
  const detail =
    FACE_KNOBS.DETAIL_MIN + Math.floor(random() * FACE_KNOBS.DETAIL_SPAN);
  const primary =
    FACE_KNOBS.PRIMARY_MIN + random() * FACE_KNOBS.PRIMARY_SPAN;
  const secondary =
    FACE_KNOBS.SECONDARY_MIN + random() * FACE_KNOBS.SECONDARY_SPAN;
  const rotation = random() * Math.PI * 2;
  const seconds = Math.max(0, recipe.durationMs) / 1000;
  const cycle = (seconds % FACE_KNOBS.DURATION_CYCLE_S) / FACE_KNOBS.DURATION_CYCLE_S;
  const eccentricity = 1 + (cycle - 0.5) * FACE_KNOBS.ECCENTRICITY;
  return { lobes, detail, primary, secondary, rotation, eccentricity };
}

/**
 * The contour, normalised so the caller scales it: multiply by the radius the
 * level wants and translate to the mark's centre. One function serves the mark,
 * the row preview and the full-screen player.
 */
export function facePoints(
  recipe: FaceRecipe,
  samples: number = FACE_KNOBS.SAMPLES,
): readonly FacePoint[] {
  const count = Math.max(3, Math.floor(samples));
  const { lobes, detail, primary, secondary, rotation, eccentricity } =
    faceParams(recipe);
  const points: FacePoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + rotation;
    const radius =
      1 +
      primary * Math.sin(lobes * angle) +
      secondary * Math.sin(detail * angle + 1.1);
    points.push({
      x: Math.cos(angle) * radius * eccentricity,
      y: (Math.sin(angle) * radius) / eccentricity,
    });
  }
  return points;
}

/** FNV-1a over a string, so ids and model names reduce to a stable integer. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/** A small deterministic PRNG. The same seed draws the same face on every device. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

/* eslint-enable no-bitwise */
