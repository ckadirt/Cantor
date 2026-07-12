/**
 * Text as geometry: synchronous glyph layout (no onLayout roundtrips — the
 * font's metrics ARE the layout) and the matching policy that turns an old
 * line into flights toward a new one.
 *
 * The policy is hierarchical, manim-style:
 *   1. whole words present in both lines glide as units (much calmer than
 *      letters scattering individually);
 *   2. leftover characters match by identity + nearest relative position;
 *   3. any char match that would fly farther than MAX_FLIGHT_FRAC of the line
 *      width is demoted to exit+enter — long coincidental flights are what
 *      reads as alphabet soup.
 *
 * Every constant here is a taste lever; scrub them in MotionLab.
 */
import type { SkFont } from '@shopify/react-native-skia';

/* ------------------------------------------------ windows on the 0..1 clock */
export const EXIT_END = 0.35; // exits are gone by here
export const MOVE_START = 0.08;
export const MOVE_END = 0.92;
export const ENTER_START = 0.62; // entrances land after the movers pass
export const MOVER_LAG = 0.3; // fraction of the move window spent cascading
export const ARC_RATIO = 0.16; // flight bulge as a fraction of distance…
export const ARC_MAX = 22; // …capped, in dp
export const EXIT_RISE = 8; // exits drift up while fading (dp)
export const ENTER_RISE = 10; // entrances rise into place (dp)
export const MOVER_DIP = 0.15; // movers dim slightly mid-flight
export const MAX_FLIGHT_FRAC = 0.55; // longer would-be flights become exit+enter

/** A laid-out character: glyph ids + offsets, pen origin at the baseline. */
export type CharBox = {
  ch: string;
  ids: number[];
  xo: number[]; // per-id x offset inside the char
  w: number;
  x: number;
  y: number;
  word: number;
};

/** A matched character in flight, with its precomputed lag window and arc. */
export type Mover = {
  box: CharBox; // the destination box (next capture's home)
  ids: number[];
  xo: number[];
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  px: number; // perpendicular arc offset, applied as 4m(1−m)
  py: number;
  a: number; // this mover's eased window on the clock
  b: number;
};

export type Flights = {
  movers: Mover[];
  exits: CharBox[];
  enters: CharBox[];
};

/** Word-wrap `text` against the font's real metrics. Baseline coordinates. */
export function layoutText(
  text: string,
  font: SkFont,
  letterSpacing: number,
  maxWidth: number,
  lineHeight: number,
): CharBox[] {
  if (text.length === 0) {
    return [];
  }
  const ascent = -font.getMetrics().ascent;
  const spaceIds = font.getGlyphIDs(' ');
  const spaceW = font.getGlyphWidths(spaceIds)[0] + letterSpacing;

  const boxes: CharBox[] = [];
  let pen = 0;
  let line = 0;
  text.split(' ').forEach((word, wi) => {
    if (word.length === 0) {
      return;
    }
    const chars = [...word].map(ch => {
      const ids = font.getGlyphIDs(ch);
      const widths = font.getGlyphWidths(ids);
      const xo: number[] = [];
      let acc = 0;
      for (const w of widths) {
        xo.push(acc);
        acc += w;
      }
      return { ch, ids, xo, w: acc + letterSpacing };
    });
    const wordW = chars.reduce((s, c) => s + c.w, 0);
    if (pen > 0 && pen + wordW > maxWidth) {
      pen = 0;
      line++;
    }
    for (const c of chars) {
      boxes.push({ ...c, x: pen, y: ascent + line * lineHeight, word: wi });
      pen += c.w;
    }
    pen += spaceW;
  });
  return boxes;
}

type WordGroup = { text: string; boxes: CharBox[]; rel: number };

function wordGroups(boxes: CharBox[]): WordGroup[] {
  const map = new Map<number, CharBox[]>();
  for (const b of boxes) {
    const g = map.get(b.word);
    if (g) {
      g.push(b);
    } else {
      map.set(b.word, [b]);
    }
  }
  const groups = [...map.values()];
  const n = Math.max(1, groups.length - 1);
  return groups.map((g, i) => ({
    text: g.map(b => b.ch).join(''),
    boxes: g,
    rel: i / n,
  }));
}

/** Match old boxes to new ones; produce movers, exits, and entrances. */
export function buildFlights(
  prev: CharBox[],
  next: CharBox[],
  maxWidth: number,
): Flights {
  const usedPrev = new Set<CharBox>();
  const usedNext = new Set<CharBox>();
  const pairs: { from: CharBox; to: CharBox }[] = [];

  // 1 — whole words glide as units.
  const pg = wordGroups(prev);
  wordGroups(next).forEach(ng => {
    let best: WordGroup | null = null;
    for (const og of pg) {
      if (og.text !== ng.text || og.boxes.some(b => usedPrev.has(b))) {
        continue;
      }
      if (!best || Math.abs(og.rel - ng.rel) < Math.abs(best.rel - ng.rel)) {
        best = og;
      }
    }
    if (best) {
      best.boxes.forEach((from, i) => {
        usedPrev.add(from);
        usedNext.add(ng.boxes[i]);
        pairs.push({ from, to: ng.boxes[i] });
      });
    }
  });

  // 2 — leftover characters, by identity + nearest relative position.
  const restPrev = prev.filter(b => !usedPrev.has(b));
  const restNext = next.filter(b => !usedNext.has(b));
  const pn = Math.max(1, restPrev.length - 1);
  const nn = Math.max(1, restNext.length - 1);
  restNext.forEach((nb, j) => {
    let best = -1;
    let bestD = Infinity;
    restPrev.forEach((pb, i) => {
      if (usedPrev.has(pb) || pb.ch !== nb.ch) {
        return;
      }
      const d = Math.abs(i / pn - j / nn);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      const from = restPrev[best];
      // 3 — too far to fly gracefully: demote to exit + enter.
      if (Math.hypot(nb.x - from.x, nb.y - from.y) <= MAX_FLIGHT_FRAC * maxWidth) {
        usedPrev.add(from);
        usedNext.add(nb);
        pairs.push({ from, to: nb });
      }
    }
  });

  // Movers cascade in reading order of their destinations.
  pairs.sort((p, q) => p.to.y - q.to.y || p.to.x - q.to.x);
  const span = MOVE_END - MOVE_START;
  const lag = span * MOVER_LAG;
  const movers = pairs.map(({ from, to }, i): Mover => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    // perpendicular bulge, biased upward so the line breathes as one gesture
    let px = 0;
    let py = 0;
    if (d > 1) {
      const amp = Math.min(ARC_MAX, ARC_RATIO * d);
      px = (-dy / d) * amp;
      py = (dx / d) * amp;
      if (py > 0) {
        px = -px;
        py = -py;
      }
    }
    const a = MOVE_START + (pairs.length > 1 ? (lag * i) / (pairs.length - 1) : 0);
    return {
      box: to,
      ids: to.ids,
      xo: to.xo,
      fx: from.x,
      fy: from.y,
      tx: to.x,
      ty: to.y,
      px,
      py,
      a,
      b: a + span - lag,
    };
  });

  return {
    movers,
    exits: prev.filter(b => !usedPrev.has(b)),
    enters: next.filter(b => !usedNext.has(b)),
  };
}
