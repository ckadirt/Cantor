/**
 * One drawn mark per onboarding panel — the visual argument for what the text
 * says, morphed from step to step by SigilMark. Same authoring rules as
 * symbols.ts: thin centerline strokes in a 0..100 box, each a single
 * non-self-crossing contour. A sigil may be several strokes; when two panels
 * differ in stroke count, ribbons split or merge during the morph.
 */
import { SYMBOLS } from './symbols';

export type Sigil = {
  name: string;
  strokes: string[];
};

/** Ribbon thickness in the 0..100 authoring box (scales with the mark). */
export const SIGIL_STROKE = 3.0;

const sym = (name: string): string => {
  const found = SYMBOLS.find(s => s.name === name);
  if (!found) {
    throw new Error(`sigils: no symbol named "${name}"`);
  }
  return found.svg;
};

export const SIGILS = {
  /** ♪ — a song, singular and whole: music that's only yours. */
  what: { name: 'note', strokes: [sym('note')] },
  /**
   * Three strata, widest at the base — the three engines. Middle-thirds
   * widths, so it also reads as a Cantor construction.
   */
  backends: {
    name: 'strata',
    strokes: ['M 16 72 L 84 72', 'M 27 50 L 73 50', 'M 38 28 L 62 28'],
  },
  /** The inward curl — bits wound into words, a signature only you can draw. */
  identity: { name: 'spiral', strokes: [sym('spiral')] },
  /**
   * A square with a slot at the top — the vault the twelve words go into.
   * Open contour on purpose: closed loops stroke into two contours and the
   * morph pipeline samples only one (a closed square renders solid).
   */
  backup: {
    name: 'vault',
    strokes: ['M 42 31 L 31 31 L 31 69 L 69 69 L 69 31 L 58 31'],
  },
  /** ∞ — Cantor's paradise, the threshold into the app. */
  threshold: { name: 'infinity', strokes: [sym('infinity')] },
} satisfies Record<string, Sigil>;
