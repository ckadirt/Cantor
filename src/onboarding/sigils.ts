/**
 * One drawn mark per onboarding panel — the visual argument for what the text
 * says. Every selection comes from the canonical SVG-backed symbol library,
 * so settled marks use the exact STIX Math / Noto Music compound artwork.
 */
import { SYMBOL_LIBRARY, type SymbolPrimitive } from '../motion';

export const SIGILS = {
  /** ♪ — a song, singular and whole: music that's only yours. */
  what: SYMBOL_LIBRARY.eighthNote,
  /** ⇄ — the generation engine can move between interchangeable backends. */
  backends: SYMBOL_LIBRARY.interchange,
  /** ⊛ — one distinct identity held inside its own boundary. */
  identity: SYMBOL_LIBRARY.identityMark,
  /** ⟲ — the recovery phrase brings an identity back. */
  backup: SYMBOL_LIBRARY.restore,
  /** ∞ — Cantor's paradise, the threshold into the app. */
  threshold: SYMBOL_LIBRARY.infinity,
} satisfies Record<string, SymbolPrimitive>;
