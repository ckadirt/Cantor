/**
 * The shape primitives — music, math, and figures, authored as thin centerline
 * strokes (plus small fills where ink must be solid: note heads, dots, beams)
 * in a 0..100 box. Rules: one contour per string; strokes may be open or
 * closed; fills must close. validateShape() enforces all of it in dev.
 *
 * Music glyph proportions are eyeballed from engraving practice (SMuFL/Bravura
 * reference): note heads are tilted ellipses, stems leave the head's right
 * side, flags fall away from the stem.
 */
import type { Shape } from './shapes';
import { SYMBOL_LIBRARY } from './symbolLibrary';

const { infinity: canonicalInfinity, ...ADDITIONAL_SYMBOLS } = SYMBOL_LIBRARY;

/** Raw centerline strings shared with the intro's constellation (symbols.ts). */
export const CENTERLINES = {
  // ∫ — integral: a tall S spine curling top-right to bottom-left
  integral: 'M 66 16 C 55 12 51 22 51 34 L 51 66 C 51 78 47 88 35 84',
  // ∿ — a sine wave: two calm humps, math and music at once
  sine: 'M 12 50 C 25 22 38 22 50 50 C 62 78 75 78 88 50',
  // ∞ — lemniscate, drawn as one open pass
  infinity:
    'M 50 50 C 40 33 19 37 21 50 C 23 63 40 67 50 50 C 60 33 81 37 79 50 C 77 63 60 67 50 50',
  // a treble-ish spiral — one continuous inward curl
  spiral:
    'M 58 46 C 49 42 45 50 49 56 C 54 63 65 59 65 49 C 65 36 50 31 39 40 C 26 51 31 72 49 78',
  // ♪ single-stroke eighth note (the intro's tiny constellation version)
  noteStroke:
    'M 33 74 C 25 72 25 82 34 82 C 44 82 43 69 40 65 L 40 24 C 53 28 60 37 57 49',
  // a slur / fermata arc — a safe, calm music mark
  arc: 'M 18 62 C 30 28 70 28 82 62',
} as const;

/** A tilted note-head ellipse (≈ −20°) centred at cx,cy — engraving's oval. */
const noteHead = (cx: number, cy: number): string => {
  const dx = cx - 37;
  const dy = cy - 78;
  const f = (x: number, y: number) =>
    `${(x + dx).toFixed(2)} ${(y + dy).toFixed(2)}`;
  return (
    `M ${f(45.46, 74.92)} ` +
    `C ${f(46.59, 78.03)} ${f(43.72, 81.94)} ${f(39.05, 83.64)} ` +
    `C ${f(34.38, 85.34)} ${f(29.67, 84.19)} ${f(28.54, 81.08)} ` +
    `C ${f(27.41, 77.97)} ${f(30.28, 74.06)} ${f(34.95, 72.36)} ` +
    `C ${f(39.62, 70.66)} ${f(44.33, 71.81)} ${f(45.46, 74.92)} Z`
  );
};

/** A small filled dot (question/exclamation points). */
const dot = (cx: number, cy: number, r: number): string =>
  `M ${cx} ${cy - r} C ${cx + 0.55 * r} ${cy - r} ${cx + r} ${cy - 0.55 * r} ${
    cx + r
  } ${cy} ` +
  `C ${cx + r} ${cy + 0.55 * r} ${cx + 0.55 * r} ${cy + r} ${cx} ${cy + r} ` +
  `C ${cx - 0.55 * r} ${cy + r} ${cx - r} ${cy + 0.55 * r} ${cx - r} ${cy} ` +
  `C ${cx - r} ${cy - 0.55 * r} ${cx - 0.55 * r} ${cy - r} ${cx} ${cy - r} Z`;

const stroke = (d: string) => ({ d, mode: 'stroke' as const });
const fill = (d: string) => ({ d, mode: 'fill' as const });

export const LIBRARY = {
  /* ------------------------------------------------------------------ music */

  /** ♪ — eighth note with a real filled head, stem off its right side, flag. */
  note: {
    name: 'note',
    contours: [
      fill(noteHead(37, 78)),
      stroke('M 45.7 76.3 L 45.7 26'),
      stroke('M 45.7 26 C 55 31 59 40 56 51'),
    ],
  },

  /** ♫ — two eighth notes under one beam. */
  notes: {
    name: 'notes',
    contours: [
      fill(noteHead(31, 77)),
      fill(noteHead(67, 73)),
      fill('M 39.7 27 L 75.7 22 L 75.7 29 L 39.7 34 Z'),
      stroke('M 39.7 75.3 L 39.7 30'),
      stroke('M 75.7 71.3 L 75.7 26'),
    ],
  },

  arc: { name: 'arc', contours: [stroke(CENTERLINES.arc)] },
  sine: { name: 'sine', contours: [stroke(CENTERLINES.sine)] },

  /** an audio waveform — quiet, spike, quiet. */
  waveform: {
    name: 'waveform',
    contours: [
      stroke(
        'M 18 50 L 28 50 L 34 36 L 42 64 L 50 28 L 58 70 L 64 44 L 72 56 L 82 50',
      ),
    ],
  },

  /** ♯ */
  sharp: {
    name: 'sharp',
    contours: [
      stroke('M 43 26 L 39 74'),
      stroke('M 61 26 L 57 74'),
      stroke('M 33 45 L 69 41'),
      stroke('M 31 59 L 67 55'),
    ],
  },

  /** ♭ */
  flat: {
    name: 'flat',
    contours: [
      stroke('M 41 20 L 41 76'),
      stroke('M 41 50 C 60 42 63 58 41 76'),
    ],
  },

  /* ------------------------------------------------------------------- math */

  integral: { name: 'integral', contours: [stroke(CENTERLINES.integral)] },
  infinity: canonicalInfinity,
  spiral: { name: 'spiral', contours: [stroke(CENTERLINES.spiral)] },

  /** ℵ — Cantor's own letter. Diagonal spine, two arms reaching its middle. */
  aleph: {
    name: 'aleph',
    contours: [
      stroke('M 30 25 L 70 75'),
      stroke('M 72 27 C 73 41 65 49 53 51'),
      stroke('M 28 73 C 27 59 35 51 47 49'),
    ],
  },

  /** Σ */
  sum: {
    name: 'sum',
    contours: [stroke('M 68 32 L 34 32 L 56 50 L 34 68 L 68 68')],
  },

  /** √ */
  root: {
    name: 'root',
    contours: [stroke('M 24 56 L 33 53 L 43 74 L 59 26 L 80 26')],
  },

  plus: {
    name: 'plus',
    contours: [stroke('M 50 26 L 50 74'), stroke('M 26 50 L 74 50')],
  },

  minus: { name: 'minus', contours: [stroke('M 24 50 L 76 50')] },

  /** × */
  cross: {
    name: 'cross',
    contours: [stroke('M 30 30 L 70 70'), stroke('M 70 30 L 30 70')],
  },

  equals: {
    name: 'equals',
    contours: [stroke('M 28 42 L 72 42'), stroke('M 28 58 L 72 58')],
  },

  asterisk: {
    name: 'asterisk',
    contours: [
      stroke('M 50 28 L 50 72'),
      stroke('M 31 39 L 69 61'),
      stroke('M 69 39 L 31 61'),
    ],
  },

  /* ------------------------------------------------------------ expressions */

  question: {
    name: 'question',
    contours: [
      stroke('M 37 35 C 37 21 63 21 63 35 C 63 45 50 46 50 57'),
      fill(dot(50, 71, 3.5)),
    ],
  },

  exclaim: {
    name: 'exclaim',
    contours: [stroke('M 50 24 L 50 56'), fill(dot(50, 71, 3.5))],
  },

  /* ---------------------------------------------------------------- figures */

  circle: {
    name: 'circle',
    contours: [
      stroke(
        'M 50 18 C 67.67 18 82 32.33 82 50 C 82 67.67 67.67 82 50 82 ' +
          'C 32.33 82 18 67.67 18 50 C 18 32.33 32.33 18 50 18 Z',
      ),
    ],
  },

  square: {
    name: 'square',
    contours: [stroke('M 26 26 L 74 26 L 74 74 L 26 74 Z')],
  },

  triangle: {
    name: 'triangle',
    contours: [stroke('M 50 24 L 78 72 L 22 72 Z')],
  },

  diamond: {
    name: 'diamond',
    contours: [stroke('M 50 20 L 79 50 L 50 80 L 21 50 Z')],
  },

  star: {
    name: 'star',
    contours: [
      stroke(
        'M 50 22 L 57.5 41.7 L 78.5 42.7 L 62.1 55.9 L 67.6 76.3 L 50 64.7 ' +
          'L 32.4 76.3 L 37.9 55.9 L 21.5 42.7 L 42.5 41.7 Z',
      ),
    ],
  },

  /* ------------------------------------------------- the onboarding sigils */

  /** Three strata, widest at the base — middle-thirds widths; the engines. */
  strata: {
    name: 'strata',
    contours: [
      stroke('M 16 72 L 84 72'),
      stroke('M 27 50 L 73 50'),
      stroke('M 38 28 L 62 28'),
    ],
  },

  /** A square with a slot at the top — the vault the words go into. */
  vault: {
    name: 'vault',
    contours: [stroke('M 42 31 L 31 31 L 31 69 L 69 69 L 69 31 L 58 31')],
  },

  /* ------------------------------------------ canonical reusable symbols */

  ...ADDITIONAL_SYMBOLS,
} satisfies Record<string, Shape>;

export type LibraryName = keyof typeof LIBRARY;
