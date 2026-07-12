/**
 * One drawn mark per onboarding panel — the visual argument for what the text
 * says. All live in the motion library now; the frame morphs between them with
 * MorphShape (splits, merges, and the note's filled head included).
 */
import { LIBRARY } from '../motion';
import type { Shape } from '../motion';

export const SIGILS: Record<string, Shape> = {
  /** ♪ — a song, singular and whole: music that's only yours. */
  what: LIBRARY.note,
  /** Three strata, widest at the base — the three engines; also a Cantor cut. */
  backends: LIBRARY.strata,
  /** The inward curl — bits wound into words, a signature only you can draw. */
  identity: LIBRARY.spiral,
  /** The vault the twelve words go into. */
  backup: LIBRARY.vault,
  /** ∞ — Cantor's paradise, the threshold into the app. */
  threshold: LIBRARY.infinity,
};
