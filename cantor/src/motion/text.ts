/**
 * Text as geometry: synchronous glyph layout (no onLayout roundtrips — the
 * font's metrics ARE the layout) and the policies that turn one laid-out text
 * object into another.
 *
 * The policy is hierarchical, manim-style:
 *   1. whole words present in both lines glide as units (much calmer than
 *      letters scattering individually);
 *   2. leftover characters match by identity + nearest relative position —
 *      but a match that would fly farther than MAX_FLIGHT_FRAC of the line
 *      width is rejected (long coincidental flights read as alphabet soup);
 *   3. everything still unmatched pairs up in reading order and SHAPE-MORPHS —
 *      the old glyph's outline bends into the new one's (glyphs.ts), which is
 *      the TransformMatchingShapes gesture that makes manim text feel alive.
 *      Only a count imbalance leaves true exits/entrances.
 *
 * `buildFlights` preserves the expressive TransformMatchingShapes variant.
 * `buildTransformFlights` mirrors a plain manim Transform: align the source
 * and target families by reading order, then move every pair over the same
 * clock window. Neither policy leaks into layout or rendering.
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
/** Default runtime for text transforms/crossfades, in milliseconds. */
export const DEFAULT_TEXT_TRANSFORM_MS = 700;

/* ---------------------------------------------------------- Manim Write knobs */
/** ManimGL draws each glyph border during the first half, then fills it. */
export const WRITE_BORDER_PORTION = 0.5;
/** ManimGL's maximum lag_ratio between adjacent glyph submobjects. */
export const WRITE_MAX_LAG = 0.2;
/** ManimGL budgets four lag units across a text object's family. */
export const WRITE_LAG_BUDGET = 4;
/** ManimGL switches its automatic Write duration at 15 drawn family members. */
export const WRITE_LONG_TEXT_AT = 15;
export const WRITE_SHORT_MS = 1000;
export const WRITE_LONG_MS = 2000;
/** Thin outline used while a glyph is being written, in physical pixels. */
export const WRITE_STROKE_PX = 1.25;

export type TextMotionVariant = 'transform' | 'matching' | 'crossfade';
export type TextAppearance = 'write' | 'fade' | 'none';

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

/** An unmatched pair whose glyph outlines shape-morph into each other. */
export type MorphPair = {
  from: CharBox;
  to: CharBox;
  px: number;
  py: number;
  a: number;
  b: number;
  /** Invisible family copies reproduce Manim's unequal-length alignment. */
  fromAlpha?: number;
  toAlpha?: number;
};

export type Flights = {
  movers: Mover[];
  morphs: MorphPair[];
  exits: CharBox[];
  enters: CharBox[];
};

export type WritePhase = {
  borderEnd: number;
  borderAlpha: number;
  fillAlpha: number;
  settled: boolean;
};

/** ManimGL's automatic Write lag ratio. */
export function writeLagRatio(glyphCount: number): number {
  return glyphCount <= 0
    ? 0
    : Math.min(WRITE_LAG_BUDGET / (glyphCount + 1), WRITE_MAX_LAG);
}

/** Per-glyph alpha on the shared Write clock; identical to Animation.get_sub_alpha. */
export function writeSubAlpha(t: number, index: number, glyphCount: number): number {
  'worklet';
  if (glyphCount <= 0) {
    return 1;
  }
  const lag = Math.min(WRITE_LAG_BUDGET / (glyphCount + 1), WRITE_MAX_LAG);
  const fullLength = (glyphCount - 1) * lag + 1;
  return Math.min(1, Math.max(0, t * fullLength - index * lag));
}

/** DrawBorderThenFill's two phases for one glyph. */
export function writePhase(alpha: number): WritePhase {
  'worklet';
  const t = Math.min(1, Math.max(0, alpha));
  if (t < WRITE_BORDER_PORTION) {
    return {
      borderEnd: t / WRITE_BORDER_PORTION,
      borderAlpha: 1,
      fillAlpha: 0,
      settled: false,
    };
  }
  const fill = (t - WRITE_BORDER_PORTION) / (1 - WRITE_BORDER_PORTION);
  return {
    borderEnd: 1,
    borderAlpha: 1 - fill,
    fillAlpha: fill,
    settled: fill >= 1,
  };
}

/** ManimGL's automatic 1 s / 2 s Write runtime rule, expressed in ms. */
export function writeDurationMs(glyphCount: number): number {
  return glyphCount < WRITE_LONG_TEXT_AT ? WRITE_SHORT_MS : WRITE_LONG_MS;
}

/* ------------------------------------------------------------- segmentation */

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

// Hermes ships without Intl.Segmenter (the RN tsconfig lib predates its
// types); probe for it once and keep the code-point fallback.
const graphemeSegmenter: GraphemeSegmenter | null = (() => {
  const Ctor = (
    Intl as {
      Segmenter?: new (
        locales?: string,
        options?: { granularity: 'grapheme' },
      ) => GraphemeSegmenter;
    }
  ).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

/**
 * Split text into user-perceived characters. é (e + combining accent), emoji,
 * and ZWJ families stay whole, so each lays out and animates as one CharBox
 * instead of shattering into marks. Where Intl.Segmenter is unavailable
 * (older Hermes) this degrades to code points, which is correct for the
 * Latin-plus-punctuation copy the app ships.
 */
export function graphemes(text: string): string[] {
  if (graphemeSegmenter) {
    const out: string[] = [];
    for (const { segment } of graphemeSegmenter.segment(text)) {
      out.push(segment);
    }
    return out;
  }
  return [...text];
}

/**
 * Word-wrap `text` against the font's real metrics. Baseline coordinates.
 * `\n` forces a line break; a word wider than maxWidth breaks mid-word
 * instead of overflowing; characters are grapheme clusters, not code points.
 */
export function layoutText(
  text: string,
  font: SkFont,
  letterSpacing: number,
  maxWidth: number,
  lineHeight: number,
  align: 'left' | 'center' = 'left',
): CharBox[] {
  if (text.length === 0) {
    return [];
  }
  const ascent = -font.getMetrics().ascent;
  const spaceIds = font.getGlyphIDs(' ');
  const spaceW = font.getGlyphWidths(spaceIds)[0] + letterSpacing;

  const measure = (ch: string) => {
    const ids = font.getGlyphIDs(ch);
    const widths = font.getGlyphWidths(ids);
    const xo: number[] = [];
    let acc = 0;
    for (const w of widths) {
      xo.push(acc);
      acc += w;
    }
    return { ch, ids, xo, w: acc + letterSpacing };
  };

  const boxes: CharBox[] = [];
  let pen = 0;
  let line = 0;
  let wi = 0;
  text.split('\n').forEach((row, ri) => {
    if (ri > 0) {
      pen = 0;
      line++;
      wi++; // words never merge across a forced break
    }
    for (const word of row.split(' ')) {
      wi++;
      if (word.length === 0) {
        continue;
      }
      const chars = graphemes(word).map(measure);
      const wordW = chars.reduce((s, c) => s + c.w, 0);
      if (pen > 0 && pen + wordW > maxWidth) {
        pen = 0;
        line++;
      }
      for (const c of chars) {
        // an over-wide word breaks mid-word rather than overflowing the line
        if (pen > 0 && pen + c.w > maxWidth) {
          pen = 0;
          line++;
        }
        boxes.push({ ...c, x: pen, y: ascent + line * lineHeight, word: wi });
        pen += c.w;
      }
      pen += spaceW;
    }
  });
  if (align === 'center') {
    // Shift each baseline row so its ink centres inside maxWidth. Every box
    // carries one trailing letterSpacing; the last one is not visible ink.
    const rows = new Map<number, CharBox[]>();
    for (const box of boxes) {
      const row = rows.get(box.y);
      if (row) {
        row.push(box);
      } else {
        rows.set(box.y, [box]);
      }
    }
    for (const row of rows.values()) {
      const last = row[row.length - 1];
      const rowWidth = last.x + last.w - letterSpacing;
      const dx = Math.max(0, (maxWidth - rowWidth) / 2);
      for (const box of row) {
        box.x += dx;
      }
    }
  }
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

  // 3 — whatever identity couldn't match pairs up in reading order and
  // shape-morphs: the old glyph bends into the new one where it stands.
  const byReading = (a: CharBox, b: CharBox) => a.y - b.y || a.x - b.x;
  const leftPrev = prev.filter(b => !usedPrev.has(b)).sort(byReading);
  const leftNext = next.filter(b => !usedNext.has(b)).sort(byReading);
  const morphPairs: { from: CharBox; to: CharBox }[] = [];
  const k = Math.min(leftPrev.length, leftNext.length);
  if (k > 0) {
    // spread the larger side evenly over the smaller; extremes always pair
    const pickFrom = leftPrev.length >= leftNext.length;
    for (let j = 0; j < k; j++) {
      const spread = (n: number) => (k > 1 ? Math.round((j * (n - 1)) / (k - 1)) : 0);
      const from = pickFrom ? leftPrev[spread(leftPrev.length)] : leftPrev[j];
      const to = pickFrom ? leftNext[j] : leftNext[spread(leftNext.length)];
      usedPrev.add(from);
      usedNext.add(to);
      morphPairs.push({ from, to });
    }
  }

  // One cascade for flights and shape-morphs alike, in destination reading
  // order, each with the same arc math.
  type Kinded = { from: CharBox; to: CharBox; morph: boolean };
  const all: Kinded[] = [
    ...pairs.map(p => ({ ...p, morph: false })),
    ...morphPairs.map(p => ({ ...p, morph: true })),
  ].sort((p, q) => byReading(p.to, q.to));
  const span = MOVE_END - MOVE_START;
  const lag = span * MOVER_LAG;
  const movers: Mover[] = [];
  const morphs: MorphPair[] = [];
  all.forEach(({ from, to, morph }, i) => {
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
    const a = MOVE_START + (all.length > 1 ? (lag * i) / (all.length - 1) : 0);
    const b = a + span - lag;
    if (morph) {
      morphs.push({ from, to, px, py, a, b });
    } else {
      movers.push({
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
        b,
      });
    }
  });

  return {
    movers,
    morphs,
    exits: prev.filter(b => !usedPrev.has(b)),
    enters: next.filter(b => !usedNext.has(b)),
  };
}

type AlignedBox = { box: CharBox; alpha: number };

/**
 * Expand a text family the way Manim's Mobject.add_n_more_submobjects does:
 * preserve reading order, distribute repeats evenly, and make only the first
 * copy of each repeated glyph visible. The invisible copies provide geometry
 * for characters that exist on only one side of an unequal-length Transform.
 */
function alignFamily(boxes: CharBox[], targetLength: number): AlignedBox[] {
  if (boxes.length === 0 || targetLength === 0) {
    return [];
  }
  if (boxes.length === targetLength) {
    return boxes.map(box => ({ box, alpha: 1 }));
  }
  const seen = new Set<number>();
  return Array.from({ length: targetLength }, (_, i) => {
    const sourceIndex = Math.floor((i * boxes.length) / targetLength);
    const alpha = seen.has(sourceIndex) ? 0 : 1;
    seen.add(sourceIndex);
    return { box: boxes[sourceIndex], alpha };
  });
}

/**
 * Plain Manim Transform for text.
 *
 * Unlike buildFlights, this does no identity matching, no word matching, no
 * arcs, and no cascade. Glyph families align by reading order (with invisible
 * copies on the shorter side) and every outline interpolates on [0, 1]. That
 * shared alpha is what makes the line read as one coordinated object.
 */
export function buildTransformFlights(prev: CharBox[], next: CharBox[]): Flights {
  if (prev.length === 0 || next.length === 0) {
    return { movers: [], morphs: [], exits: prev, enters: next };
  }
  const count = Math.max(prev.length, next.length);
  const from = alignFamily(prev, count);
  const to = alignFamily(next, count);
  return {
    movers: [],
    morphs: from.map((source, i) => ({
      from: source.box,
      to: to[i].box,
      px: 0,
      py: 0,
      a: 0,
      b: 1,
      fromAlpha: source.alpha,
      toAlpha: to[i].alpha,
    })),
    exits: [],
    enters: [],
  };
}

/** Simultaneous whole-object crossfade, also used for reduced motion. */
export function buildCrossfadeFlights(prev: CharBox[], next: CharBox[]): Flights {
  return { movers: [], morphs: [], exits: prev, enters: next };
}
