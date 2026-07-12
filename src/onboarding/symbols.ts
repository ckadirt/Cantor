/**
 * The marks the Cantor bars morph into as they disperse to the borders — a
 * quiet constellation of math and music glyphs. Centerline strings live in the
 * motion library (shared with the engine's shapes); the intro thickens them
 * into ribbons (ribbonOutline) because a solid bar can only morph into another
 * filled outline.
 */
import { CENTERLINES } from '../motion';

export type Symbol = {
  name: string;
  svg: string;
};

/** Ribbon thickness, in the 0..100 authoring box. Scales down with the mark. */
export const STROKE = 4.2;

export const SYMBOLS: Symbol[] = [
  { name: 'integral', svg: CENTERLINES.integral },
  { name: 'sine', svg: CENTERLINES.sine },
  { name: 'infinity', svg: CENTERLINES.infinity },
  { name: 'spiral', svg: CENTERLINES.spiral },
  { name: 'note', svg: CENTERLINES.noteStroke },
  { name: 'arc', svg: CENTERLINES.arc },
];
