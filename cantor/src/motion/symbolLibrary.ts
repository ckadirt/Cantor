/**
 * Cantor's canonical reusable symbols.
 *
 * Every primitive is authored as a small family of independent contours in a
 * 0..100 box. They are real Shape values, so the same definitions can be
 * written on, morphed, resized, stretched, relocated, or composed into a
 * larger scene. The metadata keeps their semantic meaning beside the geometry.
 */
import type { Shape } from './shapes';
import { SYMBOL_ARTWORK, type SymbolArtwork } from './symbolArtwork';

export type SymbolPrimitive = Shape & {
  glyph: string;
  label: string;
  meaning: string;
  /** Canonical filled silhouette used for the final, optically correct mark. */
  artwork: SymbolArtwork;
};

const stroke = (d: string) => ({ d, mode: 'stroke' as const });
const fill = (d: string) => ({ d, mode: 'fill' as const });

const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy - ry * 0.5523} ${cx - rx * 0.5523} ${cy - ry} ${cx} ${
    cy - ry
  } ` +
  `C ${cx + rx * 0.5523} ${cy - ry} ${cx + rx} ${cy - ry * 0.5523} ${
    cx + rx
  } ${cy} ` +
  `C ${cx + rx} ${cy + ry * 0.5523} ${cx + rx * 0.5523} ${cy + ry} ${cx} ${
    cy + ry
  } ` +
  `C ${cx - rx * 0.5523} ${cy + ry} ${cx - rx} ${cy + ry * 0.5523} ${
    cx - rx
  } ${cy} Z`;

const dot = (cx: number, cy: number, r: number): string =>
  ellipse(cx, cy, r, r);

export const SYMBOL_LIBRARY = {
  /** ℵ₀ — three calligraphic aleph strokes with a true subscript zero. */
  alephNull: {
    name: 'aleph-null',
    glyph: 'ℵ₀',
    label: 'Aleph-null',
    meaning: 'The cardinality of the natural numbers; the smallest infinity.',
    artwork: SYMBOL_ARTWORK.alephNull,
    aspectRatio: 0.82,
    strokeWidth: 1.65,
    contours: [
      stroke('M 24 21 L 63 70'),
      stroke('M 66 22 C 68 37 60 45 48 47'),
      stroke('M 21 69 C 19 55 27 47 39 45'),
      // Deliberately leave a hairline opening: the intro can ribbon this zero
      // into a hollow mark while the regular stroke renderer still reads it as ₀.
      stroke(
        'M 67 75 C 67 69 70 66 74 66 C 78 66 81 69 81 74 C 81 80 78 83 74 83 C 70 83 67 80 67 73',
      ),
    ],
  },

  /** ∞ — a balanced lemniscate with a slight engraved waist. */
  infinity: {
    name: 'infinity',
    glyph: '∞',
    label: 'Infinity',
    meaning: 'Something without a finite bound.',
    artwork: SYMBOL_ARTWORK.infinity,
    aspectRatio: 1.48,
    strokeWidth: 1.7,
    contours: [
      stroke(
        'M 50 50 C 40 32 17 34 17 50 C 17 66 40 68 50 50 ' +
          'C 60 32 83 34 83 50 C 83 66 60 68 50 50',
      ),
    ],
  },

  /** 𝒞 — a restrained script capital with separate entry/exit flourishes. */
  cantorSet: {
    name: 'cantor-set',
    glyph: '𝒞',
    label: 'Cantor set',
    meaning: 'The conventional script letter for the Cantor set.',
    artwork: SYMBOL_ARTWORK.cantorSet,
    aspectRatio: 0.78,
    strokeWidth: 1.65,
    contours: [
      stroke(
        'M 78 29 C 68 14 44 15 30 32 C 15 51 25 76 48 81 C 61 84 73 77 79 66',
      ),
      stroke(
        'M 76 29 C 68 38 57 43 49 38 C 40 33 45 22 57 20 C 70 18 83 27 81 39',
      ),
      stroke('M 48 81 C 37 88 26 86 22 79'),
    ],
  },

  /** ∮ — an integral spine passing through a nearly closed contour. */
  contourIntegral: {
    name: 'contour-integral',
    glyph: '∮',
    label: 'Contour integral',
    meaning: 'Continuous accumulation around a closed curve.',
    artwork: SYMBOL_ARTWORK.contourIntegral,
    aspectRatio: 0.82,
    strokeWidth: 1.55,
    contours: [
      stroke('M 66 10 C 55 7 51 18 49 33 L 43 68 C 41 82 36 91 26 88'),
      stroke(
        'M 31 52 C 30 42 38 36 49 36 C 60 36 68 42 67 51 C 66 61 58 66 48 66 C 38 66 31 60 31 50',
      ),
    ],
  },

  /** 𝄞 — a four-stroke engraved G clef, tall and deliberately delicate. */
  trebleClef: {
    name: 'treble-clef',
    glyph: '𝄞',
    label: 'Treble clef',
    meaning: 'The G clef; it establishes the pitch position of G.',
    artwork: SYMBOL_ARTWORK.trebleClef,
    aspectRatio: 0.72,
    strokeWidth: 1.45,
    contours: [
      stroke('M 58 8 C 67 22 59 35 49 44 C 41 36 44 23 57 10'),
      stroke('M 49 44 C 37 54 33 68 39 79'),
      stroke(
        'M 49 44 C 62 37 75 46 72 60 C 69 75 50 80 40 69 C 31 58 40 45 51 46 C 62 47 66 56 61 64 C 56 72 45 69 43 62',
      ),
      stroke(
        'M 58 9 C 55 31 51 54 54 77 C 57 91 55 99 47 97 C 55 100 62 94 57 84',
      ),
    ],
  },

  /** 𝄋 — the return sign: an S crossing a diagonal, held by two points. */
  segno: {
    name: 'segno',
    glyph: '𝄋',
    label: 'Segno',
    meaning: 'Return to the sign.',
    artwork: SYMBOL_ARTWORK.segno,
    aspectRatio: 0.76,
    strokeWidth: 1.65,
    contours: [
      stroke(
        'M 70 24 C 55 13 35 20 34 35 C 33 49 66 48 65 65 C 64 81 42 86 27 74',
      ),
      stroke('M 27 78 L 73 20'),
      fill(dot(76, 31, 4.2)),
      fill(dot(24, 69, 4.2)),
    ],
  },

  /** 𝄐 — a long arch with the held moment beneath it. */
  fermata: {
    name: 'fermata',
    glyph: '𝄐',
    label: 'Fermata',
    meaning: 'Hold a note or silence beyond its written duration.',
    artwork: SYMBOL_ARTWORK.fermata,
    aspectRatio: 1.48,
    strokeWidth: 1.55,
    contours: [stroke('M 15 62 C 21 25 79 25 85 62'), fill(dot(50, 56, 5.2))],
  },

  /** ∂ — a looped derivative with an independent upper terminal. */
  partial: {
    name: 'partial-derivative',
    glyph: '∂',
    label: 'Partial derivative',
    meaning: 'Change with respect to one variable while others are fixed.',
    artwork: SYMBOL_ARTWORK.partial,
    aspectRatio: 0.82,
    strokeWidth: 1.7,
    contours: [
      stroke('M 60 13 C 48 9 39 13 37 22 C 52 25 64 38 66 54'),
      stroke(
        'M 66 54 C 67 71 56 84 43 82 C 30 80 27 65 35 54 C 43 43 58 44 66 54',
      ),
    ],
  },

  /** ∇ — three independent sides so it can split and re-form during morphs. */
  nabla: {
    name: 'nabla',
    glyph: '∇',
    label: 'Nabla',
    meaning: 'Gradient, divergence, or curl.',
    artwork: SYMBOL_ARTWORK.nabla,
    aspectRatio: 0.96,
    strokeWidth: 1.6,
    contours: [
      stroke('M 50 82 L 18 23'),
      stroke('M 18 23 L 82 23'),
      stroke('M 82 23 L 50 82'),
    ],
  },

  /** 𝔠 — a blackletter c with curved body and diamond-cut terminals. */
  continuum: {
    name: 'continuum',
    glyph: '𝔠',
    label: 'The continuum',
    meaning: 'The cardinality of the real numbers.',
    artwork: SYMBOL_ARTWORK.continuum,
    aspectRatio: 0.76,
    strokeWidth: 1.55,
    contours: [
      stroke(
        'M 72 28 C 62 17 44 19 34 32 C 22 47 27 68 43 77 C 55 83 68 77 75 67',
      ),
      stroke('M 72 28 L 81 21 L 75 15'),
      stroke('M 58 36 C 47 35 38 42 37 51 C 37 60 44 66 54 66'),
      stroke('M 65 72 L 75 67 L 70 77'),
    ],
  },

  /* ------------------------------------- SVG-backed onboarding additions */

  /** ♪ — an exact Noto Music eighth note, singular and self-contained. */
  eighthNote: {
    name: 'eighth-note',
    glyph: '♪',
    label: 'Eighth note',
    meaning: 'A single musical sound and the smallest seed of a song.',
    artwork: SYMBOL_ARTWORK.eighthNote,
    aspectRatio: 0.56,
    strokeWidth: 1.55,
    contours: SYMBOL_ARTWORK.eighthNote.contours.map(d => fill(d)),
  },

  /** ⇄ — opposite paths over one another; engines remain interchangeable. */
  interchange: {
    name: 'interchange',
    glyph: '⇄',
    label: 'Interchange',
    meaning: 'Movement in either direction between interchangeable systems.',
    artwork: SYMBOL_ARTWORK.interchange,
    aspectRatio: 1.14,
    strokeWidth: 1.55,
    contours: SYMBOL_ARTWORK.interchange.contours.map(d => fill(d)),
  },

  /** ⊛ — one distinct mark held inside a complete boundary. */
  identityMark: {
    name: 'identity-mark',
    glyph: '⊛',
    label: 'Circled asterisk',
    meaning: 'A distinct identity held inside its own boundary.',
    artwork: SYMBOL_ARTWORK.identityMark,
    aspectRatio: 1,
    strokeWidth: 1.55,
    contours: SYMBOL_ARTWORK.identityMark.contours.map(d => fill(d)),
  },

  /** ⟲ — the recovery gesture: follow the phrase back to the beginning. */
  restore: {
    name: 'restore',
    glyph: '⟲',
    label: 'Restore',
    meaning: 'Return to an earlier state and recover what was preserved.',
    artwork: SYMBOL_ARTWORK.restore,
    aspectRatio: 1.12,
    strokeWidth: 1.55,
    contours: SYMBOL_ARTWORK.restore.contours.map(d => fill(d)),
  },
} satisfies Record<string, SymbolPrimitive>;

export type SymbolName = keyof typeof SYMBOL_LIBRARY;
