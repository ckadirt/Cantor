/**
 * The marks the Cantor bars morph into as they disperse to the borders — a
 * quiet constellation of math and music glyphs. Each is a single flowing
 * *centerline* stroke authored in a 0..100 box (cubic béziers, no chunky
 * fills); morph.ts thickens it into a thin ribbon (Path.stroke) before
 * resampling, so the marks read fine and delicate. Keep them single, mostly
 * non-self-crossing strokes — the morph samples one contour.
 */

export type Symbol = {
  name: string;
  svg: string;
};

/** Ribbon thickness, in the 0..100 authoring box. Scales down with the mark. */
export const STROKE = 4.2;

export const SYMBOLS: Symbol[] = [
  // ∫ — integral: a tall S spine curling top-right to bottom-left
  {
    name: 'integral',
    svg: 'M 66 16 C 55 12 51 22 51 34 L 51 66 C 51 78 47 88 35 84',
  },
  // ∿ — a sine wave: two calm humps, math and music at once
  {
    name: 'sine',
    svg: 'M 12 50 C 25 22 38 22 50 50 C 62 78 75 78 88 50',
  },
  // ∞ — lemniscate, drawn as one open pass
  {
    name: 'infinity',
    svg:
      'M 50 50 C 40 33 19 37 21 50 C 23 63 40 67 50 50 C 60 33 81 37 79 50 C 77 63 60 67 50 50',
  },
  // a treble-ish spiral — one continuous inward curl
  {
    name: 'spiral',
    svg:
      'M 58 46 C 49 42 45 50 49 56 C 54 63 65 59 65 49 C 65 36 50 31 39 40 C 26 51 31 72 49 78',
  },
  // ♪ — an eighth note as a single stroke: head loop, stem, flag
  {
    name: 'note',
    svg:
      'M 33 74 C 25 72 25 82 34 82 C 44 82 43 69 40 65 L 40 24 C 53 28 60 37 57 49',
  },
  // a slur / fermata arc — a safe, calm music mark
  {
    name: 'arc',
    svg: 'M 18 62 C 30 28 70 28 82 62',
  },
];
