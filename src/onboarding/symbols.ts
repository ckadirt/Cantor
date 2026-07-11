/**
 * The marks the Cantor bars morph into as they disperse to the borders — a
 * quiet constellation of math and music glyphs. Each is a single closed contour
 * authored in a 0..100 box (so the morph correspondence is clean) and kept
 * inside the design's rounded-bar / minimal vocabulary. Add richer glyphs (∫ Σ
 * 𝄞 …) here as SVG strings; the pipeline resamples whatever it's given.
 */

export type Symbol = {
  name: string;
  svg: string;
  /** Whether a random rotation reads well on this mark. */
  spin: boolean;
};

export const SYMBOLS: Symbol[] = [
  // a rounded bar — the primitive itself, rotated becomes a "stroke"
  {
    name: 'bar',
    spin: true,
    svg:
      'M 22 42 H 78 A 8 8 0 0 1 78 58 H 22 A 8 8 0 0 1 22 42 Z',
  },
  // filled dot — a note head / a point
  {
    name: 'dot',
    spin: false,
    svg: 'M 50 22 A 28 28 0 1 0 49.99 22 Z',
  },
  // plus — math; a random spin turns it into ×
  {
    name: 'plus',
    spin: true,
    svg:
      'M 42 18 H 58 V 42 H 82 V 58 H 58 V 82 H 42 V 58 H 18 V 42 H 42 Z',
  },
  // play triangle — music / the player
  {
    name: 'play',
    spin: false,
    svg: 'M 30 20 L 82 50 L 30 80 Z',
  },
  // quarter note — stem + head as one contour
  {
    name: 'note',
    spin: false,
    svg: 'M 45 24 L 53 24 L 53 62 A 15 13 0 1 1 45 56 Z',
  },
];
